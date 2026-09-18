/**
 * Pure staleness logic, kept free of vscode so it unit-tests trivially.
 */

/** Written to `cell.metadata.debugNotebookRun` after every execution. Transient. */
export interface RunMetadata {
  sessionRunId: string;
  sessionName: string;
  stopSeq: number;
  location: string;
}

export const RUN_METADATA_KEY = 'debugNotebookRun';

export type RunStatus =
  | { kind: 'current'; text: string; tooltip: string }
  | { kind: 'stale'; text: string; tooltip: string; stopsAgo: number }
  | { kind: 'gone'; text: string; tooltip: string };

export interface LiveSession {
  stopSeq: number;
  terminated: boolean;
}

export function describeRun(meta: RunMetadata, live: LiveSession | undefined): RunStatus {
  if (!live || live.terminated) {
    return {
      kind: 'gone',
      text: '○ from a previous session',
      tooltip: `Ran at ${meta.location} in debug session "${meta.sessionName}", which has ended.`,
    };
  }
  const stopsAgo = live.stopSeq - meta.stopSeq;
  if (stopsAgo <= 0) {
    return {
      kind: 'current',
      text: `● ${meta.location}`,
      tooltip: `Evaluated at ${meta.location} at the current stop.`,
    };
  }
  const n = stopsAgo === 1 ? '1 stop ago' : `${stopsAgo} stops ago`;
  return {
    kind: 'stale',
    stopsAgo,
    text: `○ stale — ran at ${meta.location}, ${n}`,
    tooltip: `The debuggee has stopped ${n} since this output was produced. It may no longer reflect the current state.`,
  };
}

export function readRunMetadata(metadata: Readonly<Record<string, unknown>> | undefined): RunMetadata | undefined {
  const raw = metadata?.[RUN_METADATA_KEY];
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Partial<RunMetadata>;
  if (typeof m.sessionRunId !== 'string' || typeof m.stopSeq !== 'number') {
    return undefined;
  }
  return {
    sessionRunId: m.sessionRunId,
    sessionName: typeof m.sessionName === 'string' ? m.sessionName : '',
    stopSeq: m.stopSeq,
    location: typeof m.location === 'string' ? m.location : '',
  };
}
