import * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { SessionRegistry, SessionState } from './SessionRegistry';
import { stackTrace } from './Dap';

export interface ExecTarget {
  session: vscode.DebugSession;
  state: SessionState;
  threadId: number;
  frameId: number;
  /** `state.stopSeq` at resolution time. */
  stopSeq: number;
  /** Human-readable `file.py:42 in func()`. */
  location: string;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Subset of `vscode.debug` the resolver reads; injectable for tests. */
export interface ActiveDebugState {
  readonly activeDebugSession: vscode.DebugSession | undefined;
  readonly activeStackItem: vscode.DebugThread | vscode.DebugStackFrame | undefined;
}

export interface NotebookPin {
  /** Session *name* (ids are not stable across launches). */
  pinnedSession?: string;
}

export const RUNNING_MESSAGE = 'The debuggee is running. Pause it or hit a breakpoint, then run the cell again.';

export class TargetResolver {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly active: ActiveDebugState = vscode.debug,
    private readonly fetchStack: typeof stackTrace = stackTrace,
  ) {}

  async resolve(pin: NotebookPin | undefined): Promise<ExecTarget> {
    const state = this.pickSession(pin);
    const { session } = state;
    if (state.terminated) {
      throw new TargetError(`Debug session "${session.name}" has ended.`);
    }

    let threadId: number | undefined;
    let frameId: number | undefined;

    const item = this.active.activeStackItem;
    if (item && item.session.id === session.id) {
      threadId = item.threadId;
      if ('frameId' in item && typeof item.frameId === 'number') {
        frameId = item.frameId;
      }
    }

    if (threadId === undefined) {
      threadId = state.anyStoppedThread();
      if (threadId === undefined) {
        throw new TargetError(RUNNING_MESSAGE);
      }
    }

    if (state.isThreadStopped(threadId) === 'running') {
      throw new TargetError(RUNNING_MESSAGE);
    }

    // One stackTrace request gives us both the top frame (if needed) and the
    // location label for the status bar.
    const frames = await this.frames(session, threadId);
    let frame: DebugProtocol.StackFrame | undefined;
    if (frameId === undefined) {
      frame = frames[0];
      if (!frame) {
        throw new TargetError(RUNNING_MESSAGE);
      }
      frameId = frame.id;
    } else {
      const wanted = frameId;
      frame = frames.find((f) => f.id === wanted);
    }

    return {
      session,
      state,
      threadId,
      frameId,
      stopSeq: state.stopSeq,
      location: frame ? describeFrame(frame) : `frame ${frameId}`,
    };
  }

  private pickSession(pin: NotebookPin | undefined): SessionState {
    if (pin?.pinnedSession) {
      const pinned = this.registry.findByName(pin.pinnedSession);
      if (!pinned) {
        throw new TargetError(`Pinned debug session "${pin.pinnedSession}" is not running.`);
      }
      return pinned;
    }
    const session = this.active.activeDebugSession;
    if (!session) {
      throw new TargetError('No active debug session. Start debugging and pause at a breakpoint.');
    }
    const state = this.registry.get(session);
    if (!state) {
      throw new TargetError(
        `Debug session "${session.name}" is not tracked (it started before this extension activated). Restart the session.`,
      );
    }
    return state;
  }

  private async frames(session: vscode.DebugSession, threadId: number): Promise<DebugProtocol.StackFrame[]> {
    try {
      const body = await this.fetchStack(session, { threadId, startFrame: 0, levels: 50 });
      return body.stackFrames ?? [];
    } catch (err) {
      // Adapters reject stackTrace for running threads with assorted messages.
      throw new TargetError(`${RUNNING_MESSAGE} (${errorMessage(err)})`);
    }
  }
}

export function describeFrame(frame: DebugProtocol.StackFrame): string {
  const file = frame.source?.path ?? frame.source?.name;
  const base = file ? file.split(/[\\/]/).pop() : undefined;
  const where = base ? `${base}:${frame.line}` : `line ${frame.line}`;
  const fn = frame.name ? ` in ${frame.name.replace(/\(\)$/, '')}()` : '';
  return `${where}${fn}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
