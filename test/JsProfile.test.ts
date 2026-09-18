import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { JsProfile, toJsCellError, unquote } from '../src/profiles/JsProfile';
import { CellError } from '../src/profiles/LanguageProfile';
import type { ExecTarget } from '../src/session/TargetResolver';
import { decode } from './helpers';

const HELPER = "(function(){ globalThis.__dbgnb = {}; return 'ok'; })()";
const token = { isCancellationRequested: false } as vscode.CancellationToken;

function b64(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function fakeTarget(script: (expr: string, ctx: string) => { result: string; variablesReference?: number; type?: string }, caps = { supportsClipboardContext: true }) {
  const calls: Array<[string, string]> = [];
  const session = {
    id: 'js1',
    name: 'node',
    type: 'pwa-node',
    customRequest: async (_c: string, args: { expression: string; context: string }) => {
      calls.push([args.expression, args.context]);
      const r = script(args.expression, args.context);
      return { variablesReference: 0, ...r };
    },
  };
  const target = { session, state: { capabilities: caps, stopSeq: 4 }, threadId: 1, frameId: 10, stopSeq: 4, location: 'x' } as unknown as ExecTarget;
  return { target, calls };
}

const profile = (inspector = true) => new JsProfile({ helperSource: HELPER, maxBundleBytes: () => 5000, inspector: () => inspector });

describe('JsProfile', () => {
  it('injects once, evaluates via direct eval wrapper, formats through clipboard', async () => {
    const { target, calls } = fakeTarget((expr, ctx) => {
      if (expr === HELPER) return { result: "'ok'" };
      if (expr.startsWith('(__dbgnb.last = eval(')) return { result: '{a: 1}', type: 'Object', variablesReference: 7 };
      if (expr.startsWith('__dbgnb.format(')) {
        expect(ctx).toBe('clipboard');
        return { result: JSON.stringify(b64({ outputs: [{ 'application/json': '{"a":1}' }] })) };
      }
      throw new Error('unexpected ' + expr);
    });
    const p = profile();
    const out = await p.execute({ target, token }, 'let y = 1;\n({a: y})');
    expect(calls[1][0]).toBe('(__dbgnb.last = eval("let y = 1;\\n({a: y})"), __dbgnb.last)');
    expect(out).toHaveLength(2);
    expect(out[0].items.map((i) => [i.mime, decode(i)])).toEqual([
      ['application/json', '{"a":1}'],
      ['text/plain', '{a: 1}'],
    ]);
    const handle = JSON.parse(decode(out[1].items[0]));
    expect(handle).toMatchObject({ sessionId: 'js1', stopSeq: 4, variablesReference: 7, result: '{a: 1}' });

    calls.length = 0;
    await p.execute({ target, token }, '1');
    expect(calls[0][0]).toContain('eval(');
  });

  it('omits output for undefined results and uses repl with a smaller cap without clipboard support', async () => {
    const { target, calls } = fakeTarget(
      (expr) => {
        if (expr === HELPER) return { result: "'ok'" };
        if (expr.startsWith('(__dbgnb.last')) return { result: 'undefined', type: 'undefined' };
        if (expr.startsWith('__dbgnb.format(')) return { result: `'${b64({ outputs: [] })}'` };
        throw new Error('unexpected ' + expr);
      },
      { supportsClipboardContext: false },
    );
    const out = await profile().execute({ target, token }, 'total = 5');
    expect(out).toEqual([]);
    const fmt = calls.find((c) => c[0].startsWith('__dbgnb.format('))!;
    expect(fmt[1]).toBe('repl');
    expect(fmt[0]).toBe('__dbgnb.format({ maxBytes: 5000 })');
  });

  it('re-injects when the helper global is missing', async () => {
    let injected = 0;
    const { target } = fakeTarget((expr) => {
      if (expr === HELPER) {
        injected++;
        return { result: "'ok'" };
      }
      if (expr.startsWith('(__dbgnb.last')) {
        if (injected < 2) throw new Error('Uncaught ReferenceError ReferenceError: __dbgnb is not defined\n    at eval (repl:1:1)');
        return { result: '1', type: 'number' };
      }
      return { result: JSON.stringify(b64({ outputs: [] })) };
    });
    const out = await profile().execute({ target, token }, '1');
    expect(injected).toBe(2);
    expect(decode(out[0].items[0])).toBe('1');
  });

  it('maps js-debug errors to CellError', async () => {
    const { target } = fakeTarget((expr) => {
      if (expr === HELPER) return { result: "'ok'" };
      throw new Error("Uncaught TypeError TypeError: Cannot read properties of null (reading 'x')\n    at eval (repl:1:6)\n");
    });
    const err = await profile().execute({ target, token }, 'null.x').catch((e) => e);
    expect(err).toBeInstanceOf(CellError);
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe("Cannot read properties of null (reading 'x')");
    expect(err.traceback).toContain('at eval');
  });

  it('parses error shapes and unquotes results', () => {
    expect(toJsCellError('Uncaught Error Error: boom\n    at eval (repl:1:7)\n')).toMatchObject({ name: 'Error', message: 'boom' });
    expect(toJsCellError('Uncaught SyntaxError SyntaxError: Unexpected end of input')).toMatchObject({ name: 'SyntaxError', message: 'Unexpected end of input' });
    expect(toJsCellError('something odd')).toMatchObject({ name: 'Error', message: 'something odd' });
    expect(unquote('"a\\"b"')).toBe('a"b');
    expect(unquote("'abc'")).toBe('abc');
    expect(unquote('abc')).toBe('abc');
  });
});
