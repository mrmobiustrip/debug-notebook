import * as vscode from 'vscode';
import type { SessionRegistry, SessionState } from '../session/SessionRegistry';

export const AUTO_RUN_KEY = 'debugNotebook';

export function isAutoRun(cell: { metadata: Readonly<Record<string, unknown>> }): boolean {
  const meta = cell.metadata?.[AUTO_RUN_KEY] as { autoRun?: boolean } | undefined;
  return meta?.autoRun === true;
}

export interface WatchTarget {
  /** Notebooks whose watch cells should run for this session. */
  notebooksFor(state: SessionState): vscode.NotebookDocument[];
  /** True while a cell is executing against the session; stops caused by our own evaluates must not retrigger. */
  isBusy(sessionId: string): boolean;
  execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void>;
}

/**
 * Re-runs cells flagged `autoRun` on every `stopped` event, after a short
 * debounce so `debug.activeStackItem` has settled on the new frame.
 */
export class WatchScheduler implements vscode.Disposable {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscription: vscode.Disposable;

  constructor(
    registry: SessionRegistry,
    private readonly target: WatchTarget,
    private readonly debounceMs = 100,
  ) {
    this.subscription = registry.onDidChange((state) => this.onChange(state));
  }

  private onChange(state: SessionState): void {
    if (state.terminated || state.anyStoppedThread() === undefined) {
      return;
    }
    if (this.target.isBusy(state.runId)) {
      return;
    }
    const existing = this.timers.get(state.runId);
    if (existing) {
      clearTimeout(existing);
    }
    const seq = state.stopSeq;
    this.timers.set(
      state.runId,
      setTimeout(() => {
        this.timers.delete(state.runId);
        if (state.terminated || state.stopSeq !== seq || this.target.isBusy(state.runId)) {
          return;
        }
        void this.run(state);
      }, this.debounceMs),
    );
  }

  private async run(state: SessionState): Promise<void> {
    for (const notebook of this.target.notebooksFor(state)) {
      const cells = notebook.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code && isAutoRun(c));
      if (cells.length) {
        await this.target.execute(cells, notebook);
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
  }
}
