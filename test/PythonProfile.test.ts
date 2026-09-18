import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { PythonProfile, stripQuotes, toCellError } from '../src/profiles/PythonProfile';
import { CellError } from '../src/profiles/LanguageProfile';
import type { ExecTarget } from '../src/session/TargetResolver';
import { decode } from './helpers';

const HELPER = 'def split(*a, **k): pass\n';

function pack(payload: unknown, inlineLimit = 60000): { packed: string; data: string } {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  if (data.length <= inlineLimit) {
    return { packed: `'0:${data.length}:${data}'`, data };
  }
  return { packed: `'7:${data.length}:'`, data };
}

interface Script {
  /** Called for each evaluate; return result string or throw. */
  (expression: string, context: string): string;
}

function fakeTarget(script: Script, caps: Record<string, boolean> = {}): { target: ExecTarget; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const session = {
    id: 's1',
    name: 'py',
    type: 'debugpy',
    customRequest: async (command: string, args: { expression: string; context: string }) => {
      if (command !== 'evaluate') {
        throw new Error('unexpected ' + command);
      }
      calls.push([args.expression, args.context]);
      return { result: script(args.expression, args.context), variablesReference: 0 };
    },
  };
  const target = {
    session,
    state: { capabilities: caps },
    threadId: 1,
    frameId: 10,
    stopSeq: 1,
    location: 'x',
  } as unknown as ExecTarget;
  return { target, calls };
}

const token = { isCancellationRequested: false } as vscode.CancellationToken;

function profile(): PythonProfile {
  return new PythonProfile({ helperSource: HELPER, maxBundleBytes: () => 1000 });
}

describe('PythonProfile', () => {
  it('injects once, splits, evaluates body natively, bundles trailing expression', async () => {
    const split = pack({ body: 'x = 1\n', last_expr: 'x + 1' }).packed;
    const bundle = pack({ outputs: [{ 'text/plain': '2', 'text/html': '<b>2</b>' }] }).packed;
    const { target, calls } = fakeTarget((expr) => {
      if (expr.startsWith('(lambda m:')) return "<module '__dbgnb'>";
      if (expr.includes('.split(')) return split;
      if (expr === 'x = 1\n') return '';
      if (expr.includes('.bundle(')) return bundle;
      throw new Error('unexpected ' + expr);
    });
    const p = profile();
    const out = await p.execute({ target, token }, 'x = 1\nx + 1');
    expect(calls.map((c) => c[0].slice(0, 30))).toEqual([
      expect.stringContaining('(lambda m:'),
      expect.stringContaining("__import__('__dbgnb').split("),
      'x = 1\n',
      expect.stringContaining("__import__('__dbgnb').bundle"),
    ]);
    expect(calls[3][0]).toBe("__import__('__dbgnb').bundle((x + 1\n), max_bytes=1000, inline_limit=60000)");
    expect(out).toHaveLength(1);
    expect(out[0].items.map((i) => [i.mime, decode(i)])).toEqual([
      ['text/plain', '2'],
      ['text/html', '<b>2</b>'],
    ]);

    // second run: no re-injection
    calls.length = 0;
    await p.execute({ target, token }, 'x = 1\nx + 1');
    expect(calls[0][0]).toContain('.split(');
  });

  it('skips body when only an expression, decodes binary mimes', async () => {
    const split = pack({ body: null, last_expr: 'img' }).packed;
    const png = Buffer.from([137, 80, 78, 71]).toString('base64');
    const bundle = pack({ outputs: [{ 'image/png': png, 'text/plain': '<img>' }] }).packed;
    const { target, calls } = fakeTarget((expr) => {
      if (expr.startsWith('(lambda m:')) return '';
      if (expr.includes('.split(')) return split;
      if (expr.includes('.bundle(')) return bundle;
      throw new Error('unexpected ' + expr);
    });
    const out = await profile().execute({ target, token }, 'img');
    expect(calls).toHaveLength(3);
    expect([...out[0].items[0].data]).toEqual([137, 80, 78, 71]);
    expect(out[0].items[0].mime).toBe('image/png');
  });

  it('pulls parked payloads in chunks via clipboard context when supported, then drops', async () => {
    const big = { outputs: [{ 'text/plain': 'z'.repeat(5000) }] };
    const { packed, data } = pack(big, 100);
    const reads: string[] = [];
    let dropped = false;
    const { target } = fakeTarget((expr, ctx) => {
      if (expr.startsWith('(lambda m:')) return '';
      if (expr.includes('.split(')) return pack({ body: null, last_expr: 'z' }).packed;
      if (expr.includes('.bundle(')) return packed;
      const m = /\.read\(7, (\d+), (\d+)\)/.exec(expr);
      if (m) {
        reads.push(ctx);
        return `'${data.slice(Number(m[1]), Number(m[1]) + Number(m[2]))}'`;
      }
      if (expr.includes('.drop(7)')) {
        dropped = true;
        return 'None';
      }
      throw new Error('unexpected ' + expr);
    }, { supportsClipboardContext: true });
    const out = await profile().execute({ target, token }, 'z');
    expect(decode(out[0].items[0])).toBe('z'.repeat(5000));
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set(['clipboard']));
    expect(dropped).toBe(true);
  });

  it('re-injects when the helper module is missing and retries', async () => {
    let injected = 0;
    let failedOnce = false;
    const { target } = fakeTarget((expr) => {
      if (expr.startsWith('(lambda m:')) {
        injected++;
        return '';
      }
      if (expr.includes('.split(')) {
        if (injected === 1 && !failedOnce) {
          failedOnce = true;
          throw new Error("Traceback...\nModuleNotFoundError: No module named '__dbgnb'\n");
        }
        return pack({ body: null, last_expr: '1' }).packed;
      }
      if (expr.includes('.bundle(')) return pack({ outputs: [{ 'text/plain': '1' }] }).packed;
      throw new Error('unexpected ' + expr);
    });
    const p = profile();
    await p.execute({ target, token }, '1'); // injects (1), split fails, re-inject (2), split ok
    expect(injected).toBe(2);
  });

  it('surfaces user exceptions as CellError with traceback', async () => {
    const { target } = fakeTarget((expr) => {
      if (expr.startsWith('(lambda m:')) return '';
      if (expr.includes('.split(')) return pack({ body: 'x = 1\n', last_expr: '1/0' }).packed;
      if (expr === 'x = 1\n') return '';
      throw new Error('Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nZeroDivisionError: division by zero\n');
    });
    const err = await profile().execute({ target, token }, 'x = 1\n1/0').catch((e) => e);
    expect(err).toBeInstanceOf(CellError);
    expect(err.name).toBe('ZeroDivisionError');
    expect(err.message).toBe('division by zero');
    expect(err.traceback).toContain('Traceback');
  });

  it('parses tracebacks and strips quotes', () => {
    const e = toCellError('Traceback (most recent call last):\n  File "<string>", line 1\nNameError: name \'m\' is not defined\n');
    expect([e.name, e.message]).toEqual(['NameError', "name 'm' is not defined"]);
    expect(toCellError('SyntaxError: invalid syntax').name).toBe('SyntaxError');
    expect(toCellError('something odd').message).toBe('something odd');
    expect(stripQuotes("'abc'")).toBe('abc');
    expect(stripQuotes('"abc"')).toBe('abc');
    expect(stripQuotes('abc')).toBe('abc');
  });
});
