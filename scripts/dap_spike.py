"""
Spike: verify debugpy behaviours the Python profile depends on (design doc §9).

Usage: python scripts/dap_spike.py [python-with-debugpy]

Launches fixtures/sample.py under `python -m debugpy --listen ... --wait-for-client`,
attaches as a DAP client, sets a breakpoint on the `return total` line and then
runs a series of evaluate/completions experiments, printing observations.
"""
from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "sample.py"
BREAK_LINE = 11  # `return total`


class Dap:
    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.seq = 0
        self.buf = b""
        self.events: list[dict] = []
        self.responses: dict[int, dict] = {}
        self.log: list[tuple[float, str, dict]] = []
        self.lock = threading.Condition()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                data = self.sock.recv(65536)
            except OSError:
                return
            if not data:
                return
            self.buf += data
            while True:
                if b"\r\n\r\n" not in self.buf:
                    break
                head, rest = self.buf.split(b"\r\n\r\n", 1)
                length = int(head.decode().split("Content-Length:")[1].strip())
                if len(rest) < length:
                    break
                body, self.buf = rest[:length], rest[length:]
                msg = json.loads(body)
                with self.lock:
                    self.log.append((time.monotonic(), msg["type"], msg))
                    if msg["type"] == "event":
                        self.events.append(msg)
                    elif msg["type"] == "response":
                        self.responses[msg["request_seq"]] = msg
                    self.lock.notify_all()

    def send(self, command: str, arguments: dict | None = None) -> int:
        self.seq += 1
        msg = {"seq": self.seq, "type": "request", "command": command, "arguments": arguments or {}}
        body = json.dumps(msg).encode()
        self.sock.sendall(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        return self.seq

    def request(self, command: str, arguments: dict | None = None, timeout=20) -> dict:
        s = self.send(command, arguments)
        with self.lock:
            deadline = time.monotonic() + timeout
            while s not in self.responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(command)
                self.lock.wait(remaining)
            return self.responses.pop(s)

    def wait_event(self, name: str, timeout=20) -> dict:
        with self.lock:
            deadline = time.monotonic() + timeout
            while True:
                for i, ev in enumerate(self.events):
                    if ev["event"] == name:
                        return self.events.pop(i)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(name)
                self.lock.wait(remaining)

    def drain_outputs(self, category=("stdout", "stderr")) -> list[str]:
        with self.lock:
            out = [e for e in self.events if e["event"] == "output" and e["body"].get("category") in category]
            self.events = [e for e in self.events if e not in out]
        return [e["body"]["output"] for e in out]


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def main():
    py = sys.argv[1] if len(sys.argv) > 1 else sys.executable
    port = 5678 + os.getpid() % 1000
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
    assert sock, "could not connect to debugpy"
    d = Dap(sock)

    init = d.request("initialize", {
        "clientID": "spike", "adapterID": "debugpy", "linesStartAt1": True, "columnsStartAt1": True,
        "pathFormat": "path", "supportsVariableType": True, "supportsRunInTerminalRequest": False,
    })
    caps = init["body"]
    print("CAPABILITIES:", {k: v for k, v in caps.items() if k in (
        "supportsCompletionsRequest", "supportsCancelRequest", "supportsClipboardContext",
        "supportsEvaluateForHovers", "completionTriggerCharacters")})
    d.send("attach", {"justMyCode": False, "redirectOutput": True})
    d.wait_event("initialized")
    d.request("setBreakpoints", {"source": {"path": str(FIXTURE)}, "breakpoints": [{"line": BREAK_LINE}]})
    d.request("configurationDone")
    d.wait_event("process", timeout=30)
    stopped = d.wait_event("stopped", timeout=30)
    tid = stopped["body"]["threadId"]
    frames = d.request("stackTrace", {"threadId": tid})["body"]["stackFrames"]
    fid = frames[0]["id"]
    print("STOPPED at", frames[0]["name"], frames[0]["line"])
    d.drain_outputs()

    def ev(expr, context="repl", fmt=None):
        args = {"expression": expr, "frameId": fid, "context": context}
        r = d.request("evaluate", args)
        return r

    def show(title, r):
        body = r.get("body") or {}
        res = body.get("result")
        if not isinstance(res, str):
            res = "" if res is None else str(res)
        print(f"\n== {title}\n   success={r['success']} type={body.get('type')!r} varRef={body.get('variablesReference')} "
              f"len={len(res) if isinstance(res, str) else None}\n   result={res[:160]!r}{'…' if isinstance(res, str) and len(res) > 160 else ''}"
              f"{'' if r['success'] else '  message=' + repr(r.get('message'))[:300]}")

    # A. single-line expression
    show("A single-line expr `total * 2`", ev("total * 2"))
    # B. multi-line with trailing expression
    show("B multi-line stmt + trailing expr", ev("y = 1\nfor _ in range(2):\n    y += 1\ny * 10"))
    time.sleep(0.2)
    print("   stdout during B:", d.drain_outputs())
    # C. locals write-back
    ev("zzz = 42\ntotal = 5")
    show("C1 new local `zzz` after multi-line assign", ev("zzz"))
    show("C2 modified existing local `total`", ev("total"))
    show("C3 single-line assign statement", ev("qqq = 7"))
    show("C3b read it back", ev("qqq"))
    # D. truncation per context
    for ctx in ("repl", "watch", "hover", "clipboard", "variables"):
        r = ev("'x' * 300000", ctx)
        body = r.get("body") or {}
        res = body.get("result")
        print(f"\n== D context={ctx}: success={r['success']} result_len={len(res) if isinstance(res, str) else None} head={res[:20]!r}" if res is not None else f"\n== D context={ctx}: success={r['success']} msg={r.get('message')!r}")
    # D2. str result formatting
    show("D2 str result repr?", ev("'abc'"))
    show("D3 None result", ev("None"))
    show("D4 statement only (print)", ev("print('hi')"))
    time.sleep(0.2)
    print("   stdout after D4:", d.drain_outputs())
    # E. output ordering
    with d.lock:
        d.log.clear()
    r = ev("print('one'); print('two'); 3")
    time.sleep(0.3)
    with d.lock:
        seq = [(t, m["type"], m.get("event") or m.get("command"), (m.get("body") or {}).get("output", (m.get("body") or {}).get("result"))) for t, _, m in d.log]
    t0 = seq[0][0] if seq else 0
    print("\n== E ordering of output events vs evaluate response:")
    for t, typ, name, payload in seq:
        print(f"   +{(t - t0) * 1000:6.1f}ms {typ:8} {name:10} {payload!r}")
    d.drain_outputs()
    # F. completions
    for text, line, col in (("tot", 1, 4), ("import os\nos.pa", 2, 6), ("items.ap", 1, 9)):
        r = d.request("completions", {"frameId": fid, "text": text, "line": line, "column": col})
        targets = [(t.get("label"), t.get("start"), t.get("length")) for t in (r.get("body") or {}).get("targets", [])][:8]
        print(f"\n== F completions text={text!r} line={line} col={col}: success={r['success']} targets={targets}")
    # G. helper injection as a single expression, module not in frame
    helper_src = "def ping():\n    return 'pong'\n"
    inject = (
        "__import__('sys').modules.setdefault('__dbgnb', (lambda m: (exec(compile(__import__('base64').b64decode('"
        + b64(helper_src) + "').decode(), '<dbgnb>', 'exec'), m.__dict__), m)[1])(__import__('types').ModuleType('__dbgnb')))"
    )
    show("G1 inject", ev(inject))
    show("G2 call helper", ev("__import__('__dbgnb').ping()"))
    show("G3 frame not polluted (`m` undefined)", ev("m"))
    # H. base64 round trip of a large payload through repl evaluate
    big = "A" * 200000
    show("H big base64 str via repl", ev(f"__import__('base64').b64encode(b'{big}').decode()[:150000]"))
    # H2. clipboard context: is there any cap? 5 MB
    r = ev("'y' * 5000000", "clipboard")
    res = (r.get("body") or {}).get("result")
    print(f"\n== H2 clipboard 5MB: success={r['success']} result_len={len(res) if isinstance(res, str) else None}")
    # I. exception traceback in message
    show("I exception", ev("1/0"))
    show("I2 multi-line exception", ev("x = 1\nraise ValueError('boom')"))
    # J. locals() inside evaluate
    show("J locals() keys", ev("sorted(locals().keys())"))

    d.request("disconnect", {"terminateDebuggee": True})
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


if __name__ == "__main__":
    main()
