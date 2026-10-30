interface LayerLike {
  handle?: unknown;
  route?: { path?: unknown; methods?: Record<string, boolean>; stack: { handle: unknown }[] };
}

function stackOf(value: unknown): LayerLike[] | null {
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return null;
  const stack = (value as { stack?: unknown }).stack;
  return Array.isArray(stack) ? (stack as LayerLike[]) : null;
}

// authorize() and publicRoute() tag their handlers, so we can recognise them here.
function isGuard(handler: unknown): boolean {
  if (typeof handler !== 'function') return false;
  const tagged = handler as { permission?: unknown; isPublic?: unknown };
  return typeof tagged.permission === 'string' || tagged.isPublic === true;
}

export function findUnguardedRoutes(router: unknown): string[] {
  const problems: string[] = [];

  const walk = (node: unknown): void => {
    for (const layer of stackOf(node) ?? []) {
      if (layer.route) {
        if (!layer.route.stack.some((entry) => isGuard(entry.handle))) {
          const methods = Object.keys(layer.route.methods ?? {}).join(',').toUpperCase();
          problems.push(`${methods} ${String(layer.route.path)}`);
        }
      } else if (stackOf(layer.handle)) {
        walk(layer.handle); // a mounted router
      }
    }
  };

  walk(router);
  return problems;
}

/** Called once when routes are built. A route without a guard stops the app from starting. */
export function assertAllRoutesGuarded(router: unknown): void {
  const problems = findUnguardedRoutes(router);
  if (problems.length > 0) {
    throw new Error(
      `Routes without authorize() or publicRoute(): ${problems.join(', ')}. ` +
        'Every route must declare a permission or be explicitly public.',
    );
  }
}