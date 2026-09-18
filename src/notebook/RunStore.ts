import * as vscode from 'vscode';
import type { RunMetadata } from './Staleness';

/**
 * In-memory record of which stop each cell's output came from. Kept out of
 * cell metadata so executions never dirty the document, which matters for
 * `.ipynb` files owned by the Jupyter serializer.
 */
export class RunStore implements vscode.Disposable {
  private readonly runs = new Map<string, RunMetadata>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidCloseNotebookDocument((doc) => {
      const prefix = doc.uri.toString();
      for (const key of [...this.runs.keys()]) {
        if (this.runs.get(key)?.notebookUri === prefix) {
          this.runs.delete(key);
        }
      }
    });
  }

  get(cell: vscode.NotebookCell): RunMetadata | undefined {
    return this.runs.get(key(cell));
  }

  set(cell: vscode.NotebookCell, meta: RunMetadata): void {
    this.runs.set(key(cell), meta);
    this.emitter.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function key(cell: vscode.NotebookCell): string {
  return cell.document.uri.toString();
}
