/**
 * Render and mount counter for DOM tests (issue #1432: "measure render counts,
 * not only timings").
 *
 * It rides the React DevTools commit hook, which the development build of
 * react-dom calls after every commit with the finished root. Walking the
 * committed fiber tree the way the DevTools profiler does — descend only into
 * subtrees whose child pointer moved, count a function fiber as rendered when
 * it carries the PerformedWork flag, as mounted when it has no alternate —
 * gives per-component render and mount counts without touching product code.
 *
 * Install BEFORE react-dom is imported: the renderer reads the hook once, at
 * module evaluation. Test files therefore import react-dom dynamically after
 * calling {@link installRenderProbe}.
 */

interface FiberLike {
  tag: number;
  type: unknown;
  flags: number;
  alternate: FiberLike | null;
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedProps: Record<string, unknown> | null;
}

const PERFORMED_WORK = 0b1;
/* FunctionComponent, ForwardRef, SimpleMemoComponent. MemoComponent (14) wraps
   a FunctionComponent fiber of the same name, so it is skipped to avoid double
   counting. */
const COUNTED_TAGS = new Set([0, 11, 15]);

export interface RenderCounts {
  renders: Record<string, number>;
  mounts: Record<string, number>;
  /** `Component:path` for components whose props name a transcript. */
  byPath: Record<string, number>;
  commits: number;
}

export interface RenderProbe {
  /** Counts since the last reset. */
  snapshot(): RenderCounts;
  reset(): void;
  /** Convenience: renders of one component since the last reset. */
  renders(name: string): number;
  mounts(name: string): number;
  /** Renders of a path-bearing component (NodeShell, BranchPane, LogFeed) for one path. */
  rendersFor(name: string, path: string): number;
  uninstall(): void;
}

function componentName(fiber: FiberLike): string | null {
  let type = fiber.type as { displayName?: string; name?: string; render?: unknown } | null;
  if (fiber.tag === 11 && type && typeof type === "object") type = (type as { render?: unknown }).render as typeof type;
  if (typeof type !== "function") return null;
  const fn = type as unknown as { displayName?: string; name?: string };
  return fn.displayName || fn.name || null;
}

function pathOf(fiber: FiberLike): string | null {
  const props = fiber.memoizedProps;
  if (!props) return null;
  const node = props.node as { file?: { path?: string } } | undefined;
  if (node?.file?.path) return node.file.path;
  const file = props.file as { path?: string } | undefined;
  return file?.path ?? null;
}

export function installRenderProbe(): RenderProbe {
  let renders = new Map<string, number>();
  let mounts = new Map<string, number>();
  let byPath = new Map<string, number>();
  let commits = 0;
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  const visit = (fiber: FiberLike, freshSubtree: boolean): void => {
    const mounted = freshSubtree || fiber.alternate === null;
    if (COUNTED_TAGS.has(fiber.tag)) {
      const name = componentName(fiber);
      if (name) {
        if (mounted) bump(mounts, name);
        if (mounted || (fiber.flags & PERFORMED_WORK) !== 0) {
          bump(renders, name);
          const path = pathOf(fiber);
          if (path) bump(byPath, `${name}:${path}`);
        }
      }
    }
    if (mounted) {
      for (let child = fiber.child; child; child = child.sibling) visit(child, true);
      return;
    }
    /* A bailed-out subtree keeps the previous tree's child pointer: nothing
       below it did work, so there is nothing to count. */
    if (fiber.alternate && fiber.alternate.child === fiber.child) return;
    for (let child = fiber.child; child; child = child.sibling) visit(child, false);
  };

  let rendererId = 0;
  const hook = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map<number, unknown>(),
    inject(renderer: unknown): number {
      rendererId += 1;
      hook.renderers.set(rendererId, renderer);
      return rendererId;
    },
    onCommitFiberRoot(_id: number, root: { current: FiberLike }): void {
      commits += 1;
      const current = root.current;
      visit(current, current.alternate === null);
    },
    onCommitFiberUnmount(): void {},
    onPostCommitFiberRoot(): void {},
    onScheduleFiberRoot(): void {},
    setStrictMode(): void {},
    checkDCE(): void {},
  };
  const globals = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  const previous = globals.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;

  const toRecord = (map: Map<string, number>) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    snapshot: () => ({ renders: toRecord(renders), mounts: toRecord(mounts), byPath: toRecord(byPath), commits }),
    reset() {
      renders = new Map();
      mounts = new Map();
      byPath = new Map();
      commits = 0;
    },
    renders: (name) => renders.get(name) ?? 0,
    mounts: (name) => mounts.get(name) ?? 0,
    rendersFor: (name, path) => byPath.get(`${name}:${path}`) ?? 0,
    uninstall() {
      if (previous === undefined) delete globals.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      else globals.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
    },
  };
}
