import { describe, expect, it } from 'vitest';
import { expressionFromDebugContext } from '../src/notebook/DebugContext';

describe('expressionFromDebugContext', () => {
  it('prefers evaluateName from the Variables view', () => {
    expect(expressionFromDebugContext({ sessionId: 's', variable: { name: 'a', evaluateName: 'df.a' } })).toBe('df.a');
  });
  it('derives a path from the container when evaluateName is missing', () => {
    expect(expressionFromDebugContext({ container: { evaluateName: 'obj' }, variable: { name: 'x' } })).toBe('obj.x');
    expect(expressionFromDebugContext({ container: { evaluateName: 'arr' }, variable: { name: '0' } })).toBe('arr[0]');
    expect(expressionFromDebugContext({ container: { name: 'Locals' }, variable: { name: 'total' } })).toBe('total');
  });
  it('reads watch expressions', () => {
    expect(expressionFromDebugContext({ expression: { name: 'total * 2' } })).toBe('total * 2');
    expect(expressionFromDebugContext({ expression: 'x' })).toBe('x');
    expect(expressionFromDebugContext(undefined)).toBeUndefined();
  });
});
