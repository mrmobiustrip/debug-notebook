# Debug Notebook — VS Code Extension Design

Working name: `debug-notebook`. A notebook UI whose "kernel" is the active debug session. Cells are evaluated in the currently selected stack frame of a paused process, with Jupyter-style rich outputs, editable history, and re-runnable cells.

## 1. Problem

The Debug Console is a single-line REPL with append-only scrollback:

- Multi-line code is painful to write and impossible to edit after the fact.
- No re-run; history is up-arrow only.
- Output is plain text. DataFrames, images, plots, and nested objects are unreadable.
- Nothing persists. Useful inspection snippets are retyped every session.
- No indication of which frame/stop a given output belongs to.

## 2. Core idea

VS Code's Notebook API separates the document (serializer) from execution (controller). A `NotebookController` is just a callback that receives cells and produces outputs. We implement one whose execute handler sends cell source to the debug adapter via the DAP `evaluate` request instead of to a Jupyter kernel.

```
cell source ──► NotebookController ──► DebugSession.customRequest('evaluate', {expression, frameId, context:'repl'})
                                          │
cell outputs ◄── OutputRouter ◄───────────┴── evaluate response  +  DAP 'output' events (stdout/stderr)
```

No dependency on the Jupyter extension. No debug adapter is implemented or modified.

## 3. Non-goals

- Not a Jupyter replacement; there is no kernel and no state beyond the debuggee's own.
- Not a debug adapter, and no changes to how sessions are launched.
- No attempt to hide output from the built-in Debug Console (not possible via API; both will show stdout).

## 4. Key VS Code / DAP surfaces

| Need | API |
|---|---|
| Notebook document type | `contributes.notebooks` + `workspace.registerNotebookSerializer` |
| Execution | `notebooks.createNotebookController(id, notebookType, label)`, `executeHandler`, `interruptHandler` |
| Current session + frame | `debug.activeDebugSession`, `debug.activeStackItem` (`DebugStackFrame` → `session`, `threadId`, `frameId`), `debug.onDidChangeActiveStackItem` (VS Code ≥ 1.90) |
| Send DAP requests | `DebugSession.customRequest(command, args)` — works for standard requests: `evaluate`, `completions`, `variables`, `cancel` |
| Observe DAP traffic | `debug.registerDebugAdapterTrackerFactory('*', …)` — the only way to see `stopped` / `continued` / `output` events and the `initialize` response (capabilities) |
| Cell status | `notebooks.registerNotebookCellStatusBarItemProvider` |
| Completions | `languages.registerCompletionItemProvider` on `{ notebookType: 'debug-notebook' }` |
| Custom output UI | `contributes.notebookRenderer` + `notebooks.createRendererMessaging` |

## 5. Architecture

```
src/
  extension.ts            activate: wire everything, register commands
  session/
    SessionRegistry.ts    tracker factory; per-session state + event bus
    TargetResolver.ts     resolves (session, threadId, frameId) for an execution
    Dap.ts                typed wrappers: evaluate, completions, variables, cancel
  notebook/
    Serializer.ts         .dbgnb <-> NotebookData
    Controller.ts         execution queue, cell lifecycle, interrupt
    OutputRouter.ts       attributes DAP output events to the running cell
    StatusBar.ts          cell status items (target frame, staleness)
    Completions.ts        DAP completions provider
  profiles/
    LanguageProfile.ts    interface
    GenericProfile.ts     plain evaluate; works with any adapter
    PythonProfile.ts      debugpy: helper injection, rich MIME bundles
    python/helper.py      source injected into the debuggee
  renderer/               (phase 3) variable tree renderer, separate webpack target
```

### 5.1 SessionRegistry

One `DebugAdapterTracker` per session. Maintains:

```ts
interface SessionState {
  session: vscode.DebugSession;
  capabilities: DebugProtocol.Capabilities;   // from 'initialize' response
  stoppedThreads: Set<number>;                // 'stopped' adds, 'continued' removes (honour allThreadsStopped/allThreadsContinued)
  stopSeq: number;                            // increments on every 'stopped' event
  onOutput: Event<DebugProtocol.OutputEvent['body']>;
  onStopped / onContinued / onTerminated
}
```

`stopSeq` is the basis for staleness tracking (§5.5). Capabilities gate features: `supportsCompletionsRequest`, `supportsCancelRequest`, `supportsEvaluateForHovers` is irrelevant, `supportsClipboardContext` is useful (see §6.4).

### 5.2 TargetResolver

Default target = `debug.activeStackItem` if it is a `DebugStackFrame`; this follows whatever the user clicked in the Call Stack view, matching Debug Console semantics. If it is a `DebugThread`, issue `stackTrace` for that thread and take the top frame. If the thread is not in `stoppedThreads`, fail the cell fast with a clear message ("process is running — pause or hit a breakpoint") instead of sending an evaluate that will hang or error obscurely.

Multi-session: a notebook may be pinned to a session (stored in notebook metadata by session name, since ids are not stable across runs). Unpinned notebooks follow `activeDebugSession`.

### 5.3 Controller

- One controller for notebook type `debug-notebook`. Being the only controller for the type, it is auto-selected: no kernel picker friction.
- `supportsExecutionOrder = true`; counter per notebook.
- Executions are strictly serial per session (the debuggee is paused on one thread; concurrent evaluates are meaningless and some adapters deadlock).
- Cell language is set from session type via a small map (`debugpy`/`python` → `python`, `pwa-node`/`pwa-chrome` → `javascript`, `lldb`/`cppdbg` → `cpp`, …). `supportedLanguages` left undefined so any cell language runs.
- Profile selection by `session.type`; fall back to `GenericProfile`.

Execution flow:

1. `createNotebookCellExecution(cell)`, `start()`, `clearOutput()`.
2. Resolve target. Record `{ stopSeq, source path, line, function name }` into the execution context.
3. `OutputRouter.begin(execution)`.
4. `profile.execute(ctx, source)` → yields `NotebookCellOutput[]` (result and/or error).
5. `OutputRouter.end()` after a grace window (§6.2).
6. Write staleness metadata into cell metadata; `end(success)`.

Interrupt: if `supportsCancelRequest`, send `cancel` with the evaluate's request seq (obtain the seq from the tracker's `onWillReceiveMessage`, since `customRequest` doesn't expose it). Otherwise mark the execution abandoned, end it as failed, and ignore the late response. Do not send `pause`; the thread is already paused and the evaluate is running inside it.

Edge case: an evaluate can itself hit a breakpoint or raise a `stopped` event. Treat a `stopped` event during an in-flight evaluate as informational; do not bump staleness for the running cell until it finishes.

### 5.4 LanguageProfile

```ts
interface LanguageProfile {
  matches(session: vscode.DebugSession): boolean;
  cellLanguage: string;
  onSessionReady?(ctx: SessionCtx): Promise<void>;          // e.g. inject helper lazily on first execute
  execute(ctx: ExecCtx, source: string): Promise<NotebookCellOutput[]>;
}
```

**GenericProfile**: one `evaluate` with `context: 'repl'`. On success, emit `text/plain` with `result`; if `variablesReference > 0`, also emit `application/vnd.debug-notebook.variable+json` `{ sessionId, variablesReference, result, type }` for the tree renderer (phase 3; until then text only). On failure, `NotebookCellOutputItem.error({ name, message })`. This alone delivers multi-line editing, re-run, persistence, and staleness for every adapter.

**PythonProfile**: see §6.

### 5.5 Staleness

Every output is a snapshot of a frame at a stop. After step/continue it may be wrong. Store in cell metadata: `{ stopSeq, sessionRunId, location: "foo.py:42 in bar()" }`. The cell status bar provider renders:

- current: `● foo.py:42 in bar()`
- stale: `○ stale — ran at foo.py:42, 3 stops ago`
- session gone: `○ from a previous session`

Refresh via the provider's `onDidChangeCellStatusBarItems` on every `stopped`/`continued`/`terminated`.

**Watch cells (phase 3)**: cell metadata flag `autoRun: true`, toggled from a cell toolbar command. On each `stopped` event, after `activeStackItem` settles (debounce ~100 ms), re-execute flagged cells in document order. This turns the notebook into a rich watch window, e.g. a DataFrame `.head()` or a plot that refreshes on every step.

### 5.6 Serializer

File extension `.dbgnb`. Persist as nbformat-4-compatible JSON (cells, outputs, metadata) so a file can be renamed to `.ipynb` and opened elsewhere. Extension-specific fields live under `metadata.debugNotebook`. Transient fields (`stopSeq`, staleness) are declared in `transientCellMetadata` / cleared on load so they don't dirty the document or survive sessions.

Scratch usage: `Debug Notebook: Open Scratch` creates an untitled `debug-notebook` document beside the editor. Setting `debugNotebook.openOnSessionStart`: `never | scratch | lastUsed`.

### 5.7 Completions

If `supportsCompletionsRequest`: on trigger in a cell of our notebook type, send DAP `completions` with `{ text: <full cell text>, line, column, frameId }` (send the whole cell with line/column, not just the current line, and verify per-adapter; some only handle single-line `text`, in which case send the current line). Map `CompletionItem.type` to `CompletionItemKind`. These merge with whatever the language server offers; runtime completions get a `sortText` prefix so they rank first, since they reflect the actual frame.

### 5.8 Commands

- `debugNotebook.openScratch`
- `debugNotebook.sendSelection` — editor selection → new cell at end of the active debug notebook, executed immediately (editor context menu + keybinding, enabled `when: inDebugMode`)
- `debugNotebook.pinSession` / `unpinSession`
- `debugNotebook.toggleAutoRun` (cell toolbar)
- `debugNotebook.rerunStale`

## 6. Python profile (debugpy) — mechanism

This is where the "Jupyter" feel comes from, and where the real design constraints are.

### 6.1 Scoping constraint drives the design

The obvious approach, `evaluate("__helper.run(src, globals(), locals())")`, is wrong: `exec` inside a helper with a `locals()` snapshot does not write assignments back to the paused function frame (pre-3.13 fast-locals semantics). pydevd already solves this for its own `repl` evaluates (it execs in the frame and syncs locals). So: **let the adapter run all user code natively; the helper only does pure functions** (parsing and formatting). User code never executes inside the helper's scope.

Per-cell sequence:

1. `evaluate: H.split(<src literal>)` → JSON `{ body: str, last_expr: str | null }`. Uses `ast.parse`; if the final node is `ast.Expr` and the source doesn't end in `;` (IPython's suppress convention), split it off using node line/col offsets.
2. If `body`: `evaluate(body, context:'repl')`. Native exec in frame, correct scoping, assignments persist. stdout arrives via `output` events.
3. If `last_expr`: `evaluate: H.bundle(<last_expr>)`. The expression is evaluated by the debugger in the frame; only the resulting object is passed into the helper, which returns a MIME bundle.
4. `evaluate: H.figures()` → any open matplotlib figures as PNG, only if `'matplotlib.pyplot' in sys.modules`. Render, then close them so they aren't re-emitted by the next cell.

where `H` is `__import__('__dbgnb')`. Source literals are passed as `base64.b64decode('…').decode()` to sidestep all quoting/escaping issues.

### 6.2 Helper injection

On first execute per session (and again if `H` lookup fails, e.g. after a process restart under the same session), one `repl` evaluate that builds a module object from `helper.py` source via `types.ModuleType` + `exec` into its `__dict__`, and registers it as `sys.modules['__dbgnb']`. Nothing is added to the user's frame or module namespaces.

Helper API:

```python
split(src) -> str                      # JSON
bundle(obj) -> str                     # JSON handle {id, length}
figures() -> str                       # JSON handle
read(id, offset, n) -> str             # base64 slice
drop(id)
```

`bundle` formatting order: `IPython.core.formatters.DisplayFormatter().format(obj)` if IPython is importable (gets pandas/PIL/plotly/sympy for free); otherwise probe `_repr_mimebundle_`, `_repr_html_`, `_repr_png_`, `_repr_jpeg_`, `_repr_svg_`, `_repr_markdown_`, `_repr_json_`, `_repr_latex_`; always include `text/plain` = `repr(obj)`. Every formatter call is wrapped in try/except; a broken `_repr_html_` must not fail the cell. Binary MIME values are base64 (nbformat convention). Cap total bundle size (setting, default 10 MB); over the cap, drop the largest non-text items and add a text note.

### 6.3 Output correlation

`output` events carry no request id. Attribution rule: events with category `stdout`/`stderr` received while an execution is open belong to that cell, appended as `NotebookCellOutputItem.stdout/stderr` to a single stream output (coalesce; don't create one output per event). debugpy's output redirection is asynchronous relative to the evaluate response, so ordering is not guaranteed: keep the router open for a grace window after the final response (default 75 ms, setting) before `end()`. Events with category `console`/`telemetry`/`important` are ignored. Output arriving outside any execution is dropped (it's still in the Debug Console).

### 6.4 Result truncation — chunked fetch

Adapters may truncate long evaluate results (pydevd has string-length limits that vary by `context`; **verify actual behaviour for `repl` and `clipboard` contexts early** — it determines chunk size). Do not rely on a large payload surviving a single evaluate. `bundle()` stores the serialized JSON debuggee-side in `H._pending[id]` and returns only `{id, length}`. The extension pulls it with repeated `H.read(id, off, n)` calls (base64, so the result is quote/escape-safe once the surrounding repr quotes are stripped), then `H.drop(id)`. Chunk size starts conservative (e.g. 32 KB) and is a constant to tune after the verification above. This is transport-agnostic: works for remote attach, containers, SSH, where a temp-file side channel would not.

### 6.5 Mapping to notebook outputs

Bundle → one `NotebookCellOutput` with one `NotebookCellOutputItem` per MIME type; VS Code picks the richest renderer it has (`text/html`, `image/png`, `image/svg+xml`, `text/markdown`, `application/json`, `text/latex`, … are built in). Errors: evaluate `success:false` → `NotebookCellOutputItem.error`; include the adapter's message verbatim (debugpy puts the traceback there).

## 7. Phases

**Phase 1 — generic MVP (any adapter)**
Notebook type + serializer, controller, SessionRegistry/tracker, TargetResolver, GenericProfile, OutputRouter, error outputs, staleness status bar, `openScratch`. Exit criterion: multi-line cells run against debugpy and js-debug paused at a breakpoint; frame selection in Call Stack changes the evaluation scope; stepping marks outputs stale.

**Phase 2 — Python rich output**
Helper injection, split/bundle/figures, chunked fetch, size caps. DAP completions. Exit: `df.head()` renders as HTML table, `plt.plot(...)` renders inline, a 5 MB image round-trips.

**Phase 3 — inspection UX**
Variable-tree renderer (lazy `variables` requests via renderer messaging; handles go invalid on resume, so the renderer must degrade to the static text once `stopSeq` changes). Watch cells. `sendSelection`. Session pinning.

**Phase 4 — reach**
js-debug profile (rich object previews). Optional second controller registered on the `jupyter-notebook` type so existing `.ipynb` files can be executed against a paused process ("Debug Session" appears in their kernel picker; use `updateNotebookAffinity` rather than fighting the Jupyter extension for default).

## 8. Testing

- **Unit**: OutputRouter, TargetResolver, staleness logic, chunk reassembly, serializer round-trip — against a fake `SessionState`/DAP stub. `helper.py` tested directly with pytest (split edge cases: trailing `;`, last statement not an expression, decorators, multi-line expressions, syntax errors; bundle with throwing `_repr_html_`).
- **Integration** (`@vscode/test-electron`): launch a fixture Python script under debugpy with a breakpoint, open a debug notebook, execute cells, assert on `cell.outputs` MIME types. Cover: assignment in a function frame persists to the next cell; frame switch changes scope; running-thread fast-fail; session restart re-injects helper.
- A second fixture using `vscode-mock-debug` keeps GenericProfile honest against a non-Python adapter.

## 9. Risks / items to verify first

1. **debugpy multi-line `repl` evaluate**: confirm exec fallback and locals write-back behave as assumed across Python 3.9–3.13 (3.13 changed `f_locals` semantics via PEP 667).
2. **Result truncation limits** per context (§6.4). Determines chunk size and whether `clipboard` context is a cheaper path when `supportsClipboardContext` is true.
3. **Output/response ordering** in debugpy; tune or replace the grace window if it proves flaky. A fallback is a sentinel: the helper prints a unique marker to stdout at the end and the router closes on seeing it.
4. **Request seq for `cancel`**: confirm the tracker reliably sees the outgoing evaluate before the response so the seq can be matched to the execution.
5. **Completions `text` semantics** differ across adapters (§5.7).
6. Evaluating with side effects in a paused process is as dangerous as it is in the Debug Console. Watch cells amplify this (they re-run on every stop); the toggle UI should say so.

## 10. Packaging

TypeScript, esbuild, two bundles (extension host; renderer in phase 3). `engines.vscode: ^1.90.0`. Activation: `onNotebook:debug-notebook`, `onDebug`. No runtime npm dependencies expected beyond `@vscode/debugprotocol` types (dev-only). `helper.py` is bundled as a string asset.
