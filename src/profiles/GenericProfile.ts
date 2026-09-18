import * as vscode from 'vscode';
import { evaluate } from '../session/Dap';
import { ExecCtx, LanguageProfile, languageForSessionType } from './LanguageProfile';

import { VARIABLE_MIME, VariableHandle } from '../renderer/protocol';

export { VARIABLE_MIME };

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
    const { session, frameId, state } = ctx.target;
    const body = await evaluate(session, { expression: source, frameId, context: 'repl' });
    const stopSeq = state.stopSeq;
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
        indexedVariables: body.indexedVariables,
        namedVariables: body.namedVariables,
      };
      items.push(vscode.NotebookCellOutputItem.json(handle, VARIABLE_MIME));
    }
    return items.length ? [new vscode.NotebookCellOutput(items)] : [];
  }
}
