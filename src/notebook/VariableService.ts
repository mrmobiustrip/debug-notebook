import * as vscode from 'vscode';
import type { SessionRegistry } from '../session/SessionRegistry';
import { variables } from '../session/Dap';
import { RENDERER_ID, ToExtension, ToRenderer, VariablesRequest, VariablesResponse } from '../renderer/protocol';

/** Minimal messaging surface; injectable for tests. */
export interface RendererMessaging {
  onDidReceiveMessage(listener: (e: { editor: vscode.NotebookEditor; message: unknown }) => void): vscode.Disposable;
  postMessage(message: unknown, editor?: vscode.NotebookEditor): Thenable<boolean>;
}

/**
 * Extension-host side of the variable tree: answers lazy `variables` requests
 * from the renderer and tells open trees when their handles went invalid.
 * DAP variable references are only valid until the debuggee resumes, so every
 * request is checked against the session's current stopSeq.
 */
export class VariableService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly registry: SessionRegistry,
    private readonly messaging: RendererMessaging = vscode.notebooks.createRendererMessaging(RENDERER_ID),
  ) {
    this.disposables.push(
      messaging.onDidReceiveMessage(({ editor, message }) => void this.handle(editor, message as ToExtension)),
      registry.onDidChange((state) => {
        const msg: ToRenderer = { type: 'invalidate', sessionId: state.runId, stopSeq: state.stopSeq, gone: state.terminated };
        void this.messaging.postMessage(msg);
      }),
      registry.onDidRemove((id) => {
        const msg: ToRenderer = { type: 'invalidate', sessionId: id, stopSeq: -1, gone: true };
        void this.messaging.postMessage(msg);
      }),
    );
  }

  async handle(editor: vscode.NotebookEditor, message: ToExtension): Promise<void> {
    if (!message || message.type !== 'variables') {
      return;
    }
    const response = await this.answer(message);
    await this.messaging.postMessage(response, editor);
  }

  async answer(req: VariablesRequest): Promise<VariablesResponse> {
    const base = { type: 'variables' as const, requestId: req.requestId };
    const state = this.registry.get(req.sessionId);
    if (!state || state.terminated) {
      return { ...base, ok: false, reason: 'gone' };
    }
    if (state.stopSeq !== req.stopSeq) {
      return { ...base, ok: false, reason: 'stale' };
    }
    if (state.anyStoppedThread() === undefined) {
      return { ...base, ok: false, reason: 'running' };
    }
    try {
      // VS Code advertises supportsVariablePaging, so adapters may honour
      // start/count. Ones that ignore it return everything; slice client-side.
      const body = await variables(state.session, {
        variablesReference: req.variablesReference,
        ...(req.start !== undefined ? { start: req.start, count: req.count } : {}),
      });
      let list = body.variables ?? [];
      if (req.start !== undefined && req.count !== undefined && list.length > req.count) {
        list = list.slice(req.start, req.start + req.count);
      }
      return {
        ...base,
        ok: true,
        variables: list.map((v) => ({
          name: v.name,
          value: v.value,
          type: v.type,
          variablesReference: v.variablesReference,
          indexedVariables: v.indexedVariables,
          namedVariables: v.namedVariables,
        })),
      };
    } catch (err) {
      return { ...base, ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
