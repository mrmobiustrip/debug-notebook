# Debug Notebook

A VS Code notebook whose "kernel" is the active debug session. Cells are evaluated in the currently selected stack frame of a paused process via the Debug Adapter Protocol `evaluate` request. No Jupyter, no kernel, no changes to how sessions are launched.

Design: [docs/design.md](docs/design.md). This is **Phase 1**: the generic MVP that works with any debug adapter.

## What works (Phases 1-3)

- `.dbgnb` notebook type, nbformat-4 compatible (rename to `.ipynb` to open elsewhere).
- Controller that sends cell source to the active session with `context: 'repl'`, targeting whatever frame is selected in the Call Stack view.
- stdout/stderr from the debuggee attributed to the running cell.
- Adapter errors rendered as error outputs.
- Per-cell status bar showing the frame the output came from and whether it is stale (the debuggee has stopped again since).
- Fast failure when the process is running instead of paused.
- Interrupt via DAP `cancel` when the adapter supports it.
- Commands: **Debug Notebook: Open Scratch Notebook**, **Debug Notebook: Re-run Stale Cells**.
- **Python (debugpy)**: a trailing expression renders as a rich MIME bundle (pandas `DataFrame` as an HTML table, anything with `_repr_html_`/`_repr_png_`/`_repr_mimebundle_`, IPython formatters when IPython is importable in the debuggee). Open matplotlib figures are captured as PNG after every cell and closed. End a cell with `;` to suppress the result. Results over `debugNotebook.python.maxBundleBytes` (10 MB) drop their largest items.
- Runtime completions from the adapter (`.` trigger) for the selected frame, ranked above language-server suggestions.
- **Variable tree**: the result object gets an expandable tree (lazy DAP `variables` requests, paged for big arrays). Trees freeze once the debuggee moves on, since variable references die on resume.
- **Watch cells**: toggle the eye icon on a cell and it re-runs on every stop, so a `df.head()` or a plot tracks stepping. Side effects repeat each time; the UI warns once.
- **Send selection**: `Cmd+Alt+Enter` (`Ctrl+Alt+Enter`) or the editor context menu sends the selection (or current line) to the debug notebook as a new cell and runs it.
- **Pinning**: the pin button in the notebook toolbar ties a notebook to a named session; unpinned notebooks follow the active one.

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

   Locals print as stdout; `total * 2` shows `200` as the result. Try

   ```python
   import pandas as pd, matplotlib.pyplot as plt
   df = pd.DataFrame({'i': range(len(items)), 'item': items, 'weighted': [x * (i + 1) for i, x in enumerate(items)]})
   plt.plot(df['weighted']); df
   ```

   if pandas/matplotlib are importable in the debuggee (`fixtures/.vscode/settings.json` decides which interpreter runs).

4. Click a different frame in the Call Stack view and re-run: the scope changes.
5. Step over a line: the cell status flips to `○ stale — ran at sample.py:11 in compute(), 1 stop ago`.

The same flow works with **Node: sample.js** under js-debug.

## Development

```bash
npm run typecheck
npm test          # vitest unit tests (vscode API mocked in test/vscode-mock.ts) + Python helper tests
npm run spike     # scripts/dap_spike.py: measures debugpy behaviours the Python profile relies on
npm run watch
```

How the Python profile works, and what was measured against debugpy 1.8.20: `docs/design.md` §6 and the header of `src/profiles/PythonProfile.ts`.

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
    Completions.ts        DAP completions provider
    VariableService.ts    answers the tree renderer's lazy variables requests
    WatchScheduler.ts     re-runs autoRun cells on every stop
  renderer/
    index.ts              variable tree renderer (webview bundle: dist/renderer.js)
    protocol.ts           renderer <-> extension messages
  profiles/
    LanguageProfile.ts    interface + session type -> language map
    GenericProfile.ts     plain evaluate; any adapter
    PythonProfile.ts      debugpy: helper injection, split/bundle, chunked fetch
    python/helper.py      injected into the debuggee as module __dbgnb (pure parse/format)
fixtures/                 sample programs + launch configs for manual testing
scripts/dap_spike.py      standalone DAP client that probes debugpy
test/                     vitest unit tests
```

## Not yet (Phase 4)

- js-debug profile with rich object previews.
- A second controller on the `jupyter-notebook` type so `.ipynb` files can run against a paused process.
