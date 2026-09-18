import type * as vscode from 'vscode';
import type { ExecTarget } from '../session/TargetResolver';

export interface ExecCtx {
  target: ExecTarget;
  token: vscode.CancellationToken;
}

export interface LanguageProfile {
  readonly id: string;
  matches(session: vscode.DebugSession): boolean;
  /** Language id for cells created for this session. */
  cellLanguage(session: vscode.DebugSession): string;
  onSessionReady?(target: ExecTarget): Promise<void>;
  /**
   * Run cell source in the target frame. Returns result outputs on success.
   * Throws on adapter failure; the controller converts the error to an error
   * output. stdout/stderr is routed separately by the OutputRouter.
   */
  execute(ctx: ExecCtx, source: string): Promise<vscode.NotebookCellOutput[]>;
}

/** Best-effort session type -> cell language id. Unknown types fall back to plaintext. */
const LANGUAGE_BY_SESSION_TYPE: Record<string, string> = {
  python: 'python',
  debugpy: 'python',
  node: 'javascript',
  'pwa-node': 'javascript',
  'node-terminal': 'javascript',
  chrome: 'javascript',
  'pwa-chrome': 'javascript',
  msedge: 'javascript',
  'pwa-msedge': 'javascript',
  'pwa-extensionHost': 'javascript',
  extensionHost: 'javascript',
  lldb: 'cpp',
  cppdbg: 'cpp',
  cppvsdbg: 'cpp',
  go: 'go',
  delve: 'go',
  java: 'java',
  coreclr: 'csharp',
  clr: 'csharp',
  dart: 'dart',
  php: 'php',
  ruby: 'ruby',
  rdbg: 'ruby',
  'lldb-dap': 'cpp',
  codelldb: 'rust',
  mock: 'plaintext',
};

export function languageForSessionType(type: string): string {
  return LANGUAGE_BY_SESSION_TYPE[type] ?? 'plaintext';
}
