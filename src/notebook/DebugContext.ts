/**
 * Args of `debug/variables/context` ({ sessionId, container, variable }) and
 * `debug/watch/context` ({ expression }) menus. Shapes are not part of the
 * public API, so read defensively.
 */
export function expressionFromDebugContext(arg: unknown): string | undefined {
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  const a = arg as {
    variable?: { evaluateName?: string; name?: string };
    container?: { evaluateName?: string; name?: string; expression?: string };
    expression?: { name?: string; expression?: string } | string;
  };
  if (a.variable) {
    if (a.variable.evaluateName) {
      return a.variable.evaluateName;
    }
    const parent = a.container?.evaluateName ?? a.container?.expression;
    if (parent && a.variable.name) {
      return /^[A-Za-z_$][\w$]*$/.test(a.variable.name) ? `${parent}.${a.variable.name}` : `${parent}[${a.variable.name}]`;
    }
    return a.variable.name;
  }
  if (typeof a.expression === 'string') {
    return a.expression;
  }
  return a.expression?.expression ?? a.expression?.name;
}
