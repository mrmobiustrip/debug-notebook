import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';

export type OutputBody = DebugProtocol.OutputEvent['body'];
export type StoppedBody = DebugProtocol.StoppedEvent['body'];
export type ContinuedBody = DebugProtocol.ContinuedEvent['body'];

/** Requests whose successful response means the target thread (or all threads) resumed. */
const RESUME_REQUESTS = new Set([
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'stepBack',
  'reverseContinue',
  'goto',
  'restart',
]);

/**
 * Per-session state derived purely from observed DAP traffic.
 * The registry never sends requests itself.
 */
export interface SessionState {
  readonly session: vscode.DebugSession;
  /** Stable identifier for this run; equals `session.id`. */
  readonly runId: string;
  readonly capabilities: DebugProtocol.Capabilities;
  /** Increments on every `stopped` event. Basis for staleness. */
  readonly stopSeq: number;
  readonly terminated: boolean;
  /** Threads currently known to be stopped. */
  readonly stoppedThreads: ReadonlySet<number>;
  /** True after a `stopped` with `allThreadsStopped` until any thread resumes. */
  readonly allStopped: boolean;
  isThreadStopped(threadId: number): 'stopped' | 'running' | 'unknown';
  /** Any stopped thread id, preferring the most recently stopped one. */
  anyStoppedThread(): number | undefined;

  readonly onOutput: vscode.Event<OutputBody>;
  readonly onStopped: vscode.Event<StoppedBody>;
  readonly onContinued: vscode.Event<ContinuedBody>;
  readonly onTerminated: vscode.Event<void>;
  /** Fires for every request the client sends, before the adapter sees it. */
  readonly onWillSendRequest: vscode.Event<DebugProtocol.Request>;
}

class SessionEntry implements SessionState, vscode.DebugAdapterTracker {
  readonly runId: string;
  capabilities: DebugProtocol.Capabilities = {};
  stopSeq = 0;
  terminated = false;
  stoppedThreads = new Set<number>();
  allStopped = false;
  private lastStoppedThread: number | undefined;
  /** seq -> threadId for in-flight resume requests. */
  private pendingResumes = new Map<number, number | undefined>();

  private readonly outputEmitter = new vscode.EventEmitter<OutputBody>();
  private readonly stoppedEmitter = new vscode.EventEmitter<StoppedBody>();
  private readonly continuedEmitter = new vscode.EventEmitter<ContinuedBody>();
  private readonly terminatedEmitter = new vscode.EventEmitter<void>();
  private readonly requestEmitter = new vscode.EventEmitter<DebugProtocol.Request>();

  readonly onOutput = this.outputEmitter.event;
  readonly onStopped = this.stoppedEmitter.event;
  readonly onContinued = this.continuedEmitter.event;
  readonly onTerminated = this.terminatedEmitter.event;
  readonly onWillSendRequest = this.requestEmitter.event;

  constructor(readonly session: vscode.DebugSession) {
    this.runId = session.id;
  }

  isThreadStopped(threadId: number): 'stopped' | 'running' | 'unknown' {
    if (this.stoppedThreads.has(threadId)) {
      return 'stopped';
    }
    if (this.allStopped) {
      return 'stopped';
    }
    // We only ever learn about threads through stopped events. A thread we have
    // never seen stop is, as far as we know, running.
    return 'running';
  }

  anyStoppedThread(): number | undefined {
    if (this.lastStoppedThread !== undefined && this.stoppedThreads.has(this.lastStoppedThread)) {
      return this.lastStoppedThread;
    }
    const first = this.stoppedThreads.values().next();
    return first.done ? undefined : first.value;
  }

  // --- DebugAdapterTracker -------------------------------------------------

  onWillReceiveMessage(message: unknown): void {
    const msg = message as DebugProtocol.ProtocolMessage;
    if (msg.type !== 'request') {
      return;
    }
    const req = msg as DebugProtocol.Request;
    if (RESUME_REQUESTS.has(req.command)) {
      const threadId = (req.arguments as { threadId?: number } | undefined)?.threadId;
      this.pendingResumes.set(req.seq, threadId);
    }
    this.requestEmitter.fire(req);
  }

  onDidSendMessage(message: unknown): void {
    const msg = message as DebugProtocol.ProtocolMessage;
    if (msg.type === 'event') {
      this.handleEvent(msg as DebugProtocol.Event);
    } else if (msg.type === 'response') {
      this.handleResponse(msg as DebugProtocol.Response);
    }
  }

  onError(): void {
    this.markTerminated();
  }

  onExit(): void {
    this.markTerminated();
  }

  // --- internals -----------------------------------------------------------

  private handleEvent(ev: DebugProtocol.Event): void {
    switch (ev.event) {
      case 'stopped': {
        const body = ev.body as StoppedBody;
        this.stopSeq++;
        if (body.threadId !== undefined) {
          this.stoppedThreads.add(body.threadId);
          this.lastStoppedThread = body.threadId;
        }
        if (body.allThreadsStopped) {
          this.allStopped = true;
        }
        this.stoppedEmitter.fire(body);
        break;
      }
      case 'continued': {
        const body = ev.body as ContinuedBody;
        this.markResumed(body.threadId, body.allThreadsContinued === true);
        this.continuedEmitter.fire(body);
        break;
      }
      case 'thread': {
        const body = ev.body as DebugProtocol.ThreadEvent['body'];
        if (body.reason === 'exited') {
          this.stoppedThreads.delete(body.threadId);
        }
        break;
      }
      case 'output':
        this.outputEmitter.fire(ev.body as OutputBody);
        break;
      case 'terminated':
      case 'exited':
        this.markTerminated();
        break;
    }
  }

  private handleResponse(res: DebugProtocol.Response): void {
    if (res.command === 'initialize' && res.success) {
      this.capabilities = (res.body as DebugProtocol.Capabilities | undefined) ?? {};
      return;
    }
    if (this.pendingResumes.has(res.request_seq)) {
      const threadId = this.pendingResumes.get(res.request_seq);
      this.pendingResumes.delete(res.request_seq);
      if (!res.success) {
        return;
      }
      // Many adapters (debugpy included) do not emit `continued` events for
      // client-initiated resumes; the client infers it from the response.
      // `continue` responses default allThreadsContinued to true per spec.
      const body = res.body as { allThreadsContinued?: boolean } | undefined;
      const all = res.command === 'continue' ? body?.allThreadsContinued !== false : body?.allThreadsContinued === true;
      const alreadyKnown = threadId !== undefined && !this.stoppedThreads.has(threadId) && !this.allStopped;
      if (!alreadyKnown) {
        this.markResumed(threadId, all);
        this.continuedEmitter.fire({ threadId: threadId ?? -1, allThreadsContinued: all });
      }
    }
  }

  private markResumed(threadId: number | undefined, all: boolean): void {
    if (all) {
      this.stoppedThreads.clear();
      this.allStopped = false;
      return;
    }
    if (threadId !== undefined) {
      this.stoppedThreads.delete(threadId);
    }
    // If everything was stopped and one thread resumed, we no longer know the
    // full set of stopped threads. Keep what we have; it is a best effort.
    this.allStopped = false;
  }

  markTerminated(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.stoppedThreads.clear();
    this.allStopped = false;
    this.terminatedEmitter.fire();
  }

  dispose(): void {
    this.outputEmitter.dispose();
    this.stoppedEmitter.dispose();
    this.continuedEmitter.dispose();
    this.terminatedEmitter.dispose();
    this.requestEmitter.dispose();
  }
}

export interface SessionOutput {
  sessionId: string;
  body: OutputBody;
}

/**
 * Tracks every debug session via a DebugAdapterTracker. Exposes per-session
 * state plus aggregate events for consumers that span sessions.
 */
export class SessionRegistry implements vscode.Disposable {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly changeEmitter = new vscode.EventEmitter<SessionState>();
  private readonly outputEmitter = new vscode.EventEmitter<SessionOutput>();
  private readonly removedEmitter = new vscode.EventEmitter<string>();

  /** Fires on stopped / continued / terminated for any session. */
  readonly onDidChange = this.changeEmitter.event;
  readonly onOutput = this.outputEmitter.event;
  /** Fires with the runId once a session is gone for good. */
  readonly onDidRemove = this.removedEmitter.event;

  constructor() {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => this.attach(session),
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        const entry = this.entries.get(session.id);
        if (entry) {
          entry.markTerminated();
          this.entries.delete(session.id);
          entry.dispose();
          this.removedEmitter.fire(session.id);
        }
      }),
    );
  }

  private attach(session: vscode.DebugSession): vscode.DebugAdapterTracker {
    const existing = this.entries.get(session.id);
    if (existing) {
      return existing;
    }
    const entry = new SessionEntry(session);
    this.entries.set(session.id, entry);
    const fire = () => this.changeEmitter.fire(entry);
    entry.onStopped(fire);
    entry.onContinued(fire);
    entry.onTerminated(fire);
    entry.onOutput((body) => this.outputEmitter.fire({ sessionId: session.id, body }));
    return entry;
  }

  get(session: vscode.DebugSession | string): SessionState | undefined {
    const id = typeof session === 'string' ? session : session.id;
    return this.entries.get(id);
  }

  all(): SessionState[] {
    return [...this.entries.values()];
  }

  findByName(name: string): SessionState | undefined {
    return this.all().find((s) => s.session.name === name);
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.dispose();
    }
    this.entries.clear();
    this.changeEmitter.dispose();
    this.outputEmitter.dispose();
    this.removedEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
