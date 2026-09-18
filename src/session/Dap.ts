import type * as vscode from 'vscode';
import type { DebugProtocol } from '@vscode/debugprotocol';

/**
 * Thin typed wrappers over `DebugSession.customRequest`. VS Code forwards
 * standard DAP commands unchanged; a failed response rejects with the
 * adapter's error message.
 */

export function evaluate(
  session: vscode.DebugSession,
  args: DebugProtocol.EvaluateArguments,
): Thenable<DebugProtocol.EvaluateResponse['body']> {
  return session.customRequest('evaluate', args);
}

export function stackTrace(
  session: vscode.DebugSession,
  args: DebugProtocol.StackTraceArguments,
): Thenable<DebugProtocol.StackTraceResponse['body']> {
  return session.customRequest('stackTrace', args);
}

export function variables(
  session: vscode.DebugSession,
  args: DebugProtocol.VariablesArguments,
): Thenable<DebugProtocol.VariablesResponse['body']> {
  return session.customRequest('variables', args);
}

export function completions(
  session: vscode.DebugSession,
  args: DebugProtocol.CompletionsArguments,
): Thenable<DebugProtocol.CompletionsResponse['body']> {
  return session.customRequest('completions', args);
}

export function cancel(
  session: vscode.DebugSession,
  args: DebugProtocol.CancelArguments,
): Thenable<void> {
  return session.customRequest('cancel', args);
}

export function scopes(
  session: vscode.DebugSession,
  args: DebugProtocol.ScopesArguments,
): Thenable<DebugProtocol.ScopesResponse['body']> {
  return session.customRequest('scopes', args);
}
