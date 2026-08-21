import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";
import { readStateCollectionRevisions, readStateCollectionsRows } from "@/lib/state/sqliteStateStore";

/* 7: a cwd with no repository resolves to a directory-derived project
   (dir-<hash>) instead of "Unresolved project", so pooled unresolved
   identities must re-derive. */
export const PROJECT_RESOLUTION_VERSION = 7;

/* Project summaries depend on the attribution facts consumed by
   persistedProjects(). Hashing these stable projections keeps controller
   heartbeats and stage status updates from invalidating the whole catalog. */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function populatedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function pathList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((candidate) => {
    const pathname = populatedString(record(candidate)?.[key]);
    return pathname ? [pathname] : [];
  }))].sort();
}

function flowProjectFacts(value: unknown): unknown[] {
  const source = record(value);
  if (!source || !Array.isArray(source.flows)) return [];
  return source.flows.flatMap((candidate) => {
    const flow = record(candidate);
    const project = populatedString(flow?.project);
    const cwd = populatedString(flow?.cwd);
    if (!flow || !project || !cwd) return [];
    return [[
      project,
      cwd,
      populatedString(flow.implementerPath),
      pathList(flow.rounds, "reviewerPath"),
    ]];
  });
}

function workflowProjectFacts(value: unknown): unknown[] {
  const source = record(value);
  if (!source || !Array.isArray(source.workflows)) return [];
  return source.workflows.flatMap((candidate) => {
    const workflow = record(candidate);
    const project = populatedString(workflow?.project);
    const repoDir = populatedString(workflow?.repoDir);
    const worktreeDir = populatedString(workflow?.worktreeDir);
    if (!workflow || !project || (!repoDir && !worktreeDir)) return [];
    return [[
      project,
      repoDir,
      worktreeDir,
      pathList(workflow.stageRuns, "agentPath"),
      populatedString(workflow.fixerPath),
    ]];
  });
}

function stateJson(name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), name), "utf8")) as unknown;
  } catch {
    return null;
  }
}

const STATE_KEY_FILES = [
  "worktree-map.json",
  "project-aliases.json",
] as const;
let stateKeyCache: { signature: string; key: string } | null = null;

function fileSignature(dir: string, name: string): string {
  try {
    const st = fs.statSync(path.join(dir, name), { bigint: true });
    return `${name}:${st.mtimeNs}:${st.size}`;
  } catch {
    return `${name}:missing`;
  }
}

/** Cheap invalidation signature over the exact collections consumed below.
    Pipeline heartbeats in the shared database leave this key warm. */
function stateKeySignature(dir: string): string {
  const database = path.join(dir, "state.sqlite");
  const parts = [dir];
  const revisions = readStateCollectionRevisions(database, ["flows", "workflows"]);
  for (const [collection, legacy] of [["flows", "flows.json"], ["workflows", "workflows.json"]] as const) {
    const revision = revisions.get(collection) ?? null;
    parts.push(revision === null ? fileSignature(dir, legacy) : `${collection}:sqlite:${revision}`);
  }
  for (const name of STATE_KEY_FILES) parts.push(fileSignature(dir, name));
  return parts.join("|");
}

export function projectResolutionStateKey(): string {
  const dir = stateDir();
  const signature = stateKeySignature(dir);
  if (stateKeyCache?.signature === signature) return stateKeyCache.key;
  const key = computeProjectResolutionStateKey(dir);
  stateKeyCache = { signature, key };
  return key;
}

function computeProjectResolutionStateKey(dir: string): string {
  const hash = crypto.createHash("sha1");
  hash.update(dir);
  hash.update(`\0resolver-version\0${PROJECT_RESOLUTION_VERSION}`);
  const database = path.join(dir, "state.sqlite");
  const rows = readStateCollectionsRows(database, ["flows", "workflows"]);
  const flows = rows.get("flows") ?? null;
  const workflows = rows.get("workflows") ?? null;
  hash.update("\0flows\0");
  hash.update(JSON.stringify(flowProjectFacts(flows === null ? stateJson("flows.json") : { flows })));
  hash.update("\0workflows\0");
  hash.update(JSON.stringify(workflowProjectFacts(workflows === null ? stateJson("workflows.json") : { workflows })));
  hash.update("\0worktree-map.json\0");
  try {
    hash.update(fs.readFileSync(path.join(dir, "worktree-map.json")));
  } catch {
    hash.update("<missing>");
  }
  hash.update("\0project-aliases.json\0");
  try {
    hash.update(fs.readFileSync(path.join(dir, "project-aliases.json")));
  } catch {
    hash.update("<missing>");
  }
  return hash.digest("hex");
}
