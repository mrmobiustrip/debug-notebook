import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { VariableService } from '../src/notebook/VariableService';
import { SessionRegistry } from '../src/session/SessionRegistry';
import { attach, makeSession, stopped, continued } from './helpers';

function messaging() {
  const sent: unknown[] = [];
  let listener: ((e: { editor: vscode.NotebookEditor; message: unknown }) => void) | undefined;
  return {
    sent,
    fire: (message: unknown) => listener?.({ editor: {} as vscode.NotebookEditor, message }),
    api: {
      onDidReceiveMessage(l: typeof listener) {
        listener = l;
        return { dispose: () => undefined };
      },
      async postMessage(m: unknown) {
        sent.push(m);
        return true;
      },
    },
  };
}

describe('VariableService', () => {
  it('answers variables requests for the current stop', async () => {
    const registry = new SessionRegistry();
    const session = makeSession({
      customRequest: async (cmd, args) => {
        expect(cmd).toBe('variables');
        expect(args).toEqual({ variablesReference: 5 });
        return { variables: [{ name: 'a', value: '1', type: 'int', variablesReference: 0 }] };
      },
    });
    const { tracker } = attach(registry, session);
    stopped(tracker, 1);
    const m = messaging();
    const svc = new VariableService(registry, m.api);
    const res = await svc.answer({ type: 'variables', requestId: 9, sessionId: session.id, stopSeq: 1, variablesReference: 5 });
    expect(res).toEqual({
      type: 'variables',
      requestId: 9,
      ok: true,
      variables: [{ name: 'a', value: '1', type: 'int', variablesReference: 0, indexedVariables: undefined, namedVariables: undefined }],
    });
    svc.dispose();
  });

  it('refuses stale, running and gone handles without hitting the adapter', async () => {
    const registry = new SessionRegistry();
    let calls = 0;
    const session = makeSession({ customRequest: async () => (calls++, { variables: [] }) });
    const { tracker } = attach(registry, session);
    stopped(tracker, 1);
    const svc = new VariableService(registry, messaging().api);
    const req = { type: 'variables' as const, requestId: 1, sessionId: session.id, variablesReference: 1 };
    expect((await svc.answer({ ...req, stopSeq: 0 })) as { reason?: string }).toMatchObject({ ok: false, reason: 'stale' });
    continued(tracker, 1);
    expect((await svc.answer({ ...req, stopSeq: 1 })) as { reason?: string }).toMatchObject({ ok: false, reason: 'running' });
    expect((await svc.answer({ ...req, sessionId: 'nope', stopSeq: 1 })) as { reason?: string }).toMatchObject({ ok: false, reason: 'gone' });
    expect(calls).toBe(0);
  });

  it('passes start/count and slices oversized responses from adapters that ignore paging', async () => {
    const registry = new SessionRegistry();
    const seen: unknown[] = [];
    const session = makeSession({
      customRequest: async (_c, args) => {
        seen.push(args);
        return { variables: [0, 1, 2, 3, 4].map((i) => ({ name: String(i), value: String(i), variablesReference: 0 })) };
      },
    });
    const { tracker } = attach(registry, session);
    stopped(tracker, 1);
    const svc = new VariableService(registry, messaging().api);
    const req = { type: 'variables' as const, requestId: 1, sessionId: session.id, stopSeq: 1, variablesReference: 1, start: 2, count: 2 };
    const res = await svc.answer(req);
    expect(seen[0]).toEqual({ variablesReference: 1, start: 2, count: 2 });
    expect(res.ok && res.variables.map((v) => v.name)).toEqual(['2', '3']);
  });

  it('broadcasts invalidate on stop and on removal, and replies to incoming messages', async () => {
    const registry = new SessionRegistry();
    const session = makeSession({ customRequest: async () => ({ variables: [] }) });
    const { tracker } = attach(registry, session);
    const m = messaging();
    new VariableService(registry, m.api);
    stopped(tracker, 1);
    expect(m.sent.at(-1)).toEqual({ type: 'invalidate', sessionId: session.id, stopSeq: 1, gone: false });
    m.fire({ type: 'variables', requestId: 3, sessionId: session.id, stopSeq: 1, variablesReference: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.sent.at(-1)).toMatchObject({ type: 'variables', requestId: 3, ok: true });
    tracker.onDidSendMessage({ type: 'event', event: 'terminated' });
    expect(m.sent.at(-1)).toEqual({ type: 'invalidate', sessionId: session.id, stopSeq: 1, gone: true });
  });
});
