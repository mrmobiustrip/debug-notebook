import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/session/SessionRegistry';
import { ActiveDebugState, RUNNING_MESSAGE, TargetResolver, describeFrame } from '../src/session/TargetResolver';
import { attach, makeSession, stopped } from './helpers';

const frames = [
  { id: 11, name: 'bar', line: 42, column: 1, source: { path: '/w/foo.py' } },
  { id: 12, name: 'main', line: 7, column: 1, source: { path: '/w/foo.py' } },
];

function fetchStack() {
  const calls: unknown[] = [];
  const fn = async (_s: unknown, args: unknown) => {
    calls.push(args);
    return { stackFrames: frames, totalFrames: 2 };
  };
  return { fn, calls };
}

describe('TargetResolver', () => {
  it('fails fast when there is no session', async () => {
    const registry = new SessionRegistry();
    const active: ActiveDebugState = { activeDebugSession: undefined, activeStackItem: undefined };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    await expect(r.resolve(undefined)).rejects.toThrow(/No active debug session/);
  });

  it('fails fast when the debuggee is running', async () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    attach(registry, session);
    const active: ActiveDebugState = { activeDebugSession: session as never, activeStackItem: undefined };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    await expect(r.resolve(undefined)).rejects.toThrow(RUNNING_MESSAGE);
  });

  it('uses the selected stack frame and resolves its location', async () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    const { tracker } = attach(registry, session);
    stopped(tracker, 1);
    stopped(tracker, 1);
    const active: ActiveDebugState = {
      activeDebugSession: session as never,
      activeStackItem: { session, threadId: 1, frameId: 12 } as never,
    };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    const t = await r.resolve(undefined);
    expect(t.frameId).toBe(12);
    expect(t.threadId).toBe(1);
    expect(t.stopSeq).toBe(2);
    expect(t.location).toBe('foo.py:7 in main()');
  });

  it('takes the top frame when only a thread is selected', async () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    const { tracker } = attach(registry, session);
    stopped(tracker, 1);
    const active: ActiveDebugState = {
      activeDebugSession: session as never,
      activeStackItem: { session, threadId: 1 } as never,
    };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    const t = await r.resolve(undefined);
    expect(t.frameId).toBe(11);
    expect(t.location).toBe('foo.py:42 in bar()');
  });

  it('falls back to any stopped thread when the stack item belongs to another session', async () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    const other = makeSession({ id: 'other' });
    const { tracker } = attach(registry, session);
    stopped(tracker, 5);
    const active: ActiveDebugState = {
      activeDebugSession: session as never,
      activeStackItem: { session: other, threadId: 1, frameId: 99 } as never,
    };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    const t = await r.resolve(undefined);
    expect(t.threadId).toBe(5);
    expect(t.frameId).toBe(11);
  });

  it('prefers a pinned session by name', async () => {
    const registry = new SessionRegistry();
    const a = makeSession({ id: 'a', name: 'A' });
    const b = makeSession({ id: 'b', name: 'B' });
    attach(registry, a);
    const { tracker } = attach(registry, b);
    stopped(tracker, 2);
    const active: ActiveDebugState = { activeDebugSession: a as never, activeStackItem: undefined };
    const r = new TargetResolver(registry, active, fetchStack().fn as never);
    const t = await r.resolve({ pinnedSession: 'B' });
    expect(t.session.id).toBe('b');
    await expect(r.resolve({ pinnedSession: 'C' })).rejects.toThrow(/Pinned/);
  });

  it('describeFrame handles missing source', () => {
    expect(describeFrame({ id: 1, name: 'f', line: 3, column: 0 })).toBe('line 3 in f()');
    expect(describeFrame({ id: 1, name: '<module>', line: 3, column: 0, source: { name: 'x.py' } })).toBe('x.py:3 in <module>()');
  });
});
