import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { WatchScheduler, isAutoRun } from '../src/notebook/WatchScheduler';
import { SessionRegistry } from '../src/session/SessionRegistry';
import { attach, makeSession, stopped, continued } from './helpers';

function cell(autoRun: boolean, index: number) {
  return { index, kind: vscode.NotebookCellKind.Code, metadata: autoRun ? { debugNotebook: { autoRun: true } } : {} };
}

function notebook(cells: ReturnType<typeof cell>[]) {
  return { getCells: () => cells } as unknown as vscode.NotebookDocument;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WatchScheduler', () => {
  it('re-runs autoRun cells after a stop, debounced', async () => {
    const registry = new SessionRegistry();
    const { tracker } = attach(registry, makeSession());
    const nb = notebook([cell(true, 0), cell(false, 1), cell(true, 2)]);
    const runs: number[][] = [];
    let busy = false;
    new WatchScheduler(
      registry,
      {
        notebooksFor: () => [nb],
        isBusy: () => busy,
        execute: async (cells) => {
          runs.push(cells.map((c) => c.index));
        },
      },
      10,
    );
    stopped(tracker, 1);
    stopped(tracker, 1); // second stop within the debounce window collapses
    await tick(30);
    expect(runs).toEqual([[0, 2]]);

    continued(tracker, 1); // no run on continue
    await tick(30);
    expect(runs).toHaveLength(1);

    busy = true; // stop caused by our own evaluate: ignored
    stopped(tracker, 1);
    await tick(30);
    expect(runs).toHaveLength(1);
  });

  it('isAutoRun reads the metadata flag', () => {
    expect(isAutoRun(cell(true, 0))).toBe(true);
    expect(isAutoRun(cell(false, 0))).toBe(false);
  });
});
