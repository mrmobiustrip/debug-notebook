import * as vscode from 'vscode';
import type { OutputBody, SessionOutput } from '../session/SessionRegistry';

/** The part of NotebookCellExecution the router needs; injectable for tests. */
export interface OutputSink {
  appendOutput(out: vscode.NotebookCellOutput): Thenable<void>;
  appendOutputItems(items: vscode.NotebookCellOutputItem[], output: vscode.NotebookCellOutput): Thenable<void>;
}

interface Open {
  sessionId: string;
  sink: OutputSink;
  stream?: vscode.NotebookCellOutput;
  /** Serialises appends so item order matches arrival order. */
  chain: Promise<unknown>;
}

/**
 * Attributes DAP `output` events to the cell currently executing against that
 * session. Events carry no request id, so the rule is purely temporal: while
 * an execution is open for a session, its stdout/stderr belongs to that cell.
 * Output arriving outside any execution is dropped (it is still in the Debug
 * Console).
 */
export class OutputRouter implements vscode.Disposable {
  private readonly open = new Map<string, Open>();
  private readonly subscription: vscode.Disposable;

  constructor(onOutput: vscode.Event<SessionOutput>) {
    this.subscription = onOutput((e) => this.handle(e.sessionId, e.body));
  }

  begin(sessionId: string, sink: OutputSink): void {
    this.open.set(sessionId, { sessionId, sink, chain: Promise.resolve() });
  }

  /**
   * Keep attributing output for `graceMs` after the evaluate response, since
   * adapters flush redirected stdout asynchronously. Resolves once all
   * appends issued during the window have been applied.
   */
  async end(sessionId: string, graceMs: number): Promise<void> {
    const entry = this.open.get(sessionId);
    if (!entry) {
      return;
    }
    if (graceMs > 0) {
      await new Promise((r) => setTimeout(r, graceMs));
    }
    if (this.open.get(sessionId) === entry) {
      this.open.delete(sessionId);
    }
    await entry.chain;
  }

  /** Abort attribution immediately (interrupt). */
  abandon(sessionId: string): void {
    this.open.delete(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  private handle(sessionId: string, body: OutputBody): void {
    const entry = this.open.get(sessionId);
    if (!entry) {
      return;
    }
    const category = body.category ?? 'console';
    if (category !== 'stdout' && category !== 'stderr') {
      return;
    }
    if (!body.output) {
      return;
    }
    const item =
      category === 'stderr'
        ? vscode.NotebookCellOutputItem.stderr(body.output)
        : vscode.NotebookCellOutputItem.stdout(body.output);

    entry.chain = entry.chain.then(() => {
      if (!entry.stream) {
        entry.stream = new vscode.NotebookCellOutput([item]);
        return entry.sink.appendOutput(entry.stream);
      }
      return entry.sink.appendOutputItems([item], entry.stream);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.open.clear();
  }
}
