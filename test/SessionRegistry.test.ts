import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../src/session/SessionRegistry';
import { attach, continued, makeSession, request, response, stopped } from './helpers';

describe('SessionRegistry', () => {
  it('tracks stopped threads and stopSeq', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    expect(state.stopSeq).toBe(0);
    expect(state.isThreadStopped(1)).toBe('running');

    stopped(tracker, 1);
    expect(state.stopSeq).toBe(1);
    expect(state.isThreadStopped(1)).toBe('stopped');
    expect(state.anyStoppedThread()).toBe(1);

    continued(tracker, 1);
    expect(state.isThreadStopped(1)).toBe('running');
    expect(state.stopSeq).toBe(1);
  });

  it('honours allThreadsStopped / allThreadsContinued', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    stopped(tracker, 1, true);
    expect(state.isThreadStopped(7)).toBe('stopped');
    continued(tracker, 1, true);
    expect(state.isThreadStopped(1)).toBe('running');
    expect(state.isThreadStopped(7)).toBe('running');
  });

  it('infers resume from a successful continue response when the adapter sends no continued event', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    stopped(tracker, 3);
    const seq = request(tracker, 'continue', { threadId: 3 });
    expect(state.isThreadStopped(3)).toBe('stopped');
    response(tracker, seq, 'continue', { allThreadsContinued: true });
    expect(state.isThreadStopped(3)).toBe('running');
  });

  it('does not resume on a failed step response', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    stopped(tracker, 3);
    const seq = request(tracker, 'next', { threadId: 3 });
    response(tracker, seq, 'next', undefined, false);
    expect(state.isThreadStopped(3)).toBe('stopped');
  });

  it('captures capabilities from the initialize response', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    const seq = request(tracker, 'initialize', {});
    response(tracker, seq, 'initialize', { supportsCancelRequest: true, supportsCompletionsRequest: true });
    expect(state.capabilities.supportsCancelRequest).toBe(true);
  });

  it('fires onDidChange for stop/continue and removes on terminate', () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    const { tracker } = attach(registry, session);
    let changes = 0;
    registry.onDidChange(() => changes++);
    const removed: string[] = [];
    registry.onDidRemove((id) => removed.push(id));
    stopped(tracker, 1);
    continued(tracker, 1);
    expect(changes).toBe(2);
    tracker.onDidSendMessage({ type: 'event', event: 'terminated' });
    expect(changes).toBe(3);
    expect(registry.get(session.id)?.terminated).toBe(true);
  });

  it('forwards evaluate requests via onWillSendRequest', () => {
    const registry = new SessionRegistry();
    const { tracker, state } = attach(registry, makeSession());
    const seen: number[] = [];
    state.onWillSendRequest((r) => seen.push(r.seq));
    const s = request(tracker, 'evaluate', { expression: 'x' });
    expect(seen).toEqual([s]);
  });
});
