import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionRegistry } from '../session/SessionRegistry';
import { NotebookPin, TargetError, TargetResolver, errorMessage } from '../session/TargetResolver';
import { cancel } from '../session/Dap';
import { ProfileRegistry } from '../profiles';
import { CellError } from '../profiles/LanguageProfile';
import { OutputRouter } from './OutputRouter';
import { RUN_METADATA_KEY, RunMetadata, readRunMetadata } from './Staleness';
import { CONTROLLER_ID, NOTEBOOK_TYPE } from './constants';

interface InFlight {
  notebook: vscode.NotebookDocument;
  cell: vscode.NotebookCell;
  execution: vscode.NotebookCellExecution;
  cts: vscode.CancellationTokenSource;
  sessionId?: string;
  evaluateSeq?: number;
  abandoned: boolean;
}

export class DebugNotebookController implements vscode.Disposable {
  readonly controller: vscode.NotebookController;
  private readonly executionOrder = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private current: InFlight | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidWriteMetadataEmitter = new vscode.EventEmitter<void>();
  readonly onDidWriteMetadata = this.onDidWriteMetadataEmitter.event;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly resolver: TargetResolver,
    private readonly profiles: ProfileRegistry,
    private readonly router: OutputRouter,
  ) {
    this.controller = vscode.notebooks.createNotebookController(CONTROLLER_ID, NOTEBOOK_TYPE, 'Debug Session');
    this.controller.description = 'Evaluate cells in the selected frame of the paused debuggee';
    this.controller.detail = 'Uses the active debug session via DAP evaluate';
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.executeCells(cells, notebook);
    this.controller.interruptHandler = (notebook) => this.interrupt(notebook);
    this.disposables.push(this.controller, this.onDidWriteMetadataEmitter);
  }

  /** Public so commands (re-run stale) can drive execution directly. */
  executeCells(cells: readonly vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }
      // Executions are strictly serial: the debuggee is paused on one thread and
      // concurrent evaluates are meaningless (some adapters deadlock).
      this.queue = this.queue.then(() => this.executeOne(cell, notebook)).catch(() => undefined);
    }
    return this.queue;
  }

  staleCells(notebook: vscode.NotebookDocument): vscode.NotebookCell[] {
    return notebook.getCells().filter((cell) => {
      const meta = readRunMetadata(cell.metadata);
      if (!meta) {
        return false;
      }
      const live = this.registry.get(meta.sessionRunId);
      return !!live && !live.terminated && live.stopSeq > meta.stopSeq;
    });
  }

  private async executeOne(cell: vscode.NotebookCell, notebook: vscode.NotebookDocument): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    const key = notebook.uri.toString();
    const order = (this.executionOrder.get(key) ?? 0) + 1;
    this.executionOrder.set(key, order);
    execution.executionOrder = order;
    execution.start(Date.now());
    await execution.clearOutput();

    const flight: InFlight = {
      notebook,
      cell,
      execution,
      cts: new vscode.CancellationTokenSource(),
      abandoned: false,
    };
    this.current = flight;

    let success = false;
    let seqListener: vscode.Disposable | undefined;
    try {
      const pin = (notebook.metadata?.debugNotebook as NotebookPin | undefined) ?? undefined;
      const target = await this.resolver.resolve(pin);
      flight.sessionId = target.session.id;

      // Capture the outgoing evaluate's seq so interrupt can send `cancel`.
      seqListener = target.state.onWillSendRequest((req: DebugProtocol.Request) => {
        if (req.command === 'evaluate' && flight.evaluateSeq === undefined) {
          flight.evaluateSeq = req.seq;
        }
      });

      const profile = this.profiles.for(target.session);
      await this.ensureLanguage(cell, profile.cellLanguage(target.session));
      if (profile.onSessionReady) {
        await profile.onSessionReady(target);
      }

      this.router.begin(target.session.id, execution);
      let outputs: vscode.NotebookCellOutput[];
      try {
        outputs = await profile.execute({ target, token: flight.cts.token }, cell.document.getText());
      } finally {
        if (flight.abandoned) {
          this.router.abandon(target.session.id);
        } else {
          await this.router.end(target.session.id, graceMs());
        }
      }

      if (flight.abandoned) {
        await execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error({ name: 'Interrupted', message: 'Execution was interrupted.' }),
          ]),
        );
      } else {
        for (const out of outputs) {
          await execution.appendOutput(out);
        }
        success = true;
      }

      // If the evaluate itself hit a breakpoint, the output reflects the new
      // stop, so record the stopSeq at completion rather than at resolution.
      const meta: RunMetadata = {
        sessionRunId: target.session.id,
        sessionName: target.session.name,
        stopSeq: target.state.stopSeq,
        location: target.location,
      };
      await this.writeRunMetadata(notebook, cell, meta);
    } catch (err) {
      if (flight.abandoned) {
        await execution.appendOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.error({ name: 'Interrupted', message: 'Execution was interrupted.' }),
          ]),
        );
      } else {
        const item =
          err instanceof CellError
            ? vscode.NotebookCellOutputItem.error({ name: err.name, message: err.message, stack: err.traceback })
            : vscode.NotebookCellOutputItem.error({
                name: err instanceof TargetError ? 'DebugNotebook' : 'EvaluateError',
                message: errorMessage(err),
              });
        await execution.appendOutput(new vscode.NotebookCellOutput([item]));
      }
    } finally {
      seqListener?.dispose();
      flight.cts.dispose();
      if (this.current === flight) {
        this.current = undefined;
      }
      execution.end(success, Date.now());
    }
  }

  private async interrupt(notebook: vscode.NotebookDocument): Promise<void> {
    const flight = this.current;
    if (!flight || flight.notebook.uri.toString() !== notebook.uri.toString()) {
      return;
    }
    flight.abandoned = true;
    flight.cts.cancel();
    const state = flight.sessionId ? this.registry.get(flight.sessionId) : undefined;
    if (state && state.capabilities.supportsCancelRequest && flight.evaluateSeq !== undefined) {
      try {
        await cancel(state.session, { requestId: flight.evaluateSeq });
      } catch {
        // Adapter refused; the late response will be ignored anyway.
      }
    }
    // Do not send `pause`: the thread is already paused and the evaluate runs
    // inside it. Without cancel support we simply abandon the execution.
  }

  private async ensureLanguage(cell: vscode.NotebookCell, language: string): Promise<void> {
    if (language === 'plaintext' || cell.document.languageId === language) {
      return;
    }
    if (cell.document.languageId !== 'plaintext') {
      // User picked a language deliberately; leave it.
      return;
    }
    try {
      await vscode.languages.setTextDocumentLanguage(cell.document, language);
    } catch {
      // Language may not be installed; harmless.
    }
  }

  private async writeRunMetadata(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    meta: RunMetadata,
  ): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, [RUN_METADATA_KEY]: meta }),
    ]);
    await vscode.workspace.applyEdit(edit);
    this.onDidWriteMetadataEmitter.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function graceMs(): number {
  return vscode.workspace.getConfiguration('debugNotebook').get<number>('outputGraceMs', 75);
}
