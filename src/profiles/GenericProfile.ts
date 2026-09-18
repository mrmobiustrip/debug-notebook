import * as vscode from 'vscode';
import { evaluate } from '../session/Dap';
import { ExecCtx, LanguageProfile, languageForSessionType } from './LanguageProfile';

export const VARIABLE_MIME = 'application/vnd.debug-notebook.variable+json';

export interface VariableHandle {
  sessionId: string;
  stopSeq: number;
  variablesReference: number;
  result: string;
  type?: string;
}

/**
 * One `evaluate` with `context: 'repl'`. Works with any adapter and already
 * delivers multi-line editing, re-run, persistence and staleness.
 */
export class GenericProfile implements LanguageProfile {
  readonly id = 'generic';

  matches(): boolean {
    return true;
  }

  cellLanguage(session: vscode.DebugSession): string {
    return languageForSessionType(session.type);
  }

  async execute(ctx: ExecCtx, source: string): Promise<vscode.NotebookCellOutput[]> {
    const { session, frameId, stopSeq } = ctx.target;
    const body = await evaluate(session, { expression: source, frameId, context: 'repl' });
    if (ctx.token.isCancellationRequested) {
      return [];
    }
    const items: vscode.NotebookCellOutputItem[] = [];
    // Adapters commonly return '' or 'None'-like results for statements; keep
    // the cell output empty in that case rather than showing a blank block.
    if (body.result !== undefined && body.result !== '') {
      items.push(vscode.NotebookCellOutputItem.text(body.result, 'text/plain'));
    }
    if (body.variablesReference > 0) {
      const handle: VariableHandle = {
        sessionId: session.id,
        stopSeq,
        variablesReference: body.variablesReference,
        result: body.result,
        type: body.type,
      };
      items.push(vscode.NotebookCellOutputItem.json(handle, VARIABLE_MIME));
    }
    return items.length ? [new vscode.NotebookCellOutput(items)] : [];
  }
}
