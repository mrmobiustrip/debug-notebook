# Changelog

## 0.0.1

Initial release.

- `.dbgnb` notebooks (nbformat 4 compatible) whose kernel is the active debug session; cells evaluate in the selected stack frame via DAP `evaluate`.
- Works with any debug adapter: multi-line cells, re-run, stdout/stderr routing, error outputs, per-cell staleness (which stop an output came from), interrupt via `cancel`.
- Python (debugpy): trailing expression rendered as a rich MIME bundle (pandas HTML, matplotlib PNG, `_repr_*_`, IPython formatters), size caps, chunked transport.
- JavaScript (js-debug): completion value of the cell, arrays of records as tables, objects as JSON, function source.
- Variable tree renderer with lazy `variables` requests; watch cells that re-run on every stop; send selection from the editor; session pinning; `.ipynb` support via a "Debug Session" kernel.
- Scope stub cell so language servers know the frame's names.
- Entry points: debug toolbar, Debug Console and Call Stack view titles, `Cmd+K N`, Variables/Watch context menu, `debugNotebook` launch.json property, auto-open on first stop.
