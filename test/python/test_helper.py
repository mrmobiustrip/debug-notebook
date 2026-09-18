import base64
import importlib.util
import json
import sys
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[2] / "src" / "profiles" / "python" / "helper.py"
spec = importlib.util.spec_from_file_location("__dbgnb", HELPER)
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)


def unpack(packed):
    head, length, inline = packed.split(":", 2)
    if head == "0":
        data = inline
    else:
        data = ""
        while len(data) < int(length):
            data += H.read(int(head), len(data), 7)
        H.drop(int(head))
    assert len(data) == int(length)
    return json.loads(base64.b64decode(data))


def b64(s):
    return base64.b64encode(s.encode()).decode()


class SplitTests(unittest.TestCase):
    def split(self, src):
        return H._split(src)

    def test_trailing_expression(self):
        r = self.split("x = 1\nx + 1")
        self.assertEqual(r, {"body": "x = 1\n", "last_expr": "x + 1"})

    def test_only_expression(self):
        self.assertEqual(self.split("total * 2"), {"body": None, "last_expr": "total * 2"})

    def test_semicolon_suppresses(self):
        self.assertEqual(self.split("x = 1\nx;"), {"body": "x = 1\nx;", "last_expr": None})
        self.assertEqual(self.split("x = 1\nx ;  # hush"), {"body": "x = 1\nx ;  # hush", "last_expr": None})

    def test_last_statement_not_expression(self):
        src = "x = 1\nfor i in range(3):\n    x += i\n"
        self.assertEqual(self.split(src), {"body": src, "last_expr": None})

    def test_decorated_function_last(self):
        src = "@staticmethod\ndef f():\n    return 1\n"
        self.assertEqual(self.split(src), {"body": src, "last_expr": None})

    def test_multiline_expression(self):
        src = "d = {}\n{\n    'a': 1,\n    'b': 2,\n}"
        r = self.split(src)
        self.assertEqual(r["body"], "d = {}\n")
        self.assertEqual(r["last_expr"], "{\n    'a': 1,\n    'b': 2,\n}")

    def test_same_line_semicolon_separated(self):
        self.assertEqual(self.split("a = 1; a"), {"body": "a = 1; ", "last_expr": "a"})

    def test_trailing_comment_after_expr(self):
        self.assertEqual(self.split("x  # comment"), {"body": None, "last_expr": "x"})

    def test_syntax_error_passthrough(self):
        src = "def (:\n"
        self.assertEqual(self.split(src), {"body": src, "last_expr": None})

    def test_empty_and_comment_only(self):
        self.assertEqual(self.split(""), {"body": None, "last_expr": None})
        self.assertEqual(self.split("# just a comment\n"), {"body": None, "last_expr": None})

    def test_dedent(self):
        self.assertEqual(self.split("    x = 1\n    x"), {"body": "x = 1\n", "last_expr": "x"})

    def test_tuple_expression(self):
        self.assertEqual(self.split("a, b"), {"body": None, "last_expr": "a, b"})

    def test_public_split_roundtrip(self):
        r = unpack(H.split(b64("x = 1\nx")))
        self.assertEqual(r, {"body": "x = 1\n", "last_expr": "x"})


class Weird:
    def _repr_html_(self):
        raise RuntimeError("broken html")

    def _repr_markdown_(self):
        return "**md**"

    def __repr__(self):
        return "<Weird>"


class Bundled:
    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"image/png": b"\x89PNG", "text/plain": "bundled"}


class BundleTests(unittest.TestCase):
    def setUp(self):
        H._ipython_probed = True
        H._ipython_formatter = None

    def test_plain_object(self):
        out = unpack(H.bundle(42))["outputs"]
        self.assertEqual(out, [{"text/plain": "42"}])

    def test_no_args_no_figures(self):
        self.assertEqual(unpack(H.bundle())["outputs"], [])

    def test_last_object_kept_for_inspection(self):
        obj = object()
        H.bundle(obj)
        self.assertIs(H._last, obj)
        H.bundle()
        self.assertIsNone(H._last)

    def test_broken_formatter_does_not_fail(self):
        out = unpack(H.bundle(Weird()))["outputs"][0]
        self.assertEqual(out, {"text/markdown": "**md**", "text/plain": "<Weird>"})

    def test_mimebundle_bytes_base64(self):
        out = unpack(H.bundle(Bundled()))["outputs"][0]
        self.assertEqual(out["image/png"], base64.b64encode(b"\x89PNG").decode())
        self.assertEqual(out["text/plain"], "bundled")

    def test_size_cap_drops_largest_non_text(self):
        class Big:
            def _repr_html_(self):
                return "h" * 5000

            def _repr_markdown_(self):
                return "m" * 100

            def __repr__(self):
                return "big"

        out = unpack(H.bundle(Big(), max_bytes=1000))["outputs"][0]
        self.assertNotIn("text/html", out)
        self.assertIn("text/markdown", out)
        self.assertIn("dropped text/html", out["text/plain"])

    def test_large_payload_is_parked_and_readable(self):
        packed = H.bundle("z" * 5000, inline_limit=100)
        head, length, inline = packed.split(":", 2)
        self.assertNotEqual(head, "0")
        self.assertEqual(inline, "")
        out = unpack(packed)["outputs"][0]
        self.assertEqual(out["text/plain"], repr("z" * 5000))
        self.assertNotIn(int(head), H._pending)

    def test_ipython_formatter_when_available(self):
        try:
            from IPython.core.formatters import DisplayFormatter  # noqa: F401
        except ImportError:
            self.skipTest("IPython not installed")
        H._ipython_probed = False
        H._ipython_formatter = None
        out = unpack(H.bundle({"a": 1}))["outputs"][0]
        self.assertEqual(out["text/plain"], "{'a': 1}")

    def test_pandas_html(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        H._ipython_probed = False
        out = unpack(H.bundle(pd.DataFrame({"a": [1, 2]})))["outputs"][0]
        self.assertIn("text/html", out)
        self.assertIn("<table", out["text/html"])

    def test_matplotlib_figures_captured_and_closed(self):
        try:
            import matplotlib
        except ImportError:
            self.skipTest("matplotlib not installed")
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        plt.figure()
        plt.plot([1, 2, 3])
        out = unpack(H.bundle())["outputs"]
        self.assertEqual(len(out), 1)
        self.assertTrue(base64.b64decode(out[0]["image/png"]).startswith(b"\x89PNG"))
        self.assertEqual(plt.get_fignums(), [])


if __name__ == "__main__":
    unittest.main()
