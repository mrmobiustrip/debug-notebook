/**
 * Pure staleness logic, kept free of vscode so it unit-tests trivially.
 */

/** Recorded per cell after every execution (see RunStore). */
export interface RunMetadata {
  notebookUri: string;
  sessionRunId: string;
  sessionName: string;
  stopSeq: number;
  location: string;
}

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
