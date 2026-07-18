import crypto from "node:crypto";

export type SpawnParentSelector = { conversationId: string } | { path: string } | null;

export interface SpawnRequestIdentity {
  engine: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  fast: boolean | null;
  accountId: string | null;
  role: string | null;
  allowSubagents?: boolean;
  /** Explicit operator project ownership; absent for cwd-attributed spawns. */
  project?: string;
  parent: SpawnParentSelector;
  reviews?: SpawnParentSelector;
  /** Predecessor conversation this spawn terminally supersedes (issue #383). */
  supersedes?: SpawnParentSelector;
  prompt: string;
  images: Array<{ mime: string; digest: string }>;
}

function digest(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function spawnContentDigest(input: unknown): string {
  return digest(input);
}

export function spawnParentSelector(body: { src?: unknown; parent?: unknown; parentConversationId?: unknown }): SpawnParentSelector {
  if (typeof body.parentConversationId === "string") return { conversationId: body.parentConversationId };
  if (typeof body.parent === "string") return { path: body.parent };
  return typeof body.src === "string" ? { path: body.src } : null;
}

export function spawnRequestDigest(input: SpawnRequestIdentity): string {
  return digest(input);
}
