import * as vscode from 'vscode';
import { SessionRegistry, SessionState } from '../src/session/SessionRegistry';

export interface FakeSession {
  id: string;
  name: string;
  type: string;
  customRequest: (command: string, args?: unknown) => Promise<unknown>;
}

export interface Tracker {
  onWillReceiveMessage(msg: unknown): void;
  onDidSendMessage(msg: unknown): void;
  onExit?(): void;
}

let seq = 100;
export function nextSeq(): number {
  return ++seq;
}

export function makeSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    id: over.id ?? 'sess-1',
    name: over.name ?? 'Python: Current File',
    type: over.type ?? 'debugpy',
    customRequest: over.customRequest ?? (async () => ({})),
  };
}

export function attach(registry: SessionRegistry, session: FakeSession): { tracker: Tracker; state: SessionState } {
  const factory = (vscode as unknown as { debug: { trackerFactory?: { createDebugAdapterTracker(s: unknown): unknown } } }).debug
    .trackerFactory;
  if (!factory) {
    throw new Error('registry did not register a tracker factory');
  }
  const tracker = factory.createDebugAdapterTracker(session) as Tracker;
  const state = registry.get(session.id);
  if (!state) {
    throw new Error('session not registered');
  }
  return { tracker, state };
}

export function stopped(tracker: Tracker, threadId: number, all = false): void {
  tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId, allThreadsStopped: all } });
}

export function continued(tracker: Tracker, threadId: number, all = false): void {
  tracker.onDidSendMessage({ type: 'event', event: 'continued', body: { threadId, allThreadsContinued: all } });
}

export function output(tracker: Tracker, text: string, category: string | undefined = 'stdout'): void {
  tracker.onDidSendMessage({ type: 'event', event: 'output', body: { category, output: text } });
}

export function request(tracker: Tracker, command: string, args?: unknown): number {
  const s = nextSeq();
  tracker.onWillReceiveMessage({ type: 'request', seq: s, command, arguments: args });
  return s;
}

export function response(tracker: Tracker, requestSeq: number, command: string, body?: unknown, success = true): void {
  tracker.onDidSendMessage({ type: 'response', seq: nextSeq(), request_seq: requestSeq, command, success, body });
}

export function decode(item: vscode.NotebookCellOutputItem): string {
  return new TextDecoder().decode(item.data);
}
