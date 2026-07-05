import { canStartFlow } from "@/components/flows/flowModel";
import type { Flow } from "@/lib/flows/types";

import type { SchemeNode } from "./layout";

export interface BulkItemResult {
  path: string;
  ok: boolean;
  error?: string;
}

export type BulkRunner = (path: string) => Promise<{ ok: true } | { ok: false; error: string }>;

function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBulk(
  paths: readonly string[],
  runner: BulkRunner,
  onProgress?: (results: readonly BulkItemResult[], current: string | null) => void,
): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];

  for (const path of paths) {
    try {
      const result = await runner(path);
      results.push(result.ok ? { path, ok: true } : { path, ok: false, error: result.error });
    } catch (error) {
      results.push({ path, ok: false, error: thrownMessage(error) });
    }
    onProgress?.(results, paths[results.length] ?? null);
  }

  return results;
}

/**
 * Wraps a runner so every per-path call re-checks the node still exists on
 * the board: a card that vanished mid-sweep (poll relayout, manual close)
 * must surface as a visible failure, never as a blind delivery.
 */
export function withPresenceGuard(present: () => ReadonlySet<string>, goneError: string, runner: BulkRunner): BulkRunner {
  return (path) => (present().has(path) ? runner(path) : Promise.resolve({ ok: false, error: goneError }));
}

export function canBulkMessage(node: SchemeNode): boolean {
  void node;
  return true;
}

export function canBulkInterrupt(node: SchemeNode): boolean {
  return node.file.pid !== null;
}

export function canBulkKill(node: SchemeNode): boolean {
  return node.isRoot;
}

export function canBulkRemove(node: SchemeNode): boolean {
  void node;
  return true;
}

export function canBulkFlow(node: SchemeNode, flowsByImpl: ReadonlyMap<string, Flow>): boolean {
  return canStartFlow(node.file, flowsByImpl);
}
