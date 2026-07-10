import type { BoardProjectStateV1 } from "@/lib/view/types";

export type BoardMutationV1 =
  | { kind: "close"; path: string }
  | { kind: "restore"; path: string; placement: "auto" | "manual" | "expanded" }
  | { kind: "reconcile-roots"; roots: string[]; removeManual: string[] }
  | { kind: "remap-paths"; pairs: Array<{ from: string; to: string }> }
  | { kind: "set-presentation"; viewMode?: "scheme" | "list" | null; taskPanelOpen?: boolean };

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function aliasesOf(board: BoardProjectStateV1): Record<string, string> {
  return board.pathAliases ?? {};
}

function resolvePath(path: string, aliases: Record<string, string>): string {
  const seen = new Set<string>();
  let resolved = path;
  while (aliases[resolved] !== undefined) {
    if (seen.has(resolved)) throw new Error("board path alias cycle");
    seen.add(resolved);
    resolved = aliases[resolved]!;
  }
  return resolved;
}

function normalizedAliases(aliases: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const source of Object.keys(aliases)) {
    const target = resolvePath(source, aliases);
    if (source !== target) normalized[source] = target;
  }
  return normalized;
}

function normalize(board: BoardProjectStateV1, aliases = aliasesOf(board)): BoardProjectStateV1 {
  const canonicalAliases = normalizedAliases(aliases);
  const hidden = unique(board.prefs.hidden.map((item) => resolvePath(item, canonicalAliases)));
  const hiddenSet = new Set(hidden);
  const visible = (paths: readonly string[]) => unique(paths.map((item) => resolvePath(item, canonicalAliases)).filter((item) => !hiddenSet.has(item)));
  return {
    ...board,
    pathAliases: canonicalAliases,
    prefs: { ...board.prefs, manual: visible(board.prefs.manual), hidden, expanded: visible(board.prefs.expanded) },
  };
}

function remapPaths(board: BoardProjectStateV1, pairs: readonly { from: string; to: string }[]): BoardProjectStateV1 {
  const aliases = { ...aliasesOf(board) };
  for (const { from, to } of pairs) aliases[from] = to;
  return normalize(board, aliases);
}

function reconcileRoots(board: BoardProjectStateV1, roots: readonly string[], removeManual: readonly string[]): BoardProjectStateV1 {
  const aliases = aliasesOf(board);
  const removed = new Set(removeManual.map((item) => resolvePath(item, aliases)));
  const manual = board.prefs.manual.filter((item) => !removed.has(item));
  const present = new Set([...manual, ...board.prefs.hidden]);
  for (const root of roots.map((item) => resolvePath(item, aliases))) {
    if (!present.has(root)) {
      manual.push(root);
      present.add(root);
    }
  }
  return normalize({ ...board, prefs: { ...board.prefs, manual } });
}

function restore(board: BoardProjectStateV1, path: string, placement: "auto" | "manual" | "expanded"): BoardProjectStateV1 {
  const visible = { ...board.prefs, hidden: board.prefs.hidden.filter((item) => item !== path) };
  if (placement === "auto") return normalize({ ...board, prefs: visible });
  const withoutExplicitRole = {
    ...visible,
    manual: visible.manual.filter((item) => item !== path),
    expanded: visible.expanded.filter((item) => item !== path),
  };
  return normalize({
    ...board,
    prefs: placement === "manual"
      ? { ...withoutExplicitRole, manual: [...withoutExplicitRole.manual, path] }
      : { ...withoutExplicitRole, expanded: [...withoutExplicitRole.expanded, path] },
  });
}

export function applyBoardMutations(board: BoardProjectStateV1, mutations: readonly BoardMutationV1[]): BoardProjectStateV1 {
  let next = normalize(board);
  for (const mutation of mutations) {
    if (mutation.kind === "remap-paths") {
      next = remapPaths(next, mutation.pairs);
      continue;
    }
    if (mutation.kind === "reconcile-roots") {
      next = reconcileRoots(next, mutation.roots, mutation.removeManual);
      continue;
    }
    if (mutation.kind === "restore") {
      next = restore(next, resolvePath(mutation.path, aliasesOf(next)), mutation.placement);
      continue;
    }
    if (mutation.kind === "set-presentation") {
      next = normalize({
        ...next,
        prefs: {
          ...next.prefs,
          ...(mutation.viewMode === undefined ? {} : { viewMode: mutation.viewMode }),
          ...(mutation.taskPanelOpen === undefined ? {} : { taskPanelOpen: mutation.taskPanelOpen }),
        },
      });
      continue;
    }
    const path = resolvePath(mutation.path, aliasesOf(next));
    next = normalize({
      ...next,
      prefs: {
        ...next.prefs,
        manual: next.prefs.manual.filter((item) => item !== path),
        expanded: next.prefs.expanded.filter((item) => item !== path),
        hidden: unique([...next.prefs.hidden, path]),
      },
    });
  }
  return next;
}
