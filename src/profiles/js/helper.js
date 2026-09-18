// Debug Notebook helper for JavaScript debuggees (js-debug: Node, Chrome, Edge,
// extension host). Injected once per session as `globalThis.__dbgnb`.
//
// The extension evaluates each cell as `(__dbgnb.last = eval(<source>), __dbgnb.last)`
// in the paused frame: direct eval keeps the frame's scope (locals are readable
// and assignable) and returns the program's completion value, exactly like the
// Debug Console would. This module never runs user code; it only formats
// `last` into a MIME bundle afterwards.
//
// Evaluated as an expression; returns 'ok'.
(function () {
  var H = globalThis.__dbgnb || (globalThis.__dbgnb = {});
  H.VERSION = 1;
  H.last = undefined;

  var MAX_TABLE_ROWS = 1000;
  var MAX_TABLE_COLS = 30;

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    var p = Object.getPrototypeOf(v);
    return p === null || p === Object.prototype;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Plain-data projection with cycle, depth and node caps. Never throws.
  function toPlain(value, opts) {
    var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
    var budget = { nodes: opts.maxNodes };
    function walk(v, depth) {
      budget.nodes--;
      if (budget.nodes < 0) return '[…]';
      var t = typeof v;
      if (v === null || t === 'number' || t === 'string' || t === 'boolean') return v;
      if (t === 'undefined') return 'undefined';
      if (t === 'bigint') return String(v) + 'n';
      if (t === 'symbol') return String(v);
      if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (seen) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (depth >= opts.maxDepth) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
      var out, i, keys;
      if (v instanceof Map) {
        out = {};
        var allStr = true;
        v.forEach(function (_val, k) { if (typeof k !== 'string') allStr = false; });
        if (allStr) {
          v.forEach(function (val, k) { out[k] = walk(val, depth + 1); });
          return out;
        }
        out = [];
        v.forEach(function (val, k) { out.push([walk(k, depth + 1), walk(val, depth + 1)]); });
        return out;
      }
      if (v instanceof Set) {
        out = [];
        v.forEach(function (val) { out.push(walk(val, depth + 1)); });
        return out;
      }
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        out = [];
        for (i = 0; i < Math.min(v.length, 1000); i++) out.push(v[i]);
        if (v.length > 1000) out.push('… ' + (v.length - 1000) + ' more');
        return out;
      }
      if (Array.isArray(v)) {
        out = [];
        for (i = 0; i < v.length; i++) out.push(walk(v[i], depth + 1));
        return out;
      }
      out = {};
      try {
        keys = Object.keys(v);
      } catch (e) {
        return String(v);
      }
      for (i = 0; i < keys.length; i++) {
        try {
          out[keys[i]] = walk(v[keys[i]], depth + 1);
        } catch (e) {
          out[keys[i]] = '[getter threw: ' + (e && e.message) + ']';
        }
      }
      return out;
    }
    return walk(value, 0);
  }

  function recordColumns(arr) {
    if (!Array.isArray(arr) || arr.length === 0 || arr.length > MAX_TABLE_ROWS) return null;
    var cols = [];
    var index = {};
    for (var i = 0; i < arr.length; i++) {
      if (!isPlainObject(arr[i])) return null;
      var keys = Object.keys(arr[i]);
      for (var k = 0; k < keys.length; k++) {
        if (!(keys[k] in index)) {
          index[keys[k]] = true;
          cols.push(keys[k]);
          if (cols.length > MAX_TABLE_COLS) return null;
        }
      }
    }
    return cols;
  }

  function cellText(v) {
    if (v === null || v === undefined) return '';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    var s;
    try {
      s = JSON.stringify(toPlain(v, { maxDepth: 2, maxNodes: 50 }));
    } catch (e) {
      s = String(v);
    }
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  }

  var TABLE_STYLE =
    '<style>.dbgnb-table{border-collapse:collapse;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px)}' +
    '.dbgnb-table th,.dbgnb-table td{border:1px solid var(--vscode-editorWidget-border,#444);padding:2px 8px;text-align:left;vertical-align:top}' +
    '.dbgnb-table thead th{background:var(--vscode-editorWidget-background,rgba(128,128,128,.15));font-weight:600}' +
    '.dbgnb-table tbody th{color:var(--vscode-descriptionForeground);font-weight:normal}</style>';

  function table(arr, cols) {
    var h = TABLE_STYLE + '<table class="dbgnb-table"><thead><tr><th></th>';
    for (var c = 0; c < cols.length; c++) h += '<th>' + escapeHtml(cols[c]) + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 0; r < arr.length; r++) {
      h += '<tr><th>' + r + '</th>';
      for (c = 0; c < cols.length; c++) h += '<td>' + escapeHtml(cellText(arr[r][cols[c]])) + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  function bundleFor(v, opts) {
    var b = {};
    var t = typeof v;
    if (t === 'function') {
      var src;
      try { src = Function.prototype.toString.call(v); } catch (e) { src = String(v); }
      b['text/markdown'] = '```js\n' + src + '\n```';
      return b;
    }
    if (v === null || t !== 'object') return b; // primitives: the adapter's own text is enough
    if (v instanceof Error) {
      b['text/plain'] = v.stack || (v.name + ': ' + v.message);
      return b;
    }
    if (typeof Element !== 'undefined' && v instanceof Element) {
      b['text/html'] = v.outerHTML;
      return b;
    }
    if (v instanceof Promise) return b;
    var cols = recordColumns(v);
    if (cols) {
      // VS Code's default display order ranks application/json above
      // text/html, so a table-shaped result carries the table only; the
      // variable tree still exposes the structure.
      b['text/html'] = table(v, cols);
      return b;
    }
    var plain = toPlain(v, opts);
    try {
      b['application/json'] = JSON.stringify(plain, null, 1);
    } catch (e) {
      b['text/plain'] = '[unserialisable: ' + (e && e.message) + ']';
    }
    return b;
  }

  function cap(b, maxBytes) {
    function total() { var n = 0; for (var k in b) n += b[k].length; return n; }
    var dropped = [];
    while (total() > maxBytes) {
      var largest = null;
      for (var k in b) if (k !== 'text/plain' && (largest === null || b[k].length > b[largest].length)) largest = k;
      if (largest === null) break;
      dropped.push(largest + ' (' + b[largest].length + ' bytes)');
      delete b[largest];
    }
    if (dropped.length) b['text/plain'] = (b['text/plain'] ? b['text/plain'] + '\n' : '') + '[debug-notebook: dropped ' + dropped.join(', ') + '; over size cap]';
    return b;
  }

  function toBase64(str) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(str, 'utf8').toString('base64');
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /** Format `last` into {outputs:[bundle]} and return it base64(JSON)-encoded. */
  H.format = function (options) {
    var o = options || {};
    var opts = { maxDepth: o.maxDepth || 6, maxNodes: o.maxNodes || 5000 };
    var maxBytes = o.maxBytes || 10 * 1024 * 1024;
    var bundle;
    try {
      bundle = cap(bundleFor(H.last, opts), maxBytes);
    } catch (e) {
      bundle = { 'text/plain': '[debug-notebook: format failed: ' + (e && e.message) + ']' };
    }
    var outputs = Object.keys(bundle).length ? [bundle] : [];
    return toBase64(JSON.stringify({ outputs: outputs }));
  };

  H._internal = { toPlain: toPlain, recordColumns: recordColumns, bundleFor: bundleFor, cap: cap };
  return 'ok';
})()
