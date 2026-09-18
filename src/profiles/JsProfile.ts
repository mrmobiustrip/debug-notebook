import * as vscode from 'vscode';
import { evaluate } from '../session/Dap';
import { errorMessage } from '../session/TargetResolver';
import { CellError, ExecCtx, LanguageProfile, ScopeVariable } from './LanguageProfile';
import { VARIABLE_MIME, VariableHandle } from '../renderer/protocol';

/**
 * js-debug profile (Node, Chrome, Edge, extension host).
 *
 * Measured with scripts/js_spike.py against js-debug 1.104:
 *  - a multi-line `repl` evaluate returns the program's completion value, and
 *    assignments to frame locals persist; `let`/`const` do not survive to the
 *    next evaluate (same as the Debug Console);
 *  - `$_` is unreliable for objects, so the cell is evaluated as
 *    `(__dbgnb.last = eval(<source>), __dbgnb.last)`: direct eval keeps the
 *    frame scope and the completion value, and parks the object for formatting;
 *  - `repl` results are cut at 100 KB, `clipboard` results are not;
 *  - errors arrive as "Uncaught TypeError TypeError: msg\n    at …".
 */

const JS_SESSION_TYPES = new Set([
  'node',
  'pwa-node',
  'node-terminal',
  'chrome',
  'pwa-chrome',
  'msedge',
  'pwa-msedge',
  'extensionHost',
  'pwa-extensionHost',
]);

const H = '__dbgnb';
/** Base64 chars a `repl` result can carry before js-debug truncates. */
const REPL_LIMIT = 90000;

export interface JsProfileOptions {
  helperSource: string;
  maxBundleBytes: () => number;
  inspector?: () => boolean;
}

interface BundleResult {
  outputs: Record<string, string>[];
}

export class JsProfile implements LanguageProfile {
  readonly id = 'javascript';
  readonly completionScope = 'cell' as const;
  private readonly injected = new Set<string>();

  constructor(private readonly options: JsProfileOptions) {}

  matches(session: vscode.DebugSession): boolean {
    return JS_SESSION_TYPES.has(session.type);
  }

  cellLanguage(): string {
    return 'javascript';
  }

  scopeStub(vars: ScopeVariable[], location: string): string {
    const names = vars.map((v) => v.name).filter((n) => !RESERVED.has(n));
    const lines = [`// Debug Notebook: names in the paused frame (${location}). Auto-updated on every stop; never executed or saved.`];
    for (let i = 0; i < names.length; i += 8) {
      lines.push(`var ${names.slice(i, i + 8).join(', ')};`);
    }
    return lines.join('\n') + '\n';
  }

  async execute(ctx: ExecCtx, source: string): Promise<vscode.NotebookCellOutput[]> {
    const { session, frameId, state } = ctx.target;
    await this.ensureHelper(ctx);

    const expression = `(${H}.last = eval(${JSON.stringify(source)}), ${H}.last)`;
    let body;
    try {
      body = await evaluate(session, { expression, frameId, context: 'repl' });
    } catch (err) {
      const message = errorMessage(err);
      if (isMissingHelper(message)) {
        this.injected.delete(session.id);
        await this.ensureHelper(ctx);
        return this.execute(ctx, source);
      }
      throw toJsCellError(message);
    }
    if (ctx.token.isCancellationRequested) {
      return [];
    }

    const bundle = await this.fetchBundle(ctx);
    const outputs: vscode.NotebookCellOutput[] = [];
    const rich = bundle.outputs[0] ?? {};
    const items: vscode.NotebookCellOutputItem[] = [];
    for (const [mime, value] of Object.entries(rich)) {
      if (mime !== 'text/plain') {
        items.push(vscode.NotebookCellOutputItem.text(value, mime));
      }
    }
    const text = rich['text/plain'] ?? (body.result !== 'undefined' ? body.result : undefined);
    if (text !== undefined && text !== '') {
      items.push(vscode.NotebookCellOutputItem.text(text, 'text/plain'));
    }
    if (items.length) {
      outputs.push(new vscode.NotebookCellOutput(items));
    }

    if (body.variablesReference > 0 && (this.options.inspector?.() ?? true)) {
      const handle: VariableHandle = {
        sessionId: session.id,
        stopSeq: state.stopSeq,
        variablesReference: body.variablesReference,
        result: body.result,
        type: body.type,
        indexedVariables: body.indexedVariables,
        namedVariables: body.namedVariables,
      };
      outputs.push(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.json(handle, VARIABLE_MIME),
          vscode.NotebookCellOutputItem.text(body.result, 'text/plain'),
        ]),
      );
    }
    return outputs;
  }

  private async ensureHelper(ctx: ExecCtx): Promise<void> {
    const { session, frameId } = ctx.target;
    if (this.injected.has(session.id)) {
      return;
    }
    try {
      await evaluate(session, { expression: this.options.helperSource, frameId, context: 'repl' });
    } catch (err) {
      throw new CellError('DebugNotebook', `Could not inject the JavaScript helper: ${errorMessage(err)}`);
    }
    this.injected.add(session.id);
  }

  private async fetchBundle(ctx: ExecCtx): Promise<BundleResult> {
    const { session, frameId, state } = ctx.target;
    const clipboard = state.capabilities.supportsClipboardContext === true;
    const maxBytes = clipboard ? this.options.maxBundleBytes() : Math.min(this.options.maxBundleBytes(), (REPL_LIMIT * 3) / 4);
    const expression = `${H}.format({ maxBytes: ${Math.floor(maxBytes)} })`;
    try {
      const res = await evaluate(session, { expression, frameId, context: clipboard ? 'clipboard' : 'repl' });
      const raw = unquote(res.result);
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as BundleResult;
    } catch {
      return { outputs: [] };
    }
  }
}

function isMissingHelper(message: string): boolean {
  return /__dbgnb is not defined/.test(message);
}

/** js-debug: "Uncaught TypeError TypeError: Cannot read …\n    at eval (repl:1:6)\n" */
export function toJsCellError(message: string): CellError {
  const lines = message.trimEnd().split('\n');
  const first = lines[0] ?? message;
  const m = /^(?:Uncaught\s+)?(?:(\w*(?:Error|Exception))\s+)?(?:(\w*(?:Error|Exception)):\s*)?(.*)$/.exec(first);
  const name = (m && (m[2] || m[1])) || 'Error';
  const msg = (m && m[3]) || first;
  return new CellError(name, msg || first, lines.length > 1 ? message : undefined);
}

/** Result strings come quoted: `'…'` from repl, JSON `"…"` from clipboard. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1);
  }
  return t;
}

const RESERVED = new Set(['this', 'arguments', 'undefined', 'NaN', 'Infinity', 'globalThis', 'window', 'self', 'global']);
