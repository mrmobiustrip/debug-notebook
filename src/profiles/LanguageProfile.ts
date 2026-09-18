import type * as vscode from 'vscode';
import type { ExecTarget } from '../session/TargetResolver';

export interface ScopeVariable {
  name: string;
  type?: string;
  scope: string;
}

export interface ExecCtx {
  target: ExecTarget;
  token: vscode.CancellationToken;
}

export interface LanguageProfile {
  readonly id: string;
  matches(session: vscode.DebugSession): boolean;
  /** Language id for cells created for this session. */
  cellLanguage(session: vscode.DebugSession): string;
  /**
   * What to send as `text` in DAP `completions`: the current line only
   * (debugpy ignores multi-line text) or the whole cell with line/column.
   */
  readonly completionScope?: 'line' | 'cell';
  /**
   * Source for a never-executed first cell that declares the frame's names so
   * the language server stops flagging them and can offer completions.
   */
  scopeStub?(vars: ScopeVariable[], location: string): string;
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

/** An error a profile wants rendered as a structured error output. */
export class CellError extends Error {
  constructor(
    name: string,
    message: string,
    readonly traceback?: string,
  ) {
    super(message);
    this.name = name;
  }
}
