import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { OutputRouter } from '../src/notebook/OutputRouter';
import { SessionRegistry } from '../src/session/SessionRegistry';
import { attach, decode, makeSession, output } from './helpers';

class Sink {
  outputs: vscode.NotebookCellOutput[] = [];
  async appendOutput(o: vscode.NotebookCellOutput): Promise<void> {
    this.outputs.push(o);
  }
  async appendOutputItems(items: vscode.NotebookCellOutputItem[], o: vscode.NotebookCellOutput): Promise<void> {
    const target = this.outputs.find((x) => x === o);
    if (!target) {
      throw new Error('append to unknown output');
    }
    target.items.push(...items);
  }
}

function setup() {
  const registry = new SessionRegistry();
  const session = makeSession();
  const { tracker } = attach(registry, session);
  const router = new OutputRouter(registry.onOutput);
  const sink = new Sink();
  return { registry, session, tracker, router, sink };
}

describe('OutputRouter', () => {
  it('coalesces stdout/stderr events into one stream output in arrival order', async () => {
    const { session, tracker, router, sink } = setup();
    router.begin(session.id, sink);
    output(tracker, 'a\n');
    output(tracker, 'b\n', 'stderr');
    output(tracker, 'c\n');
    await router.end(session.id, 0);
    expect(sink.outputs).toHaveLength(1);
    expect(sink.outputs[0].items.map((i) => [i.mime.split('.').pop(), decode(i)])).toEqual([
      ['stdout', 'a\n'],
      ['stderr', 'b\n'],
      ['stdout', 'c\n'],
    ]);
  });

  it('drops output outside an execution and non-stdio categories', async () => {
    const { session, tracker, router, sink } = setup();
    output(tracker, 'before\n');
    router.begin(session.id, sink);
    output(tracker, 'console\n', 'console');
    output(tracker, 'telemetry\n', 'telemetry');
    tracker.onDidSendMessage({ type: 'event', event: 'output', body: { output: 'no category\n' } });
    await router.end(session.id, 0);
    output(tracker, 'after\n');
    expect(sink.outputs).toHaveLength(0);
  });

  it('keeps attributing during the grace window', async () => {
    const { session, tracker, router, sink } = setup();
    router.begin(session.id, sink);
    const done = router.end(session.id, 30);
    setTimeout(() => output(tracker, 'late\n'), 5);
    await done;
    expect(sink.outputs).toHaveLength(1);
    expect(decode(sink.outputs[0].items[0])).toBe('late\n');
  });

  it('ignores output for other sessions', async () => {
    const registry = new SessionRegistry();
    const a = makeSession({ id: 'a' });
    const b = makeSession({ id: 'b' });
    const ta = attach(registry, a).tracker;
    const tb = attach(registry, b).tracker;
    const router = new OutputRouter(registry.onOutput);
    const sink = new Sink();
    router.begin(a.id, sink);
    output(tb, 'other\n');
    output(ta, 'mine\n');
    await router.end(a.id, 0);
    expect(sink.outputs[0].items).toHaveLength(1);
    expect(decode(sink.outputs[0].items[0])).toBe('mine\n');
  });

  it('abandon stops attribution immediately', async () => {
    const { session, tracker, router, sink } = setup();
    router.begin(session.id, sink);
    router.abandon(session.id);
    output(tracker, 'x\n');
    expect(router.isOpen(session.id)).toBe(false);
    expect(sink.outputs).toHaveLength(0);
  });
});
