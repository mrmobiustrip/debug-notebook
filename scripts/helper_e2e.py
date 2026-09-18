"""
End-to-end check of the Python profile protocol against a real debugpy, without
VS Code: inject src/profiles/python/helper.py exactly as PythonProfile does,
then run split / native evaluate / bundle / chunked read for a few cells.

Usage: python scripts/helper_e2e.py [python-with-debugpy]
The interpreter should have pandas and matplotlib for the rich-output cells.
"""
from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dap_spike import Dap, FIXTURE, BREAK_LINE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
HELPER = (ROOT / "src" / "profiles" / "python" / "helper.py").read_text()
MODULE = "__dbgnb"
H = f"__import__('{MODULE}')"
INLINE = 60000


def inject_expr() -> str:
    src = base64.b64encode(HELPER.encode()).decode()
    return (
        f"(lambda m: (exec(compile(__import__('base64').b64decode('{src}').decode('utf-8'), '<{MODULE}>', 'exec'), m.__dict__), "
        f"__import__('sys').modules.__setitem__('{MODULE}', m), m)[2])(__import__('types').ModuleType('{MODULE}'))"
    )


def strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    return s


class Client:
    def __init__(self, d: Dap, fid: int, clipboard: bool):
        self.d, self.fid, self.clipboard = d, fid, clipboard
        self.reads = 0

    def ev(self, expr: str, context="repl") -> dict:
        r = self.d.request("evaluate", {"expression": expr, "frameId": self.fid, "context": context}, timeout=60)
        if not r["success"]:
            raise RuntimeError(r.get("message"))
        return r["body"]

    def call(self, call: str):
        packed = strip_quotes(self.ev(f"{H}.{call}")["result"])
        hid, length, inline = packed.split(":", 2)
        hid, length = int(hid), int(length)
        data = inline
        if hid != 0:
            ctx = "clipboard" if self.clipboard else "repl"
            chunk = 2 * 1024 * 1024 if self.clipboard else 60000
            parts = []
            off = 0
            while off < length:
                piece = strip_quotes(self.ev(f"{H}.read({hid}, {off}, {chunk})", ctx)["result"])
                self.reads += 1
                if not piece:
                    break
                parts.append(piece)
                off += len(piece)
            self.ev(f"{H}.drop({hid})")
            data = "".join(parts)
        assert len(data) == length, (len(data), length)
        return json.loads(base64.b64decode(data))

    def run_cell(self, src: str, max_bytes=10 * 1024 * 1024):
        t0 = time.monotonic()
        split = self.call(f"split('{base64.b64encode(src.encode()).decode()}', inline_limit={INLINE})")
        if split["body"]:
            self.ev(split["body"])
        kw = f"max_bytes={max_bytes}, inline_limit={INLINE}"
        call = f"bundle(({split['last_expr']}\n), {kw})" if split["last_expr"] else f"bundle({kw})"
        out = self.call(call)["outputs"]
        dt = (time.monotonic() - t0) * 1000
        time.sleep(0.15)
        stdout = "".join(self.d.drain_outputs())
        return out, stdout, dt


def main():
    py = sys.argv[1] if len(sys.argv) > 1 else sys.executable
    port = 6000 + os.getpid() % 1000
    proc = subprocess.Popen(
        [py, "-m", "debugpy", "--listen", f"127.0.0.1:{port}", "--wait-for-client", str(FIXTURE)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    sock = None
    for _ in range(100):
        try:
            sock = socket.create_connection(("127.0.0.1", port))
            break
        except OSError:
            time.sleep(0.1)
    assert sock
    d = Dap(sock)
    caps = d.request("initialize", {"clientID": "e2e", "adapterID": "debugpy", "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path"})["body"]
    d.send("attach", {"justMyCode": False, "redirectOutput": True})
    d.wait_event("initialized")
    d.request("setBreakpoints", {"source": {"path": str(FIXTURE)}, "breakpoints": [{"line": BREAK_LINE}]})
    d.request("configurationDone")
    d.wait_event("process", timeout=30)
    tid = d.wait_event("stopped", timeout=30)["body"]["threadId"]
    fid = d.request("stackTrace", {"threadId": tid})["body"]["stackFrames"][0]["id"]
    d.drain_outputs()
    c = Client(d, fid, caps.get("supportsClipboardContext", False))

    t0 = time.monotonic()
    c.ev(inject_expr())
    print(f"inject: {(time.monotonic() - t0) * 1000:.0f} ms")

    def cell(title, src, **kw):
        out, stdout, dt = c.run_cell(src, **kw)
        print(f"\n== {title} ({dt:.0f} ms, reads={c.reads})")
        c.reads = 0
        if stdout:
            print("   stdout:", repr(stdout[:120]))
        for o in out:
            desc = {m: (len(v), v[:60].replace("\n", "\\n")) for m, v in o.items()}
            print("   output:", desc)
        return out

    cell("A trailing expr", "y = total + 1\ny * 2")
    cell("B locals persisted", "y")
    cell("C stdout + result", "print('hello')\nlabel")
    cell("D suppressed with ;", "y;")
    cell("E statement only", "zz = [1,2,3]")
    out = cell("F big text (>64KB, forces parked read)", "'q' * 100000")
    assert len(out[0]["text/plain"]) == 100002, len(out[0]["text/plain"])
    try:
        cell("G exception", "1/0")
    except RuntimeError as e:
        print("   error message tail:", repr(str(e).strip().splitlines()[-1]))
    try:
        cell("G2 multi-line exception", "x = 1\nraise ValueError('boom')")
    except RuntimeError as e:
        print("   error message tail:", repr(str(e).strip().splitlines()[-1]))
    cell("H tuple expr", "y, label")
    try:
        import pandas  # noqa: F401  (only to decide whether to run)
        out = cell("I pandas DataFrame", "import pandas as pd\ndf = pd.DataFrame({'i': range(len(items)), 'item': items})\ndf")
        assert "text/html" in out[0], out[0].keys()
        out = cell("J matplotlib figure + df.head()", "import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nplt.plot(items)\ndf.head(2)")
        assert any("image/png" in o for o in out), "no png"
        out = cell("K multi-MB image round-trip", "import numpy as np\nplt.figure(figsize=(15,15), dpi=100)\nplt.imshow(np.random.rand(1500,1500), interpolation='none')\nplt.axis('off')\n")
        fig = next(o for o in out if "image/png" in o)
        png_len = len(fig["image/png"])
        print(f"   png base64 length: {png_len} ({png_len * 3 // 4 // 1024} KB)")
        assert png_len > 2 * 1024 * 1024, "expected a multi-MB image"
        assert base64.b64decode(fig["image/png"]).startswith(b"\x89PNG")
        out = cell("L size cap drops png", "plt.figure(); plt.plot(items)\n", max_bytes=2000)
        assert not any("image/png" in o for o in out) and any("dropped" in o["text/plain"] for o in out)
    except ImportError:
        print("\n(pandas/matplotlib not in this interpreter; skipping I-L)")

    d.request("disconnect", {"terminateDebuggee": True})
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    print("\nE2E OK")


if __name__ == "__main__":
    main()
