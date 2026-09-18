import * as vscode from 'vscode';
import type { SessionRegistry } from '../session/SessionRegistry';
import { describeRun, readRunMetadata } from './Staleness';
import { NOTEBOOK_TYPE } from './constants';

export class RunStatusProvider implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly registry: SessionRegistry) {
    this.disposables = [
      registry.onDidChange(() => this.changeEmitter.fire()),
      registry.onDidRemove(() => this.changeEmitter.fire()),
      vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, this),
    ];
  }

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const meta = readRunMetadata(cell.metadata);
    if (!meta) {
      return [];
    }
    const live = this.registry.get(meta.sessionRunId);
    const status = describeRun(meta, live);
    const item = new vscode.NotebookCellStatusBarItem(status.text, vscode.NotebookCellStatusBarAlignment.Right);
    item.tooltip = status.tooltip;
    if (status.kind === 'stale') {
      item.command = 'debugNotebook.rerunStale';
    }
    return [item];
  }

  /** Force a refresh, e.g. after metadata was written. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
  }
}
