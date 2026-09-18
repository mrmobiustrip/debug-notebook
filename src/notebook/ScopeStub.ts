import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { SessionRegistry, SessionState } from '../session/SessionRegistry';
import type { TargetResolver, NotebookPin } from '../session/TargetResolver';
import { scopes, variables } from '../session/Dap';
import type { ProfileRegistry } from '../profiles';
import type { ScopeVariable } from '../profiles/LanguageProfile';

export const STUB_KEY = 'debugNotebook';

export function isStubCell(cell: { metadata: Readonly<Record<string, unknown>> }): boolean {
  return (cell.metadata?.[STUB_KEY] as { stub?: boolean } | undefined)?.stub === true;
}

const MAX_NAMES = 400;
const SKIP_SCOPES = /^(global|globals)$/i;

/**
 * Language servers analyse notebook cells in document order as one module, so
 * a first cell that declares the paused frame's names (with types where the
 * adapter reports them) stops "undefined name" diagnostics and feeds static
 * completions. The cell is collapsed, never executed and never serialised.
 */
export class ScopeStubUpdater implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly lastText = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    registry: SessionRegistry,
    private readonly resolver: TargetResolver,
    private readonly profiles: ProfileRegistry,
    private readonly notebooksFor: (state: SessionState) => vscode.NotebookDocument[],
    private readonly enabled: () => boolean,
    private readonly debounceMs = 150,
  ) {
    this.disposables.push(
      registry.onDidChange((state) => this.schedule(state)),
      vscode.debug.onDidChangeActiveStackItem((item) => {
        const state = item ? registry.get(item.session) : undefined;
        if (state) {
          this.schedule(state);
        }
      }),
      vscode.workspace.onDidOpenNotebookDocument((doc) => {
        const session = vscode.debug.activeDebugSession;
        const state = session ? registry.get(session) : undefined;
        if (state && this.notebooksFor(state).includes(doc)) {
          this.schedule(state);
        }
      }),
    );
  }

  private schedule(state: SessionState): void {
    if (!this.enabled() || state.terminated || state.anyStoppedThread() === undefined) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.chain = this.chain.then(() => this.refresh(state)).catch(() => undefined);
    }, this.debounceMs);
  }

  async refresh(state: SessionState): Promise<void> {
    const notebooks = this.notebooksFor(state);
    if (!notebooks.length) {
      return;
    }
    const profile = this.profiles.for(state.session);
    if (!profile.scopeStub) {
      return;
    }
    for (const notebook of notebooks) {
      try {
        const pin = notebook.metadata?.debugNotebook as NotebookPin | undefined;
        const target = await this.resolver.resolve(pin);
        if (target.session.id !== state.session.id) {
          continue;
        }
        const vars = await this.collect(target.session, target.frameId);
        const text = profile.scopeStub(vars, target.location);
        await this.apply(notebook, text, profile.cellLanguage(target.session));
      } catch {
        // Running, resolving failed, or the notebook closed: leave the stub as is.
      }
    }
  }

  private async collect(session: vscode.DebugSession, frameId: number): Promise<ScopeVariable[]> {
    const body = await scopes(session, { frameId });
    const seen = new Set<string>();
    const out: ScopeVariable[] = [];
    for (const scope of body.scopes ?? []) {
      if (scope.expensive || SKIP_SCOPES.test(scope.name)) {
        continue;
      }
      const vars = await variables(session, { variablesReference: scope.variablesReference });
      for (const v of vars.variables ?? []) {
        if (out.length >= MAX_NAMES) {
          return out;
        }
        if (!isIdentifier(v.name) || seen.has(v.name)) {
          continue;
        }
        seen.add(v.name);
        out.push({ name: v.name, type: v.type, scope: scope.name });
      }
    }
    return out;
  }

  private async apply(notebook: vscode.NotebookDocument, text: string, language: string): Promise<void> {
    const key = notebook.uri.toString();
    const existing = notebook.getCells().find(isStubCell);
    if (existing && existing.document.getText() === text) {
      return;
    }
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, text, language);
    cell.metadata = { [STUB_KEY]: { stub: true }, inputCollapsed: true };
    const edit = new vscode.WorkspaceEdit();
    // Replace the whole cell rather than its text: a text edit on a cell
    // document is unreliable across notebook implementations, a cell
    // replacement is not.
    edit.set(notebook.uri, [
      existing
        ? vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(existing.index, existing.index + 1), [cell])
        : vscode.NotebookEdit.insertCells(0, [cell]),
    ]);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) {
      this.lastText.set(key, text);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

export type { DebugProtocol };
