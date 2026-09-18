import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(new URL('../../src/profiles/js/helper.js', import.meta.url), 'utf8');
assert.equal((0, eval)(src), 'ok');
const H = globalThis.__dbgnb;

function format(value, opts) {
  H.last = value;
  const json = JSON.parse(Buffer.from(H.format(opts), 'base64').toString('utf8'));
  return json.outputs;
}

test('primitives yield no bundle (adapter text suffices)', () => {
  assert.deepEqual(format(42), []);
  assert.deepEqual(format('s'), []);
  assert.deepEqual(format(undefined), []);
  assert.deepEqual(format(null), []);
});

test('plain objects become application/json', () => {
  const [b] = format({ a: 1, b: [1, 2], c: { d: 'x' } });
  assert.deepEqual(JSON.parse(b['application/json']), { a: 1, b: [1, 2], c: { d: 'x' } });
  assert.equal(b['text/html'], undefined);
});

test('arrays of records become an html table (no json, which VS Code would rank above it)', () => {
  const [b] = format([{ id: 1, name: 'a' }, { id: 2, name: 'b', extra: true }]);
  assert.match(b['text/html'], /<table[^>]*>.*<th>id<\/th><th>name<\/th><th>extra<\/th>/s);
  assert.match(b['text/html'], /<td>2<\/td><td>b<\/td><td>true<\/td>/);
  assert.equal(b['application/json'], undefined);
});

test('mixed arrays get json only', () => {
  const [b] = format([{ a: 1 }, 2]);
  assert.equal(b['text/html'], undefined);
  assert.ok(b['application/json']);
});

test('cycles, depth, bigint, map, set, date, functions are safe', () => {
  const o = { n: 1n, d: new Date(0), m: new Map([['k', 1]]), s: new Set([1, 2]), f() {} };
  o.self = o;
  const [b] = format(o, { maxDepth: 6 });
  assert.deepEqual(JSON.parse(b['application/json']), {
    n: '1n',
    d: '1970-01-01T00:00:00.000Z',
    m: { k: 1 },
    s: [1, 2],
    f: '[Function f]',
    self: '[Circular]',
  });
  const deep = { a: { b: { c: { d: 1 } } } };
  const [d] = format(deep, { maxDepth: 2 });
  assert.deepEqual(JSON.parse(d['application/json']), { a: { b: '[Object]' } });
});

test('functions render as a js code block', () => {
  function compute(items) { return items.length; }
  const [b] = format(compute);
  assert.match(b['text/markdown'], /^```js\nfunction compute/);
});

test('errors render their stack', () => {
  const [b] = format(new Error('boom'));
  assert.match(b['text/plain'], /Error: boom/);
});

test('size cap drops the largest item and notes it', () => {
  const [b] = format({ a: 'x'.repeat(500), b: 'y'.repeat(20) }, { maxBytes: 100 });
  assert.equal(b['application/json'], undefined);
  assert.match(b['text/plain'], /dropped application\/json/);
  const [c] = format([{ v: 'x'.repeat(500) }], { maxBytes: 100 });
  assert.equal(c['text/html'], undefined);
  assert.match(c['text/plain'], /dropped text\/html/);
});

test('getters that throw do not break formatting', () => {
  const o = { get bad() { throw new Error('nope'); }, ok: 1 };
  const [b] = format(o);
  assert.deepEqual(JSON.parse(b['application/json']), { bad: '[getter threw: nope]', ok: 1 });
});
