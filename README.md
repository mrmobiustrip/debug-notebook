# Debug Notebook

A VS Code notebook whose "kernel" is the active debug session. Cells are evaluated in the currently selected stack frame of a paused process via the Debug Adapter Protocol `evaluate` request. No Jupyter, no kernel, no changes to how sessions are launched.

Design: [docs/design.md](docs/design.md). This is **Phase 1**: the generic MVP that works with any debug adapter.

## What works (Phase 1)

- `.dbgnb` notebook type, nbformat-4 compatible (rename to `.ipynb` to open elsewhere).
- Controller that sends cell source to the active session with `context: 'repl'`, targeting whatever frame is selected in the Call Stack view.
- stdout/stderr from the debuggee attributed to the running cell.
- Adapter errors rendered as error outputs.
- Per-cell status bar showing the frame the output came from and whether it is stale (the debuggee has stopped again since).
- Fast failure when the process is running instead of paused.
- Interrupt via DAP `cancel` when the adapter supports it.
- Commands: **Debug Notebook: Open Scratch Notebook**, **Debug Notebook: Re-run Stale Cells**.

## Try it

```bash
npm install
npm run build
```

Then press F5 (**Run Extension**). The dev host opens the `fixtures/` folder.

Works the same in VS Code forks (Antigravity IDE, Cursor, VSCodium). From a shell, using Antigravity as the example:

```bash
"/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" --extensionDevelopmentPath="$PWD" "$PWD/fixtures"
```

If the IDE is already running, the currently focused window reloads as the dev host. `fixtures/scratch.dbgnb` is a ready-made notebook to open once paused.

Walkthrough:

1. Open `sample.py`, set a breakpoint on the `return total` line, start **Python: sample.py**.
2. Run **Debug Notebook: Open Scratch Notebook** from the command palette.
3. In a cell, run something multi-line, e.g.

   ```python
   for k, v in sorted(locals().items()):
       print(k, '=', v)
   ```

   Then in a second cell: `total * 2` (prints `200`).

   Phase 1 caveat: debugpy runs a multi-line cell as statements and drops the
   value of a trailing expression, so put an expression you want to see on its
   own cell. Phase 2 fixes this with the Python helper.

4. Click a different frame in the Call Stack view and re-run: the scope changes.
5. Step over a line: the cell status flips to `○ stale — ran at sample.py:11 in compute(), 1 stop ago`.

The same flow works with **Node: sample.js** under js-debug.

## Development

```bash
npm run typecheck
npm test          # vitest unit tests (vscode API mocked in test/vscode-mock.ts)
npm run watch
```

## Layout

```
src/
  extension.ts            activation, commands
  session/
    SessionRegistry.ts    DebugAdapterTracker per session; stop state, capabilities, events
    TargetResolver.ts     picks (session, thread, frame) for an execution
    Dap.ts                typed customRequest wrappers
  notebook/
    Serializer.ts         .dbgnb <-> NotebookData (nbformat 4)
    Controller.ts         serial execution queue, interrupt, run metadata
    OutputRouter.ts       attributes DAP output events to the running cell
    Staleness.ts          pure staleness logic
    StatusBar.ts          cell status bar items
  profiles/
    LanguageProfile.ts    interface + session type -> language map
    GenericProfile.ts     plain evaluate; any adapter
fixtures/                 sample programs + launch configs for manual testing
test/                     vitest unit tests
```

## Not yet (later phases)

- Python rich outputs (DataFrames, matplotlib) via helper injection: Phase 2.
- DAP completions: Phase 2.
- Variable tree renderer, watch cells, send-selection, session pinning commands: Phase 3.
