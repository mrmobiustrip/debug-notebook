/** Messages between the variable-tree renderer (webview) and the extension host. */

export const RENDERER_ID = 'debug-notebook.variable';
export const VARIABLE_MIME = 'application/vnd.debug-notebook.variable+json';

/** Payload of a `VARIABLE_MIME` output item. */
export interface VariableHandle {
  sessionId: string;
  stopSeq: number;
  variablesReference: number;
  result: string;
  type?: string;
  indexedVariables?: number;
  namedVariables?: number;
}

export interface VariableNode {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  indexedVariables?: number;
  namedVariables?: number;
}

export interface VariablesRequest {
  type: 'variables';
  requestId: number;
  sessionId: string;
  stopSeq: number;
  variablesReference: number;
  start?: number;
  count?: number;
}

export type VariablesResponse =
  | { type: 'variables'; requestId: number; ok: true; variables: VariableNode[] }
  | { type: 'variables'; requestId: number; ok: false; reason: 'stale' | 'gone' | 'running' | 'error'; message?: string };

/** Broadcast when a session stops again or ends, so open trees can freeze. */
export interface InvalidateMessage {
  type: 'invalidate';
  sessionId: string;
  stopSeq: number;
  gone: boolean;
}

export type ToExtension = VariablesRequest;
export type ToRenderer = VariablesResponse | InvalidateMessage;

/** Ask for at most this many children per page. */
export const PAGE_SIZE = 100;
