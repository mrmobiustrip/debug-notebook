import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { SessionRegistry } from '../session/SessionRegistry';
import { completions } from '../session/Dap';
import type { ProfileRegistry } from '../profiles';
import { NOTEBOOK_TYPES } from './constants';

const KIND: Record<string, vscode.CompletionItemKind> = {
  method: vscode.CompletionItemKind.Method,
  function: vscode.CompletionItemKind.Function,
  constructor: vscode.CompletionItemKind.Constructor,
  field: vscode.CompletionItemKind.Field,
  variable: vscode.CompletionItemKind.Variable,
  class: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  module: vscode.CompletionItemKind.Module,
  property: vscode.CompletionItemKind.Property,
  unit: vscode.CompletionItemKind.Unit,
  value: vscode.CompletionItemKind.Value,
  enum: vscode.CompletionItemKind.Enum,
  keyword: vscode.CompletionItemKind.Keyword,
  snippet: vscode.CompletionItemKind.Snippet,
  text: vscode.CompletionItemKind.Text,
  color: vscode.CompletionItemKind.Color,
  file: vscode.CompletionItemKind.File,
  reference: vscode.CompletionItemKind.Reference,
  customcolor: vscode.CompletionItemKind.Color,
};

/**
 * Runtime completions from the debug adapter for the selected frame. These
 * merge with whatever language server is active; ours sort first because they
 * reflect the real objects in scope.
 *
 * Each profile says whether the adapter wants the current line or the whole
 * cell as `text` (debugpy: line only; js-debug: whole cell with line/column,
 * both verified in scripts/). `start` in a returned item is a 0-based offset
 * into the `text` we sent (both adapters agree), mapped back to a range here.
 */
export class DapCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly profiles: ProfileRegistry,
    private readonly owns: (notebook: vscode.NotebookDocument) => boolean,
  ) {
    this.registration = vscode.languages.registerCompletionItemProvider(
      NOTEBOOK_TYPES.map((notebookType) => ({ notebookType })),
      this,
      '.',
    );
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const notebook = vscode.workspace.notebookDocuments.find((d) => d.getCells().some((c) => c.document === document));
    if (notebook && !this.owns(notebook)) {
      return undefined;
    }
    const session = vscode.debug.activeDebugSession;
    if (!session) {
      return undefined;
    }
    const state = this.registry.get(session);
    if (!state || !state.capabilities.supportsCompletionsRequest) {
      return undefined;
    }
    const item = vscode.debug.activeStackItem;
    const frameId =
      item && item.session.id === session.id && 'frameId' in item && typeof item.frameId === 'number'
        ? item.frameId
        : undefined;

    const scope = this.profiles.for(session).completionScope ?? 'line';
    const cellScope = scope === 'cell';
    const text = cellScope ? document.getText() : document.lineAt(position.line).text;
    const line = cellScope ? position.line + 1 : 1;
    let body: DebugProtocol.CompletionsResponse['body'];
    try {
      body = await completions(session, { frameId, text, column: position.character + 1, line });
    } catch {
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }
    const base = cellScope ? 0 : document.offsetAt(new vscode.Position(position.line, 0));
    return (body.targets ?? []).map((t) => toItem(t, document, position, base));
  }

  dispose(): void {
    this.registration.dispose();
  }
}

function toItem(
  t: DebugProtocol.CompletionItem,
  document: vscode.TextDocument,
  position: vscode.Position,
  textOffset: number,
): vscode.CompletionItem {
  const label = t.label;
  const item = new vscode.CompletionItem(label, KIND[t.type ?? ''] ?? vscode.CompletionItemKind.Text);
  item.insertText = t.text ?? label;
  item.detail = t.detail;
  item.sortText = `0${t.sortText ?? label}`;
  if (typeof t.start === 'number' && typeof t.length === 'number') {
    const start = document.positionAt(textOffset + t.start);
    const end = document.positionAt(textOffset + t.start + t.length);
    if (start.line === position.line && !start.isAfter(position)) {
      item.range = new vscode.Range(start, end);
    }
  } else if (t.selectionStart === undefined) {
    const word = document.getWordRangeAtPosition(position);
    if (word) {
      item.range = word;
    }
  }
  return item;
}
