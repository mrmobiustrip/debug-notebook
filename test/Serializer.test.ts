import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { DebugNotebookSerializer, isTextMime } from '../src/notebook/Serializer';
import { decode } from './helpers';

const ser = new DebugNotebookSerializer(() => 'python');

function roundTrip(data: vscode.NotebookData): vscode.NotebookData {
  return ser.deserializeNotebook(ser.serializeNotebook(data));
}

describe('DebugNotebookSerializer', () => {
  it('empty content yields an empty notebook', () => {
    const nb = ser.deserializeNotebook(new Uint8Array());
    expect(nb.cells).toHaveLength(0);
  });

  it('round-trips cells, languages, outputs and metadata', () => {
    const code = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1\nx', 'python');
    code.executionSummary = { executionOrder: 4 };
    code.outputs = [
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout('hi\n'), vscode.NotebookCellOutputItem.stdout('there\n')]),
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text('1', 'text/plain'),
        vscode.NotebookCellOutputItem.text('<b>1</b>', 'text/html'),
        new vscode.NotebookCellOutputItem(new Uint8Array([137, 80, 78, 71]), 'image/png'),
        vscode.NotebookCellOutputItem.json({ a: 1 }, 'application/json'),
      ]),
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name: 'NameError', message: 'boom', stack: 'l1\nl2' })]),
    ];
    const md = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '# Title', 'markdown');
    const js = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '1+1', 'javascript');
    const data = new vscode.NotebookData([code, md, js]);
    data.metadata = { debugNotebook: { pinnedSession: 'A' } };

    const out = roundTrip(data);
    expect(out.metadata?.debugNotebook).toEqual({ pinnedSession: 'A' });
    expect(out.cells.map((c) => [c.kind, c.languageId, c.value])).toEqual([
      [vscode.NotebookCellKind.Code, 'python', 'x = 1\nx'],
      [vscode.NotebookCellKind.Markup, 'markdown', '# Title'],
      [vscode.NotebookCellKind.Code, 'javascript', '1+1'],
    ]);
    const c0 = out.cells[0];
    expect(c0.executionSummary?.executionOrder).toBe(4);
    expect(c0.outputs).toHaveLength(3);
    // stream coalesced into one nbformat stream output
    expect(decode(c0.outputs![0].items[0])).toBe('hi\nthere\n');
    const rich = c0.outputs![1].items;
    expect(rich.map((i) => i.mime).sort()).toEqual(['application/json', 'image/png', 'text/html', 'text/plain']);
    expect([...rich.find((i) => i.mime === 'image/png')!.data]).toEqual([137, 80, 78, 71]);
    expect(JSON.parse(decode(rich.find((i) => i.mime === 'application/json')!))).toEqual({ a: 1 });
    const err = JSON.parse(decode(c0.outputs![2].items[0]));
    expect(err).toEqual({ name: 'NameError', message: 'boom', stack: 'l1\nl2' });
  });

  it('emits nbformat 4 JSON', () => {
    const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'a', 'python')]);
    const json = JSON.parse(new TextDecoder().decode(ser.serializeNotebook(data)));
    expect(json.nbformat).toBe(4);
    expect(json.cells[0]).toMatchObject({ cell_type: 'code', source: 'a', outputs: [], execution_count: null });
  });

  it('accepts array sources and reads language_info', () => {
    const json = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'javascript' } },
      cells: [{ cell_type: 'code', source: ['a\n', 'b'], metadata: {}, outputs: [] }],
    });
    const nb = ser.deserializeNotebook(new TextEncoder().encode(json));
    expect(nb.cells[0].value).toBe('a\nb');
    expect(nb.cells[0].languageId).toBe('javascript');
  });

  it('classifies mimes', () => {
    expect(isTextMime('text/html')).toBe(true);
    expect(isTextMime('application/vnd.debug-notebook.variable+json')).toBe(true);
    expect(isTextMime('image/svg+xml')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
  });
});
