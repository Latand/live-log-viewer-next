import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "@/lib/configDir";

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

const STATE_KEY_FILES = ["flows.json", "workflows.json", "worktree-map.json", "project-aliases.json"] as const;
let stateKeyCache: { signature: string; key: string } | null = null;

/** Cheap invalidation signature over the four source files: the full key
    below parses megabytes and hashes them, and production called it for
    every described entry — ~75 uncached reads of flows.json per second
    pinned the event loop in a GC storm. Four stats replace that until a
    source file actually changes. */
function stateKeySignature(dir: string): string {
  const parts = [dir];
  for (const name of STATE_KEY_FILES) {
    try {
      const st = fs.statSync(path.join(dir, name), { bigint: true });
      parts.push(`${name}:${st.mtimeNs}:${st.size}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
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
  hash.update("\0flows.json\0");
  hash.update(JSON.stringify(flowProjectFacts(stateJson("flows.json"))));
  hash.update("\0workflows.json\0");
  hash.update(JSON.stringify(workflowProjectFacts(stateJson("workflows.json"))));
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
