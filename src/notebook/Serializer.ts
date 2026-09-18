import * as vscode from 'vscode';
import { isStubCell } from './ScopeStub';

/**
 * nbformat 4 compatible JSON so a `.dbgnb` can be renamed to `.ipynb` and
 * opened anywhere. Extension specifics live under `metadata.debugNotebook`.
 * Per-cell language is stored as `metadata.vscode.languageId`, which the
 * Jupyter extension also understands.
 */

interface NbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: NbOutput[];
  execution_count?: number | null;
}

type NbOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string | string[] }
  | { output_type: 'execute_result' | 'display_data'; data: Record<string, unknown>; metadata?: Record<string, unknown>; execution_count?: number | null }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

interface Nb {
  nbformat: 4;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbCell[];
}

const TEXT_MIME = /^(text\/|image\/svg\+xml$|application\/(json|.*\+json|javascript|xml|.*\+xml|x-latex))/;

export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime);
}

export class DebugNotebookSerializer implements vscode.NotebookSerializer {
  constructor(private readonly defaultLanguage: () => string) {}

  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const text = new TextDecoder().decode(content).trim();
    let nb: Partial<Nb> = {};
    if (text) {
      try {
        nb = JSON.parse(text) as Partial<Nb>;
      } catch (err) {
        throw new Error(`Not a valid debug notebook: ${(err as Error).message}`);
      }
    }
    const nbLanguage =
      (nb.metadata?.language_info as { name?: string } | undefined)?.name ?? this.defaultLanguage();
    const cells = (nb.cells ?? []).map((c) => this.toCell(c, nbLanguage));
    const data = new vscode.NotebookData(cells);
    data.metadata = { ...(nb.metadata ?? {}) };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const metadata: Record<string, unknown> = { ...(data.metadata ?? {}) };
    const firstCode = data.cells.find((c) => c.kind === vscode.NotebookCellKind.Code);
    if (firstCode && !metadata.language_info) {
      // Lets Jupyter pick a sensible default when the file is opened as .ipynb.
      metadata.language_info = { name: firstCode.languageId };
    }
    const nb: Nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata,
      cells: data.cells.filter((c) => !isStubCell({ metadata: c.metadata ?? {} })).map((c) => this.fromCell(c)),
    };
    return new TextEncoder().encode(JSON.stringify(nb, null, 1) + '\n');
  }

  private toCell(c: NbCell, nbLanguage: string): vscode.NotebookCellData {
    const source = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '');
    const meta = { ...(c.metadata ?? {}) };
    const vsMeta = meta.vscode as { languageId?: string } | undefined;
    const kind = c.cell_type === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const language = kind === vscode.NotebookCellKind.Markup ? 'markdown' : (vsMeta?.languageId ?? nbLanguage);
    const cell = new vscode.NotebookCellData(kind, source, language);
    cell.metadata = meta;
    if (typeof c.execution_count === 'number') {
      cell.executionSummary = { executionOrder: c.execution_count };
    }
    if (kind === vscode.NotebookCellKind.Code) {
      cell.outputs = (c.outputs ?? []).map(toOutput).filter((o): o is vscode.NotebookCellOutput => !!o);
    }
    return cell;
  }

  private fromCell(c: vscode.NotebookCellData): NbCell {
    const isMarkup = c.kind === vscode.NotebookCellKind.Markup;
    const metadata: Record<string, unknown> = { ...(c.metadata ?? {}) };
    if (!isMarkup) {
      metadata.vscode = { ...((metadata.vscode as object) ?? {}), languageId: c.languageId };
    }
    const cell: NbCell = {
      cell_type: isMarkup ? 'markdown' : 'code',
      source: c.value,
      metadata,
    };
    if (!isMarkup) {
      cell.execution_count = c.executionSummary?.executionOrder ?? null;
      cell.outputs = (c.outputs ?? []).flatMap(fromOutput);
    }
    return cell;
  }
}

function toOutput(o: NbOutput): vscode.NotebookCellOutput | undefined {
  switch (o.output_type) {
    case 'stream': {
      const text = Array.isArray(o.text) ? o.text.join('') : o.text;
      const item = o.name === 'stderr' ? vscode.NotebookCellOutputItem.stderr(text) : vscode.NotebookCellOutputItem.stdout(text);
      return new vscode.NotebookCellOutput([item]);
    }
    case 'error':
      return new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error({ name: o.ename, message: o.evalue, stack: o.traceback?.join('\n') }),
      ]);
    case 'execute_result':
    case 'display_data': {
      const items: vscode.NotebookCellOutputItem[] = [];
      for (const [mime, value] of Object.entries(o.data ?? {})) {
        items.push(toItem(mime, value));
      }
      const out = new vscode.NotebookCellOutput(items);
      if (o.metadata) {
        out.metadata = o.metadata;
      }
      return out;
    }
    default:
      return undefined;
  }
}

function toItem(mime: string, value: unknown): vscode.NotebookCellOutputItem {
  const str = Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : JSON.stringify(value);
  if (isTextMime(mime)) {
    return vscode.NotebookCellOutputItem.text(str, mime);
  }
  return new vscode.NotebookCellOutputItem(Buffer.from(str, 'base64'), mime);
}

function fromOutput(o: vscode.NotebookCellOutput): NbOutput[] {
  const result: NbOutput[] = [];
  const data: Record<string, unknown> = {};
  let hasData = false;
  for (const item of o.items) {
    const mime = item.mime;
    if (mime === 'application/vnd.code.notebook.stdout' || mime === 'application/vnd.code.notebook.stderr') {
      const name = mime.endsWith('stderr') ? 'stderr' : 'stdout';
      const text = Buffer.from(item.data).toString('utf8');
      const last = result[result.length - 1];
      if (last && last.output_type === 'stream' && last.name === name) {
        last.text = (last.text as string) + text;
      } else {
        result.push({ output_type: 'stream', name, text });
      }
      continue;
    }
    if (mime === 'application/vnd.code.notebook.error') {
      const err = JSON.parse(Buffer.from(item.data).toString('utf8')) as { name?: string; message?: string; stack?: string };
      result.push({
        output_type: 'error',
        ename: err.name ?? 'Error',
        evalue: err.message ?? '',
        traceback: err.stack ? err.stack.split('\n') : [],
      });
      continue;
    }
    hasData = true;
    if (isTextMime(mime)) {
      const text = Buffer.from(item.data).toString('utf8');
      data[mime] = mime.includes('json') ? safeJson(text) : text;
    } else {
      data[mime] = Buffer.from(item.data).toString('base64');
    }
  }
  if (hasData) {
    result.push({ output_type: 'display_data', data, metadata: o.metadata ?? {} });
  }
  return result;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
