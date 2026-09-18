import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SessionRegistry, SessionState } from './session/SessionRegistry';
import { TargetResolver } from './session/TargetResolver';
import { ProfileRegistry } from './profiles';
import { PythonProfile } from './profiles/PythonProfile';
import { JsProfile } from './profiles/JsProfile';
import { languageForSessionType } from './profiles/LanguageProfile';
import { OutputRouter } from './notebook/OutputRouter';
import { DebugNotebookController } from './notebook/Controller';
import { DebugNotebookSerializer } from './notebook/Serializer';
import { RunStatusProvider } from './notebook/StatusBar';
import { DapCompletionProvider } from './notebook/Completions';
import { VariableService } from './notebook/VariableService';
import { AUTO_RUN_KEY, WatchScheduler, isAutoRun } from './notebook/WatchScheduler';
import { RunStore } from './notebook/RunStore';
import { NOTEBOOK_TYPE } from './notebook/constants';

const config = () => vscode.workspace.getConfiguration('debugNotebook');

export function activate(context: vscode.ExtensionContext): void {
  const registry = new SessionRegistry();
  const resolver = new TargetResolver(registry);
  const profiles = new ProfileRegistry();
  profiles.register(
    new PythonProfile({
      helperSource: fs.readFileSync(path.join(context.extensionPath, 'dist', 'helper.py'), 'utf8'),
      maxBundleBytes: () => config().get<number>('python.maxBundleBytes', 10 * 1024 * 1024),
      inspector: () => config().get<boolean>('python.inspector', true),
    }),
  );
  profiles.register(
    new JsProfile({
      helperSource: fs.readFileSync(path.join(context.extensionPath, 'dist', 'helper.js'), 'utf8'),
      maxBundleBytes: () => config().get<number>('javascript.maxBundleBytes', 10 * 1024 * 1024),
      inspector: () => config().get<boolean>('javascript.inspector', true),
    }),
  );
  const router = new OutputRouter(registry.onOutput);
  const runs = new RunStore();
  const controller = new DebugNotebookController(registry, resolver, profiles, router, runs);
  const statusBar = new RunStatusProvider(registry, runs);
  const owns = (doc: vscode.NotebookDocument) => controller.owns(doc);

  const activeLanguage = (): string => {
    const session = vscode.debug.activeDebugSession;
    return session ? languageForSessionType(session.type) : 'python';
  };

  /** Most recently focused debug notebook, for send-selection. */
  let lastNotebook: vscode.NotebookDocument | undefined;
  const trackNotebook = (editor: vscode.NotebookEditor | undefined) => {
    if (editor && owns(editor.notebook)) {
      lastNotebook = editor.notebook;
    }
  };
  trackNotebook(vscode.window.activeNotebookEditor);

  const pinOf = (notebook: vscode.NotebookDocument): string | undefined =>
    (notebook.metadata?.debugNotebook as { pinnedSession?: string } | undefined)?.pinnedSession;

  // Pin state of the active notebook: drives the toolbar icon (context key)
  // and a window status bar item.
  const pinStatus = vscode.window.createStatusBarItem('debugNotebook.pin', vscode.StatusBarAlignment.Left, 50);
  pinStatus.name = 'Debug Notebook session';
  pinStatus.command = 'debugNotebook.pinSession';
  const updatePinUi = () => {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || !owns(editor.notebook)) {
      pinStatus.hide();
      void vscode.commands.executeCommand('setContext', 'debugNotebook.pinned', false);
      return;
    }
    const pin = pinOf(editor.notebook);
    void vscode.commands.executeCommand('setContext', 'debugNotebook.pinned', !!pin);
    if (pin) {
      const live = registry.findByName(pin);
      pinStatus.text = `$(pinned) ${pin}`;
      pinStatus.tooltip = live
        ? `Debug Notebook: pinned to "${pin}". Click to change or unpin.`
        : `Debug Notebook: pinned to "${pin}", which is not running. Click to change or unpin.`;
      pinStatus.backgroundColor = live ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      const active = vscode.debug.activeDebugSession;
      pinStatus.text = active ? `$(debug-disconnect) ${active.name}` : '$(debug-disconnect) no session';
      pinStatus.tooltip = 'Debug Notebook: following the active debug session. Click to pin.';
      pinStatus.backgroundColor = undefined;
    }
    pinStatus.show();
  };

  const notebooksFor = (state: SessionState): vscode.NotebookDocument[] =>
    vscode.workspace.notebookDocuments.filter((doc) => {
      if (!owns(doc)) {
        return false;
      }
      const pin = pinOf(doc);
      return pin ? pin === state.session.name : vscode.debug.activeDebugSession?.id === state.session.id;
    });

  const watcher = new WatchScheduler(registry, {
    notebooksFor,
    isBusy: (id) => controller.isBusy(id),
    execute: (cells, notebook) => controller.executeCells(cells, notebook),
  });

  context.subscriptions.push(
    registry,
    router,
    controller,
    statusBar,
    watcher,
    runs,
    new VariableService(registry),
    new DapCompletionProvider(registry, profiles, owns),
    controller.onDidChangeSelection(() => {
      trackNotebook(vscode.window.activeNotebookEditor);
      updatePinUi();
    }),
    pinStatus,
    vscode.window.onDidChangeActiveNotebookEditor((e) => {
      trackNotebook(e);
      updatePinUi();
    }),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.metadata && e.notebook === vscode.window.activeNotebookEditor?.notebook) {
        updatePinUi();
      }
    }),
    vscode.debug.onDidChangeActiveDebugSession(updatePinUi),
    registry.onDidRemove(updatePinUi),
    vscode.workspace.onDidCloseNotebookDocument((doc) => {
      if (lastNotebook === doc) {
        lastNotebook = undefined;
      }
    }),
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DebugNotebookSerializer(activeLanguage)),

    vscode.commands.registerCommand('debugNotebook.openScratch', () => openScratch(activeLanguage())),

    vscode.commands.registerCommand('debugNotebook.rerunStale', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || !owns(editor.notebook)) {
        void vscode.window.showInformationMessage('Focus a debug notebook first.');
        return;
      }
      const stale = controller.staleCells(editor.notebook);
      if (!stale.length) {
        void vscode.window.setStatusBarMessage('Debug Notebook: no stale cells', 2000);
        return;
      }
      await controller.executeCells(stale, editor.notebook);
    }),

    vscode.commands.registerCommand('debugNotebook.toggleAutoRun', async (arg?: vscode.NotebookCell | { notebookEditor?: unknown }) => {
      const cells = resolveCells(arg);
      if (!cells.length) {
        return;
      }
      const turningOn = cells.some((c) => !isAutoRun(c));
      if (turningOn && !context.workspaceState.get<boolean>('watchWarningShown')) {
        await context.workspaceState.update('watchWarningShown', true);
        void vscode.window.showWarningMessage(
          'Watch cells re-run on every stop of the debuggee. Any side effects in the cell repeat each time.',
        );
      }
      const edit = new vscode.WorkspaceEdit();
      for (const cell of cells) {
        const existing = (cell.metadata?.[AUTO_RUN_KEY] as Record<string, unknown> | undefined) ?? {};
        edit.set(cell.notebook.uri, [
          vscode.NotebookEdit.updateCellMetadata(cell.index, {
            ...cell.metadata,
            [AUTO_RUN_KEY]: { ...existing, autoRun: turningOn },
          }),
        ]);
      }
      await vscode.workspace.applyEdit(edit);
      statusBar.refresh();
    }),

    vscode.commands.registerCommand('debugNotebook.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const text = editor.selection.isEmpty
        ? editor.document.lineAt(editor.selection.active.line).text
        : editor.document.getText(editor.selection);
      if (!text.trim()) {
        return;
      }
      let notebook = lastNotebook ?? vscode.workspace.notebookDocuments.find(owns);
      if (!notebook) {
        notebook = await openScratch(activeLanguage(), true);
        lastNotebook = notebook;
      }
      const language = editor.document.languageId === 'plaintext' ? activeLanguage() : editor.document.languageId;
      const index = notebook.cellCount;
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [
        vscode.NotebookEdit.insertCells(index, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, text, language)]),
      ]);
      await vscode.workspace.applyEdit(edit);
      const cell = notebook.cellAt(index);
      const range = new vscode.NotebookRange(index, index + 1);
      const uri = notebook.uri.toString();
      let nbEditor = vscode.window.visibleNotebookEditors.find((e) => e.notebook.uri.toString() === uri);
      if (!nbEditor) {
        nbEditor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      }
      nbEditor.selections = [range];
      nbEditor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
      await controller.executeCells([cell], notebook);
    }),

    vscode.commands.registerCommand('debugNotebook.pinSession', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || !owns(editor.notebook)) {
        void vscode.window.showInformationMessage('Focus a debug notebook first.');
        return;
      }
      const sessions = registry.all().filter((s) => !s.terminated && !s.session.parentSession);
      if (!sessions.length) {
        void vscode.window.showInformationMessage('No debug sessions running.');
        return;
      }
      const current = pinOf(editor.notebook);
      const picks: (vscode.QuickPickItem & { name?: string })[] = [
        current
          ? { label: `$(pinned) Unpin from "${current}"`, description: 'follow the active session instead', name: undefined }
          : { label: '$(debug-disconnect) Follow the active session', description: 'current', name: undefined },
        ...sessions.map((s) => ({
          label: `$(debug) ${s.session.name}`,
          description: [s.session.type, s.session.name === current ? 'pinned' : ''].filter(Boolean).join(' · '),
          name: s.session.name,
        })),
      ];
      const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Pin this notebook to a debug session' });
      if (!choice) {
        return;
      }
      await setPin(editor.notebook, choice.name);
      updatePinUi();
    }),

    vscode.commands.registerCommand('debugNotebook.unpinSession', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (editor && owns(editor.notebook)) {
        await setPin(editor.notebook, undefined);
        updatePinUi();
      }
    }),

    vscode.debug.onDidStartDebugSession((session) => {
      if (session.parentSession) {
        return; // child sessions (e.g. debugpy subprocess) share the notebook
      }
      if (config().get<string>('openOnSessionStart', 'never') !== 'scratch') {
        return;
      }
      const alreadyOpen = vscode.workspace.notebookDocuments.some((d) => d.notebookType === NOTEBOOK_TYPE);
      if (!alreadyOpen) {
        void openScratch(languageForSessionType(session.type));
      }
    }),
  );
  updatePinUi();
}

function resolveCells(arg: unknown): vscode.NotebookCell[] {
  if (arg && typeof arg === 'object' && 'notebook' in arg && 'index' in arg) {
    return [arg as vscode.NotebookCell];
  }
  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return [];
  }
  return editor.selections.flatMap((r) => editor.notebook.getCells(r));
}

async function setPin(notebook: vscode.NotebookDocument, name: string | undefined): Promise<void> {
  const existing = (notebook.metadata?.debugNotebook as Record<string, unknown> | undefined) ?? {};
  const debugNotebook = { ...existing };
  if (name) {
    debugNotebook.pinnedSession = name;
  } else {
    delete debugNotebook.pinnedSession;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...notebook.metadata, debugNotebook })]);
  await vscode.workspace.applyEdit(edit);
  void vscode.window.setStatusBarMessage(
    name ? `Debug Notebook: pinned to "${name}"` : 'Debug Notebook: following the active session',
    3000,
  );
}

async function openScratch(language: string, preserveFocus = false): Promise<vscode.NotebookDocument> {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', language);
  const data = new vscode.NotebookData([cell]);
  data.metadata = { debugNotebook: {} };
  const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus });
  return doc;
}

export function deactivate(): void {
  // Disposables handled via context.subscriptions.
}
