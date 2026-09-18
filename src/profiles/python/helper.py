"""
Debug Notebook helper. Injected into the debuggee as module ``__dbgnb``.

Only pure functions live here: parsing cell source and formatting result
objects. User code is never executed inside this module; the debug adapter
evaluates it natively in the paused frame so scoping and locals write-back
behave exactly as in the Debug Console.

Every public function returns a *packed* string ``"<id>:<length>:<inline>"``.
The payload is base64(JSON). When it fits in ``inline_limit`` it is returned
inline with id 0; otherwise it is parked in ``_pending`` and the extension pulls
it with ``read(id, offset, n)`` and releases it with ``drop(id)``. This keeps
results within the adapter's per-evaluate size limits and works over any
transport (remote attach, containers).
"""

import ast
import base64
import io
import json
import sys
import textwrap
import traceback

VERSION = 1

INLINE_LIMIT = 60000
DEFAULT_MAX_BYTES = 10 * 1024 * 1024

_pending = {}
_next_id = 0
_ipython_formatter = None
_ipython_probed = False

_BINARY_MIMES = ("image/png", "image/jpeg", "image/gif", "application/pdf")
_REPR_METHODS = (
    ("_repr_mimebundle_", None),
    ("_repr_html_", "text/html"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_latex_", "text/latex"),
    ("_repr_json_", "application/json"),
)


# --- transport ---------------------------------------------------------------


def _pack(payload, inline_limit=INLINE_LIMIT):
    global _next_id
    data = base64.b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    if len(data) <= inline_limit:
        return "0:%d:%s" % (len(data), data)
    _next_id += 1
    _pending[_next_id] = data
    return "%d:%d:" % (_next_id, len(data))


def read(handle_id, offset, n):
    """Return a slice of a parked payload (base64 text, no quoting hazards)."""
    return _pending[handle_id][offset:offset + n]


def drop(handle_id):
    _pending.pop(handle_id, None)


def _decode_src(src_b64):
    return base64.b64decode(src_b64).decode("utf-8")


# --- split -------------------------------------------------------------------


def split(src_b64, inline_limit=INLINE_LIMIT):
    """Split cell source into leading statements and a trailing expression."""
    return _pack(_split(_decode_src(src_b64)), inline_limit)


def _split(src):
    """
    Returns {"body": str | None, "last_expr": str | None}.

    ``last_expr`` is set when the final top-level statement is a bare
    expression and the cell does not end with ``;`` (IPython's suppression
    convention). On a SyntaxError the whole source is returned as ``body`` so
    the adapter reports the error natively.
    """
    src = textwrap.dedent(src)
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return {"body": src, "last_expr": None}
    if not tree.body:
        return {"body": None, "last_expr": None}
    last = tree.body[-1]
    if not isinstance(last, ast.Expr):
        return {"body": src, "last_expr": None}
    lines = src.splitlines(keepends=True)
    trailing = lines[last.end_lineno - 1][last.end_col_offset:] if last.end_lineno - 1 < len(lines) else ""
    if trailing.lstrip().startswith(";"):
        return {"body": src, "last_expr": None}
    expr_src = ast.get_source_segment(src, last.value)
    if expr_src is None:
        return {"body": src, "last_expr": None}
    body = "".join(lines[: last.lineno - 1]) + lines[last.lineno - 1][: last.col_offset]
    if not body.strip():
        body = None
    return {"body": body, "last_expr": expr_src}


# --- bundle ------------------------------------------------------------------


def bundle(*args, **kwargs):
    """
    ``bundle(obj, ...)`` formats ``obj`` as a MIME bundle; ``bundle()`` formats
    nothing. Either way, any open matplotlib figures are appended as PNG and
    closed. Returns a packed ``{"outputs": [ {mime: data, ...}, ... ]}``.
    """
    max_bytes = kwargs.get("max_bytes", DEFAULT_MAX_BYTES)
    inline_limit = kwargs.get("inline_limit", INLINE_LIMIT)
    outputs = []
    if args:
        outputs.append(_format(args[0], max_bytes))
    outputs.extend(_figures(max_bytes))
    return _pack({"outputs": outputs}, inline_limit)


def _get_ipython_formatter():
    global _ipython_formatter, _ipython_probed
    if _ipython_probed:
        return _ipython_formatter
    _ipython_probed = True
    try:
        from IPython.core.formatters import DisplayFormatter  # type: ignore

        _ipython_formatter = DisplayFormatter()
    except Exception:
        _ipython_formatter = None
    return _ipython_formatter


def _encode(mime, value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except Exception:
        return repr(value)


def _format(obj, max_bytes=DEFAULT_MAX_BYTES):
    data = {}
    fmt = _get_ipython_formatter()
    if fmt is not None:
        try:
            formatted, _metadata = fmt.format(obj)
            for mime, value in (formatted or {}).items():
                if value is not None:
                    data[mime] = _encode(mime, value)
        except Exception:
            data = {}
    if not any(m != "text/plain" for m in data):
        for method, mime in _REPR_METHODS:
            try:
                fn = getattr(obj, method, None)
            except Exception:
                fn = None
            if fn is None:
                continue
            try:
                value = fn()
            except Exception:
                continue
            if value is None:
                continue
            if mime is None:
                if isinstance(value, tuple):
                    value = value[0]
                if isinstance(value, dict):
                    for m, v in value.items():
                        if v is not None:
                            data[m] = _encode(m, v)
            else:
                data[mime] = _encode(mime, value)
    if "text/plain" not in data:
        try:
            data["text/plain"] = repr(obj)
        except Exception as exc:  # pragma: no cover - defensive
            data["text/plain"] = "<repr failed: %r>" % (exc,)
    return _cap(data, max_bytes)


def _cap(data, max_bytes):
    def total():
        return sum(len(v) for v in data.values())

    dropped = []
    while total() > max_bytes:
        candidates = [m for m in data if m != "text/plain"]
        if not candidates:
            break
        largest = max(candidates, key=lambda m: len(data[m]))
        dropped.append("%s (%d bytes)" % (largest, len(data[largest])))
        del data[largest]
    if total() > max_bytes:
        text = data["text/plain"]
        data["text/plain"] = text[: max(0, max_bytes - 64)] + "\n… [truncated %d bytes]" % (len(text) - max_bytes + 64)
    if dropped:
        data["text/plain"] = data.get("text/plain", "") + "\n[debug-notebook: dropped %s; over size cap]" % ", ".join(dropped)
    return data


def _figures(max_bytes=DEFAULT_MAX_BYTES):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    outputs = []
    try:
        nums = list(plt.get_fignums())
    except Exception:
        return []
    for num in nums:
        try:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            outputs.append(_cap({
                "image/png": base64.b64encode(buf.getvalue()).decode("ascii"),
                "text/plain": "<Figure %d>" % num,
            }, max_bytes))
        except Exception:
            outputs.append({"text/plain": "<Figure %d: render failed>\n%s" % (num, traceback.format_exc())})
        try:
            plt.close(fig)
        except Exception:
            pass
    return outputs
