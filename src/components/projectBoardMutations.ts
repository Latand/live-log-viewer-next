import type { BoardMutationV1 } from "@/lib/board/mutations";
import type { FileEntry } from "@/lib/types";

import { isChildConversation, projectKey } from "./projectModel";

/** The minimal branch-group shape the board planner needs: a group's root key
    and whether it is a parentless background task. Orphan-task groups dock as
    strips and never seed a durable root, so they are excluded from reconciliation. */
export interface RootGroupLike {
  key: string;
  orphanTask: boolean;
}

/**
 * Plan a root reconciliation. The board's durable `manual` list holds one entry
 * per quiet root so a branch keeps its place until the user closes it. This
 * derives the mutation that seeds every current root and retires the entries that
 * never belonged there:
 *
 * - `roots` is every non-orphan group key. Children/subagents derive their
 *   placement from lineage and expansion, so only roots are seeded — this is the
 *   fix for the 40-entry churn where every column (children included) piled into
 *   `manual` and oscillated under the old positional cap.
 * - `removeManual` retires a manual entry that is a child/subagent conversation
 *   (pollution), plus a missing path when the caller has complete catalog
 *   membership. A capped catalog preserves missing paths because they can still
 *   exist on disk. The server reducer preserves hidden tombstones, so a closed
 *   root that left `manual` cannot be resurrected here.
 */
export function planRootReconciliation(input: {
  groups: readonly RootGroupLike[];
  manual: readonly string[];
  catalog: ReadonlyMap<string, FileEntry>;
  catalogComplete?: boolean;
}): Extract<BoardMutationV1, { kind: "reconcile-roots" }> {
  const roots = input.groups.filter((group) => !group.orphanTask).map((group) => group.key);
  const rootSet = new Set(roots);
  const removeManual = input.manual.filter((path) => {
    if (rootSet.has(path)) return false;
    const file = input.catalog.get(path);
    if (!file) return input.catalogComplete !== false && path.endsWith(".jsonl");
    return isChildConversation(file);
  });
  return { kind: "reconcile-roots", roots, removeManual };
}

/**
 * Plan the account-migration succession remap. Each successor file carries its
 * `predecessorPath`; one alias pair (predecessor → current path) per successor,
 * deduplicated by predecessor, lets the server rewrite every membership array
 * atomically so hidden/manual/expanded state follows the stable conversation
 * identity across the rename. Returns null when no succession is observed.
 */
export function planSuccessionRemap(
  files: readonly FileEntry[],
  project: string,
): Extract<BoardMutationV1, { kind: "remap-paths" }> | null {
  const pairs: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const from = file.predecessorPath;
    if (from && projectKey(file) === project && from !== file.path && !seen.has(from)) {
      seen.add(from);
      pairs.push({ from, to: file.path });
    }
  }
  return pairs.length ? { kind: "remap-paths", pairs } : null;
}

/**
 * The full board-convergence batch dispatched from the dashboard on catalog and
 * group changes: succession remap first, then root reconciliation. Order matters —
 * reconciliation must observe the remapped memberships so a predecessor's hidden
 * tombstone, moved onto its successor by the remap, is honored and the successor
 * is never re-seeded into `manual`. Both mutations are idempotent, so a repeat
 * batch reduces to a no-op the store drops before transport.
 */
export function planBoardConvergence(input: {
  files: readonly FileEntry[];
  groups: readonly RootGroupLike[];
  manual: readonly string[];
  catalog: ReadonlyMap<string, FileEntry>;
  catalogComplete?: boolean;
  project: string;
}): BoardMutationV1[] {
  const batch: BoardMutationV1[] = [];
  const remap = planSuccessionRemap(input.files, input.project);
  if (remap) batch.push(remap);
  batch.push(planRootReconciliation({
    groups: input.groups,
    manual: input.manual,
    catalog: input.catalog,
    catalogComplete: input.catalogComplete,
  }));
  return batch;
}

/**
 * The close action. A user's close is always durable: it emits exactly one
 * `close` mutation regardless of whether the node is currently an auto column,
 * a manual entry, or a hand-expanded child — the server reducer tombstones the
 * path and strips every membership shape. Any local ephemeral jump target for the
 * same path is dropped so it does not linger after the card is gone.
 */
export function planClose(
  path: string,
  ephemeral: readonly string[],
): { mutation: Extract<BoardMutationV1, { kind: "close" }>; ephemeral: string[] } {
  return { mutation: { kind: "close", path }, ephemeral: ephemeral.filter((item) => item !== path) };
}
