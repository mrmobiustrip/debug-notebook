import * as vscode from 'vscode';
import type { SessionRegistry } from '../session/SessionRegistry';
import { describeRun, readRunMetadata } from './Staleness';
import { NOTEBOOK_TYPE } from './constants';
import { isAutoRun } from './WatchScheduler';

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
    const items: vscode.NotebookCellStatusBarItem[] = [];
    if (isAutoRun(cell)) {
      const watch = new vscode.NotebookCellStatusBarItem('$(eye) watch', vscode.NotebookCellStatusBarAlignment.Right);
      watch.tooltip = 'Re-runs on every stop. Click to turn off.';
      watch.command = { command: 'debugNotebook.toggleAutoRun', title: 'Toggle watch', arguments: [cell] };
      items.push(watch);
    }
    const meta = readRunMetadata(cell.metadata);
    if (meta) {
      const live = this.registry.get(meta.sessionRunId);
      const status = describeRun(meta, live);
      const item = new vscode.NotebookCellStatusBarItem(status.text, vscode.NotebookCellStatusBarAlignment.Right);
      item.tooltip = status.tooltip;
      if (status.kind === 'stale') {
        item.command = 'debugNotebook.rerunStale';
      }
      items.push(item);
    }
    return items;
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
