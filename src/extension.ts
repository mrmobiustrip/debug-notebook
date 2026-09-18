import * as vscode from 'vscode';
import { SessionRegistry } from './session/SessionRegistry';
import { TargetResolver } from './session/TargetResolver';
import { ProfileRegistry } from './profiles';
import { languageForSessionType } from './profiles/LanguageProfile';
import { OutputRouter } from './notebook/OutputRouter';
import { DebugNotebookController } from './notebook/Controller';
import { DebugNotebookSerializer } from './notebook/Serializer';
import { RunStatusProvider } from './notebook/StatusBar';
import { RUN_METADATA_KEY } from './notebook/Staleness';
import { NOTEBOOK_TYPE } from './notebook/constants';

export function activate(context: vscode.ExtensionContext): void {
  const registry = new SessionRegistry();
  const resolver = new TargetResolver(registry);
  const profiles = new ProfileRegistry();
  const router = new OutputRouter(registry.onOutput);
  const controller = new DebugNotebookController(registry, resolver, profiles, router);
  const statusBar = new RunStatusProvider(registry);

  const activeLanguage = (): string => {
    const session = vscode.debug.activeDebugSession;
    return session ? languageForSessionType(session.type) : 'python';
  };

  context.subscriptions.push(
    registry,
    router,
    controller,
    statusBar,
    controller.onDidWriteMetadata(() => statusBar.refresh()),
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DebugNotebookSerializer(activeLanguage), {
      // Run metadata is a snapshot of a live session; never persist it and
      // never let it dirty the document.
      transientCellMetadata: { [RUN_METADATA_KEY]: true },
    }),
    vscode.commands.registerCommand('debugNotebook.openScratch', () => openScratch(activeLanguage())),
    vscode.commands.registerCommand('debugNotebook.rerunStale', async () => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) {
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
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.parentSession) {
        return; // child sessions (e.g. debugpy subprocess) share the notebook
      }
      const mode = vscode.workspace.getConfiguration('debugNotebook').get<string>('openOnSessionStart', 'never');
      if (mode !== 'scratch') {
        return;
      }
      const alreadyOpen = vscode.workspace.notebookDocuments.some((d) => d.notebookType === NOTEBOOK_TYPE);
      if (!alreadyOpen) {
        void openScratch(languageForSessionType(session.type));
      }
    }),
  );
}

async function openScratch(language: string): Promise<void> {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', language);
  const data = new vscode.NotebookData([cell]);
  data.metadata = { debugNotebook: {} };
  const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
}

export function deactivate(): void {
  // Disposables handled via context.subscriptions.
}
