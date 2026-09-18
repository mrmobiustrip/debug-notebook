import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionRegistry } from '../session/SessionRegistry';
import { NotebookPin, TargetError, TargetResolver, errorMessage } from '../session/TargetResolver';
import { cancel } from '../session/Dap';
import { ProfileRegistry } from '../profiles';
import { CellError } from '../profiles/LanguageProfile';
import { OutputRouter } from './OutputRouter';
import { RunMetadata } from './Staleness';
import { RunStore } from './RunStore';
import { CONTROLLER_ID, JUPYTER_NOTEBOOK_TYPE, NOTEBOOK_TYPE } from './constants';

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
  /** One controller per notebook type: our own, plus Jupyter's so `.ipynb` files can run against a paused process. */
  private readonly controllers = new Map<string, vscode.NotebookController>();
  private readonly executionOrder = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private current: InFlight | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** `.ipynb` documents whose kernel picker currently selects us. */
  private readonly selectedJupyter = new Set<string>();
  private readonly selectionEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSelection = this.selectionEmitter.event;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly resolver: TargetResolver,
    private readonly profiles: ProfileRegistry,
    private readonly router: OutputRouter,
    private readonly runs: RunStore,
  ) {
    for (const type of [NOTEBOOK_TYPE, JUPYTER_NOTEBOOK_TYPE]) {
      const id = type === NOTEBOOK_TYPE ? CONTROLLER_ID : `${CONTROLLER_ID}-jupyter`;
      const controller = vscode.notebooks.createNotebookController(id, type, 'Debug Session');
      controller.description = 'Evaluate cells in the selected frame of the paused debuggee';
      controller.detail = 'Uses the active debug session via DAP evaluate';
      controller.supportsExecutionOrder = true;
      controller.executeHandler = (cells, notebook) => this.executeCells(cells, notebook);
      controller.interruptHandler = (notebook) => this.interrupt(notebook);
      if (type === JUPYTER_NOTEBOOK_TYPE) {
        controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
          const key = notebook.uri.toString();
          if (selected) {
            this.selectedJupyter.add(key);
          } else {
            this.selectedJupyter.delete(key);
          }
          this.selectionEmitter.fire();
        });
      }
      this.controllers.set(type, controller);
      this.disposables.push(controller);
    }
    this.disposables.push(this.selectionEmitter);
  }

  /** True for our own notebooks and for `.ipynb` files that picked the Debug Session kernel. */
  owns(notebook: vscode.NotebookDocument): boolean {
    return notebook.notebookType === NOTEBOOK_TYPE || this.selectedJupyter.has(notebook.uri.toString());
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

  /** True while a cell is executing against the given session. */
  isBusy(sessionId?: string): boolean {
    const c = this.current;
    if (!c) {
      return false;
    }
    return sessionId === undefined || c.sessionId === undefined || c.sessionId === sessionId;
  }

  staleCells(notebook: vscode.NotebookDocument): vscode.NotebookCell[] {
    return notebook.getCells().filter((cell) => {
      const meta = this.runs.get(cell);
      if (!meta) {
        return false;
      }
      const live = this.registry.get(meta.sessionRunId);
      return !!live && !live.terminated && live.stopSeq > meta.stopSeq;
    });
  }

  private async executeOne(cell: vscode.NotebookCell, notebook: vscode.NotebookDocument): Promise<void> {
    const controller = this.controllers.get(notebook.notebookType) ?? this.controllers.get(NOTEBOOK_TYPE)!;
    const execution = controller.createNotebookCellExecution(cell);
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
        notebookUri: notebook.uri.toString(),
        sessionRunId: target.session.id,
        sessionName: target.session.name,
        stopSeq: target.state.stopSeq,
        location: target.location,
      };
      this.runs.set(cell, meta);
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

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function graceMs(): number {
  return vscode.workspace.getConfiguration('debugNotebook').get<number>('outputGraceMs', 75);
}
