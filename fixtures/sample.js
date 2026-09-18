// Fixture for manual testing under js-debug. Set a breakpoint on the `return` line in `compute`.

function compute(items) {
  let total = 0;
  for (const [i, item] of items.entries()) {
    total += item * (i + 1);
  }
  const label = `sum=${total}`;
  return total; // <- breakpoint here
}

function main() {
  const data = [3, 1, 4, 1, 5, 9];
  const result = compute(data);
  console.log('result:', result);
  return result;
}

main();
