"""
Spike: verify js-debug behaviours the JavaScript profile depends on.

Usage: python scripts/js_spike.py <path-to-js-debug-dap>/src/dapDebugServer.js

Starts the standalone js-debug DAP server, launches fixtures/sample.js with a
breakpoint on `return total`, then probes evaluate/completions semantics.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dap_spike import Dap  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "sample.js"
BREAK_LINE = 9


def main():
    server = Path(sys.argv[1]).resolve()
    port = 7000 + os.getpid() % 1000
    proc = subprocess.Popen(["node", str(server), str(port), "127.0.0.1"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    sock = None
    for _ in range(100):
        try:
            sock = socket.create_connection(("127.0.0.1", port))
            break
        except OSError:
            time.sleep(0.1)
    assert sock, proc.stdout.read()
    d = Dap(sock)
    init = d.request("initialize", {"clientID": "spike", "adapterID": "pwa-node", "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path", "supportsVariableType": True, "supportsVariablePaging": True})
    caps = init["body"]
    print("CAPABILITIES:", {k: v for k, v in caps.items() if k in ("supportsCompletionsRequest", "supportsCancelRequest", "supportsClipboardContext", "supportsEvaluateForHovers", "completionTriggerCharacters")})
    d.send("launch", {"type": "pwa-node", "request": "launch", "name": "spike", "program": str(FIXTURE), "cwd": str(FIXTURE.parent), "console": "internalConsole", "__workspaceFolder": str(FIXTURE.parent)})
    d.wait_event("initialized", timeout=30)
    d.request("configurationDone")
    # js-debug asks the client to start a child session for the actual target.
    child_cfg = None
    deadline = time.monotonic() + 30
    while child_cfg is None and time.monotonic() < deadline:
        with d.lock:
            for _t, typ, m in d.log:
                if typ == "request" and m.get("command") == "startDebugging":
                    child_cfg = m["arguments"]["configuration"]
                    body = __import__("json").dumps({"seq": 0, "type": "response", "request_seq": m["seq"], "success": True, "command": "startDebugging"}).encode()
                    d.sock.sendall(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
                    break
        time.sleep(0.05)
    assert child_cfg, "no startDebugging request"
    root = d
    d = Dap(socket.create_connection(("127.0.0.1", port)))
    d.request("initialize", {"clientID": "spike", "adapterID": "pwa-node", "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path", "supportsVariableType": True, "supportsVariablePaging": True})
    d.send("launch", child_cfg)
    d.wait_event("initialized", timeout=30)
    d.request("setBreakpoints", {"source": {"path": str(FIXTURE)}, "breakpoints": [{"line": BREAK_LINE}]})
    d.request("configurationDone")
    try:
        stopped = d.wait_event("stopped", timeout=15)
    except TimeoutError:
        with d.lock:
            for t, typ, m in d.log:
                print("   LOG", typ, m.get("event") or m.get("command"), str(m.get("body") or m.get("arguments") or "")[:200])
        raise
    tid = stopped["body"]["threadId"]
    frames = d.request("stackTrace", {"threadId": tid})["body"]["stackFrames"]
    fid = frames[0]["id"]
    print("STOPPED at", frames[0]["name"], frames[0]["line"])
    time.sleep(0.3)
    d.drain_outputs()

    def ev(expr, context="repl"):
        return d.request("evaluate", {"expression": expr, "frameId": fid, "context": context}, timeout=30)

    def show(title, r):
        body = r.get("body") or {}
        res = body.get("result")
        if not isinstance(res, str):
            res = "" if res is None else str(res)
        print(f"\n== {title}\n   success={r['success']} type={body.get('type')!r} varRef={body.get('variablesReference')} indexed={body.get('indexedVariables')} named={body.get('namedVariables')} len={len(res)}\n   result={res[:160]!r}{'…' if len(res) > 160 else ''}{'' if r['success'] else '  message=' + repr(r.get('message'))[:300]}")

    show("A single expr", ev("total * 2"))
    show("B multi-line, trailing expr (completion value?)", ev("let y = 1;\nfor (let i = 0; i < 2; i++) { y += 1; }\ny * 10"))
    show("C1 let persisted across evaluates?", ev("y"))
    show("C2 assign existing local", ev("total = 5; total"))
    show("C3 const redeclare (replMode?)", ev("const zz = 1; zz"))
    show("C3b redeclare same const", ev("const zz = 2; zz"))
    show("D1 $_ last result", ev("$_"))
    show("D2 object result", ev("({a: 1, b: [1,2,3], c: {d: 'x'}})"))
    show("D3 $_ after object", ev("$_"))
    show("D4 array of objects", ev("[{id: 1, name: 'a'}, {id: 2, name: 'b'}]"))
    show("D5 Map", ev("new Map([['k', 1]])"))
    show("D6 function", ev("compute"))
    show("D7 string", ev("'hello'"))
    show("D8 undefined", ev("undefined"))
    show("D9 promise", ev("Promise.resolve(42)"))
    show("D10 await", ev("await Promise.resolve(43)"))
    for ctx in ("repl", "watch", "hover", "clipboard"):
        r = ev("'x'.repeat(300000)", ctx)
        body = r.get("body") or {}
        res = body.get("result")
        print(f"\n== E context={ctx}: success={r['success']} result_len={len(res) if isinstance(res, str) else None} head={res[:12]!r}" if isinstance(res, str) else f"\n== E context={ctx}: success={r['success']} msg={r.get('message')!r}")
    for title, expr in (("F exception", "null.x"), ("F2 throw", "throw new Error('boom')"), ("F3 syntax error", "let (")):
        r = ev(expr)
        print(f"\n== {title}: success={r['success']} message={r.get('message')!r} body={str(r.get('body'))[:300]!r}")
    show("F4 eval wrapper completion value", ev("(globalThis.__dbgnb_last = eval(\"let q = 2;\\nq * 21\"), globalThis.__dbgnb_last)"))
    show("F5 eval wrapper sees locals & assigns", ev("(globalThis.__dbgnb_last = eval(\"total = total + 1; items.length\"), globalThis.__dbgnb_last)"))
    show("F6 eval wrapper exception", ev("(globalThis.__dbgnb_last = eval(\"null.x\"), globalThis.__dbgnb_last)"))
    show("F7 eval wrapper object result", ev("(globalThis.__dbgnb_last = eval(\"({a: [1,2]})\"), globalThis.__dbgnb_last)"))
    r = ev("JSON.stringify({s: 'x'.repeat(200000)})", "clipboard")
    print(f"\n== F8 clipboard JSON round trip: len={len(r['body']['result'])} parses={__import__('json').loads(r['body']['result'])[:3]!r}")
    with d.lock:
        d.log.clear()
    ev("console.log('one'); console.log('two'); 3")
    time.sleep(0.5)
    with d.lock:
        seq = [(t, m["type"], m.get("event") or m.get("command"), (m.get("body") or {}).get("category"), (m.get("body") or {}).get("output", (m.get("body") or {}).get("result"))) for t, _, m in d.log]
    t0 = seq[0][0] if seq else 0
    print("\n== G ordering + categories of output vs response:")
    for t, typ, name, cat, payload in seq:
        print(f"   +{(t - t0) * 1000:6.1f}ms {typ:8} {name:10} {cat!r:10} {payload!r}")
    d.drain_outputs()
    show("H process.stdout.write", ev("process.stdout.write('raw\\n')"))
    time.sleep(0.4)
    print("   outputs:", [(e['body'].get('category'), e['body'].get('output')) for e in d.events if e['event'] == 'output'])
    d.events = [e for e in d.events if e['event'] != 'output']
    for text, line, col in (("tot", 1, 4), ("const q = 1;\nitems.ma", 2, 9), ("items.ma", 1, 9)):
        r = d.request("completions", {"frameId": fid, "text": text, "line": line, "column": col})
        targets = [(t.get("label"), t.get("start"), t.get("length")) for t in (r.get("body") or {}).get("targets", [])][:6]
        print(f"\n== I completions text={text!r} line={line} col={col}: success={r['success']} targets={targets}")
    show("J inject global helper", ev("(globalThis.__dbgnb = { ping() { return 'pong'; } }, 'ok')"))
    show("J2 call helper", ev("__dbgnb.ping()"))
    show("J3 helper sees $_?", ev("(function(){ const v = $_; return typeof v; })()"))
    show("K JSON.stringify of local", ev("JSON.stringify(items)"))

    # L. the real helper, driven exactly as JsProfile does
    import base64, json
    helper = (ROOT / "src" / "profiles" / "js" / "helper.js").read_text()
    show("L inject real helper", ev(helper))

    def cell(title, src, max_bytes=10 * 1024 * 1024):
        r = ev(f"(__dbgnb.last = eval({json.dumps(src)}), __dbgnb.last)")
        body = r.get("body") or {}
        if not r["success"]:
            print(f"\n== {title}: ERROR {str((r.get('body') or {}).get('error', {}).get('format'))[:120]!r}")
            return None
        f = ev(f"__dbgnb.format({{ maxBytes: {max_bytes} }})", "clipboard")
        packed = json.loads(f["body"]["result"])
        outputs = json.loads(base64.b64decode(packed))["outputs"]
        print(f"\n== {title}: result={body.get('result')[:50]!r} varRef={body.get('variablesReference')}")
        for o in outputs:
            print("   bundle:", {m: (len(v), v[:70].replace(chr(10), ' ')) for m, v in o.items()})
        return outputs

    cell("L1 primitive", "let a = 2;\na * 21")
    out = cell("L2 records table", "items.map((x, i) => ({ i, item: x, weighted: x * (i + 1) }))")
    assert out and "text/html" in out[0] and "application/json" in out[0]
    out = cell("L3 nested object", "({ total, label, nested: { items, when: new Date(0), m: new Map([['k', 1]]) } })")
    assert out and json.loads(out[0]["application/json"])["nested"]["m"] == {"k": 1}
    out = cell("L4 function source", "compute")
    assert out and out[0]["text/markdown"].startswith("```js")
    cell("L5 exception", "null.x")
    out = cell("L6 assignment persists + undefined", "total = total + 1")
    out = cell("L6b read back", "total")
    out = cell("L7 big array capped", "Array.from({length: 20000}, (_, i) => ({ i, s: 'x'.repeat(50) }))", max_bytes=100000)
    assert out and "application/json" not in out[0] and "dropped" in out[0]["text/plain"]

    d.request("disconnect", {"terminateDebuggee": True})
    root.request("disconnect", {"terminateDebuggee": True})
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


if __name__ == "__main__":
    main()
