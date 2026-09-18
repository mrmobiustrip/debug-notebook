"""Fixture for manual testing. Set a breakpoint on the `return` line in `compute`."""

import sys


def compute(items):
    total = 0
    for i, item in enumerate(items):
        total += item * (i + 1)
    label = f"sum={total}"
    return total  # <- breakpoint here


def main():
    data = [3, 1, 4, 1, 5, 9]
    result = compute(data)
    print("result:", result, file=sys.stderr)
    return result


if __name__ == "__main__":
    main()
