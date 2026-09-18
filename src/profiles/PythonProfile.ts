import * as vscode from 'vscode';
import { evaluate } from '../session/Dap';
import { errorMessage } from '../session/TargetResolver';
import { CellError, ExecCtx, LanguageProfile, ScopeVariable } from './LanguageProfile';
import { VARIABLE_MIME, VariableHandle } from '../renderer/protocol';

/**
 * debugpy profile. Gives cells the Jupyter feel:
 *  - a trailing expression is shown as a rich MIME bundle (pandas HTML,
 *    matplotlib PNG, _repr_*_ protocols) instead of being dropped;
 *  - open matplotlib figures are captured after every cell.
 *
 * Mechanism (see docs/design.md §6): a helper module is injected into the
 * debuggee once per session. The helper only parses and formats; user code is
 * always evaluated natively by the adapter in the paused frame, so scoping and
 * locals write-back match the Debug Console.
 *
 * Measured against debugpy 1.8.20 (scripts/dap_spike.py): `repl` results are
 * truncated at 64 KB; `clipboard` results are not truncated (5 MB verified).
 */

const MODULE = '__dbgnb';
const H = `__import__('${MODULE}')`;
/** Base64 chars returned inline by the helper before it parks the payload. */
const INLINE_LIMIT = 60000;
/** Chunk sizes for pulling parked payloads, per context. */
const CHUNK_REPL = 60000;
const CHUNK_CLIPBOARD = 2 * 1024 * 1024;

export interface PythonProfileOptions {
  helperSource: string;
  maxBundleBytes: () => number;
  /** Append an expandable variable tree for the trailing expression's object. */
  inspector?: () => boolean;
}

interface SplitResult {
  body: string | null;
  last_expr: string | null;
}

interface BundleResult {
  outputs: Record<string, string>[];
}

const BINARY_MIME = /^(image\/(?!svg)|application\/pdf)/;

export class PythonProfile implements LanguageProfile {
  readonly id = 'python';
  private readonly injected = new Set<string>();
  private readonly injectExpr: string;

  constructor(private readonly options: PythonProfileOptions) {
    const src = Buffer.from(options.helperSource, 'utf8').toString('base64');
    // Single expression, evaluated with eval(): nothing is assigned in the frame.
    this.injectExpr =
      `(lambda m: (exec(compile(__import__('base64').b64decode('${src}').decode('utf-8'), '<${MODULE}>', 'exec'), m.__dict__), ` +
      `__import__('sys').modules.__setitem__('${MODULE}', m), m)[2])(__import__('types').ModuleType('${MODULE}'))`;
  }

  matches(session: vscode.DebugSession): boolean {
    return session.type === 'debugpy' || session.type === 'python';
  }

  cellLanguage(): string {
    return 'python';
  }

  scopeStub(vars: ScopeVariable[], location: string): string {
    const lines = [
      `# Debug Notebook: names in the paused frame (${location}). Auto-updated on every stop; never executed or saved.`,
      'from typing import Any',
    ];
    const decls = vars
      .filter((v) => !v.name.startsWith('__'))
      .map((v) => `${v.name}: ${pythonAnnotation(v.type)}`);
    for (let i = 0; i < decls.length; i += 6) {
      lines.push(decls.slice(i, i + 6).join('; '));
    }
    return lines.join('\n') + '\n';
  }

  async execute(ctx: ExecCtx, source: string): Promise<vscode.NotebookCellOutput[]> {
    const { session, frameId } = ctx.target;
    await this.ensureHelper(ctx);

    const srcB64 = Buffer.from(source, 'utf8').toString('base64');
    const split = await this.callHelper<SplitResult>(ctx, `split('${srcB64}', inline_limit=${INLINE_LIMIT})`);
    if (ctx.token.isCancellationRequested) {
      return [];
    }

    if (split.body) {
      await this.evalUser(session, frameId, split.body);
    }
    if (ctx.token.isCancellationRequested) {
      return [];
    }

    const kwargs = `max_bytes=${this.options.maxBundleBytes()}, inline_limit=${INLINE_LIMIT}`;
    // Parenthesise so tuple/conditional expressions do not merge with kwargs.
    const bundleCall = split.last_expr ? `bundle((${split.last_expr}\n), ${kwargs})` : `bundle(${kwargs})`;
    const result = await this.callHelper<BundleResult>(ctx, bundleCall, true);
    const outputs = result.outputs.map(toOutput);

    if (split.last_expr && (this.options.inspector?.() ?? true)) {
      const tree = await this.inspectorOutput(ctx);
      if (tree) {
        outputs.push(tree);
      }
    }
    return outputs;
  }

  /**
   * The helper keeps the last bundled object in `_last`; evaluating that
   * attribute (no side effects) yields a DAP variablesReference the tree
   * renderer can expand lazily. Emitted as a separate output so the rich
   * bundle keeps its own renderer.
   */
  private async inspectorOutput(ctx: ExecCtx): Promise<vscode.NotebookCellOutput | undefined> {
    const { session, frameId, state } = ctx.target;
    try {
      const body = await evaluate(session, { expression: `${H}._last`, frameId, context: 'repl' });
      if (!body.variablesReference) {
        return undefined;
      }
      const handle: VariableHandle = {
        sessionId: session.id,
        stopSeq: state.stopSeq,
        variablesReference: body.variablesReference,
        result: body.result,
        type: body.type,
        indexedVariables: body.indexedVariables,
        namedVariables: body.namedVariables,
      };
      return new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(handle, VARIABLE_MIME),
        vscode.NotebookCellOutputItem.text(body.result, 'text/plain'),
      ]);
    } catch {
      return undefined;
    }
  }

  // --- helper transport -----------------------------------------------------

  private async ensureHelper(ctx: ExecCtx): Promise<void> {
    const id = ctx.target.session.id;
    if (this.injected.has(id)) {
      return;
    }
    await this.inject(ctx);
  }

  private async inject(ctx: ExecCtx): Promise<void> {
    const { session, frameId } = ctx.target;
    try {
      await evaluate(session, { expression: this.injectExpr, frameId, context: 'repl' });
    } catch (err) {
      throw new CellError('DebugNotebook', `Could not inject the Python helper: ${errorMessage(err)}`);
    }
    this.injected.add(session.id);
  }

  /**
   * Evaluate `H.<call>` and decode the packed result. If the module went
   * missing (process restarted under the same session), re-inject once.
   * `userCode` marks calls whose arguments contain user expressions; their
   * failures are rendered as Python errors rather than transport errors.
   */
  private async callHelper<T>(ctx: ExecCtx, call: string, userCode = false): Promise<T> {
    const { session, frameId } = ctx.target;
    const expression = `${H}.${call}`;
    let packed: string;
    try {
      packed = (await evaluate(session, { expression, frameId, context: 'repl' })).result;
    } catch (err) {
      const message = errorMessage(err);
      if (isMissingHelper(message) && this.injected.has(session.id)) {
        this.injected.delete(session.id);
        await this.inject(ctx);
        return this.callHelper<T>(ctx, call, userCode);
      }
      if (userCode) {
        throw toCellError(message);
      }
      throw new CellError('DebugNotebook', `Helper call failed: ${message}`);
    }
    return this.unpack<T>(ctx, packed);
  }

  private async unpack<T>(ctx: ExecCtx, packed: string): Promise<T> {
    const raw = stripQuotes(packed);
    const first = raw.indexOf(':');
    const second = raw.indexOf(':', first + 1);
    if (first < 0 || second < 0) {
      throw new CellError('DebugNotebook', `Unexpected helper response: ${raw.slice(0, 80)}`);
    }
    const id = Number(raw.slice(0, first));
    const length = Number(raw.slice(first + 1, second));
    let data = raw.slice(second + 1);
    if (id !== 0) {
      data = await this.pull(ctx, id, length);
    }
    if (data.length !== length) {
      throw new CellError('DebugNotebook', `Helper payload truncated (${data.length} of ${length} bytes).`);
    }
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as T;
  }

  private async pull(ctx: ExecCtx, id: number, length: number): Promise<string> {
    const { session, frameId, state } = ctx.target;
    const clipboard = state.capabilities.supportsClipboardContext === true;
    const context = clipboard ? 'clipboard' : 'repl';
    const chunk = clipboard ? CHUNK_CLIPBOARD : CHUNK_REPL;
    const parts: string[] = [];
    let offset = 0;
    try {
      while (offset < length) {
        if (ctx.token.isCancellationRequested) {
          break;
        }
        const res = await evaluate(session, { expression: `${H}.read(${id}, ${offset}, ${chunk})`, frameId, context });
        const piece = stripQuotes(res.result);
        if (!piece.length) {
          break;
        }
        parts.push(piece);
        offset += piece.length;
      }
    } finally {
      evaluate(session, { expression: `${H}.drop(${id})`, frameId, context: 'repl' }).then(undefined, () => undefined);
    }
    return parts.join('');
  }

  private async evalUser(session: vscode.DebugSession, frameId: number, code: string): Promise<void> {
    try {
      await evaluate(session, { expression: code, frameId, context: 'repl' });
    } catch (err) {
      throw toCellError(errorMessage(err));
    }
  }
}

function isMissingHelper(message: string): boolean {
  return /No module named '?__dbgnb'?/.test(message);
}

/** debugpy puts the full traceback in the error message. */
export function toCellError(message: string): CellError {
  const lines = message.trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? message;
  const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Iteration)?)\s*:\s*(.*)$/.exec(last);
  if (m && lines.length > 1) {
    return new CellError(m[1], m[2] || last, message);
  }
  if (m) {
    return new CellError(m[1], m[2] || last);
  }
  return new CellError('Error', last, lines.length > 1 ? message : undefined);
}

export function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

function toOutput(bundle: Record<string, string>): vscode.NotebookCellOutput {
  const items: vscode.NotebookCellOutputItem[] = [];
  for (const [mime, value] of Object.entries(bundle)) {
    if (BINARY_MIME.test(mime)) {
      items.push(new vscode.NotebookCellOutputItem(Buffer.from(value, 'base64'), mime));
    } else {
      items.push(vscode.NotebookCellOutputItem.text(value, mime));
    }
  }
  return new vscode.NotebookCellOutput(items);
}

const PY_BUILTIN_TYPES = new Set(['int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'tuple', 'set', 'frozenset', 'complex', 'bytearray']);

export function pythonAnnotation(type: string | undefined): string {
  return type && PY_BUILTIN_TYPES.has(type) ? type : 'Any';
}
