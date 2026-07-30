import fs from "node:fs";

import {
  agentRegistry,
  normalizeRegistry,
  readOnlyConversationLookupFromSnapshot,
  RegistryReadError,
  type ReadOnlyConversationLookup,
  type RegistryFile,
} from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { statePath } from "@/lib/configDir";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import type { FileEntry } from "@/lib/types";

import { resolveProjectAttribution } from "./projectResolution";

import { isRenameableSessionEntry } from "./renameEligibility";
import { applyTitleOverride, indexSessionTitles, loadSessionTitles } from "./titleStore";

type Registry = ReturnType<typeof agentRegistry>;
type RegistrySnapshot = RegistryFile;

export interface SessionRegistryProjection {
  signature: string;
  snapshot: RegistrySnapshot;
  conversationLookup: ReadOnlyConversationLookup;
  conversationByPath: Map<string, ViewerConversationId>;
  aliasesByCanonical: Map<string, string[]>;
  ownedPathsByConversation: Map<string, string[]>;
  projectByPath: Map<string, string>;
  projectMetadataByPath: Map<string, { displayName: string; projectRoot?: string; unresolved?: true }>;
  archivedPaths: Set<string>;
}

const registryProjectionCache = new WeakMap<RegistrySnapshot, SessionRegistryProjection>();
let readOnlyRegistryProjectionCache: SessionRegistryProjection | null = null;

function canonicalConversationId(snapshot: RegistrySnapshot, alias: string): string {
  let current = alias;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = snapshot.conversationAliases[current];
    if (!next) break;
    current = next;
  }
  return current;
}

function projectRegistrySnapshot(snapshot: RegistrySnapshot, signature: string): SessionRegistryProjection {
  const conversationByPath = new Map<string, ViewerConversationId>();
  const aliasesByCanonical = new Map<string, string[]>();
  const ownedPathsByConversation = new Map<string, string[]>();
  const projectByPath = new Map<string, string>();
  const projectMetadataByPath = new Map<string, { displayName: string; projectRoot?: string; unresolved?: true }>();
  const archivedPaths = new Set<string>();
  const projectInfoByCwd = new Map<string, ReturnType<typeof projectInfoFromCwd>>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const owned = [...conversation.generations.map((generation) => generation.path), ...conversation.continuityPaths];
    ownedPathsByConversation.set(conversation.id, owned);
    for (const pathname of owned) if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation.id);
    const latest = conversation.generations.at(-1);
    if (!latest) continue;
    const { project } = resolveProjectAttribution({
      projectOwnership: conversation.projectOwnership,
      cwd: latest.launchProfile.cwd,
      launchProfileProject: latest.launchProfile.project,
    });
    if (project) {
      projectByPath.set(latest.path, project);
      const cwd = latest.launchProfile.cwd;
      let cwdInfo = cwd ? projectInfoByCwd.get(cwd) : null;
      if (cwd && cwdInfo === undefined) {
        cwdInfo = projectInfoFromCwd(cwd);
        projectInfoByCwd.set(cwd, cwdInfo);
      }
      if (cwdInfo?.project === project) {
        projectMetadataByPath.set(latest.path, {
          displayName: cwdInfo.displayName,
          ...(cwdInfo.repo ? { projectRoot: cwdInfo.repo } : {}),
          ...(cwdInfo.unresolved ? { unresolved: true as const } : {}),
        });
      }
    }
    for (const generation of conversation.generations) {
      if (generation.path !== latest.path) archivedPaths.add(generation.path);
    }
    for (const pathname of conversation.continuityPaths) {
      if (pathname !== latest.path) archivedPaths.add(pathname);
    }
  }
  for (const alias of Object.keys(snapshot.conversationAliases)) {
    const canonical = canonicalConversationId(snapshot, alias);
    if (canonical === alias) continue;
    const list = aliasesByCanonical.get(canonical);
    if (list) list.push(alias); else aliasesByCanonical.set(canonical, [alias]);
  }
  const projection = {
    signature,
    snapshot,
    conversationLookup: readOnlyConversationLookupFromSnapshot(snapshot, conversationByPath),
    conversationByPath,
    aliasesByCanonical,
    ownedPathsByConversation,
    projectByPath,
    projectMetadataByPath,
    archivedPaths,
  };
  registryProjectionCache.set(snapshot, projection);
  return projection;
}

/** Builds the reusable title/catalog read model for an already acquired
    immutable registry snapshot. SQLite returns the same snapshot object for one
    revision, so mirror checkpoints cannot invalidate this cache. */
export function sessionRegistryProjectionFromSnapshot(
  snapshot: RegistrySnapshot,
  signature = "registry-snapshot",
): SessionRegistryProjection {
  return registryProjectionCache.get(snapshot) ?? projectRegistrySnapshot(snapshot, signature);
}

/** Acquires at most one immutable registry snapshot and returns its reusable
    title/catalog projection. */
export function sessionRegistryProjection(
  registry: Registry = agentRegistry(),
  surfaceUnexpectedError = false,
): SessionRegistryProjection | null {
  try {
    return sessionRegistryProjectionFromSnapshot(registry.readOnlySnapshot());
  } catch (error) {
    if (surfaceUnexpectedError && !(error instanceof RegistryReadError)) throw error;
    return null;
  }
}

function readOnlyRegistryProjection(): SessionRegistryProjection | null {
  const filename = statePath("agent-registry.json");
  let signature: string;
  try {
    const stat = fs.statSync(filename, { bigint: true });
    signature = `${filename}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return null;
  }
  if (readOnlyRegistryProjectionCache?.signature === signature) return readOnlyRegistryProjectionCache;
  try {
    const snapshot = normalizeRegistry(JSON.parse(fs.readFileSync(filename, "utf8")));
    readOnlyRegistryProjectionCache = projectRegistrySnapshot(snapshot, signature);
    return readOnlyRegistryProjectionCache;
  } catch {
    return null;
  }
}

/**
 * The single projection for user-visible session metadata. The latest registry
 * launch profile supplies its title and project, then a custom title (issue
 * #33) has final precedence for every server consumer: files, conversation
 * search, push notifications, `/api/timeline`, and `/api/resources`.
 *
 * Stamps `conversationId` when the registry owns the path (needed for the
 * conversation-keyed override lookup, and a bonus canonical deep link for
 * push), applies the alias-aware override, and sets `renamable`. Idempotent and
 * safe to run after the files response has already stamped identity/launch
 * profile — it never re-derives `autoTitle` once set.
 */
export function overlaySessionTitles(
  entries: FileEntry[],
  projection?: SessionRegistryProjection | null,
): void {
  const project = sessionTitleProjector(true, projection);
  for (const entry of entries) project(entry);
}

/** Applies resource-facing identity and titles while leaving the files-route
 * rename eligibility pass to its regular bounded shortlist. */
export function overlayResourceSessionTitles(entries: FileEntry[]): void {
  const project = sessionTitleProjector(false, readOnlyRegistryProjection());
  for (const entry of entries) project(entry);
}

function sessionTitleProjector(
  includeRenameEligibility = true,
  suppliedProjection?: SessionRegistryProjection | null,
): (entry: FileEntry) => void {
  const index = indexSessionTitles(loadSessionTitles());
  const projection = suppliedProjection === undefined ? sessionRegistryProjection() : suppliedProjection;
  const snapshot = projection?.snapshot ?? null;
  const conversationByPath = projection?.conversationByPath ?? new Map<string, ViewerConversationId>();
  const aliasesByCanonical = projection?.aliasesByCanonical ?? new Map<string, string[]>();
  const ownedPathsByConversation = projection?.ownedPathsByConversation ?? new Map<string, string[]>();

  return (entry) => {
    if (entry.engine !== "claude" && entry.engine !== "codex") return;
    if (entry.spawn) {
      entry.renamable = false;
      return;
    }
    const owner = conversationByPath.get(entry.path);
    if (!entry.conversationId) {
      if (owner) entry.conversationId = owner;
    }
    const conversation = owner ? snapshot?.conversations[owner] : undefined;
    const latest = conversation?.generations.at(-1);
    if (latest?.path === entry.path) {
      entry.title = latest.launchProfile.title ?? entry.title;
      entry.project = resolveProjectAttribution({
        projectOwnership: conversation?.projectOwnership,
        cwd: latest.launchProfile.cwd,
        launchProfileProject: latest.launchProfile.project,
        fallbackProject: entry.project,
      }).project ?? entry.project;
      const projectMetadata = projection?.projectMetadataByPath.get(entry.path);
      if (projectMetadata) {
        entry.projectName = projectMetadata.displayName;
        entry.projectRoot = projectMetadata.projectRoot ?? entry.projectRoot;
        entry.projectUnresolved = projectMetadata.unresolved;
      }
      if (conversation?.projectOwnership) entry.projectOwnership = { ...conversation.projectOwnership };
    }
    if (includeRenameEligibility) entry.renamable = isRenameableSessionEntry(entry);
    if (index.size > 0) {
      const aliases = entry.conversationId ? aliasesByCanonical.get(entry.conversationId) ?? [] : [];
      const ownedPaths = entry.conversationId ? ownedPathsByConversation.get(entry.conversationId) ?? [] : [];
      applyTitleOverride(entry, index, aliases, ownedPaths);
    }
  };
}

/** Applies the canonical title projection to a full search index while
 * yielding between batches so a cold global search does not monopolize the
 * server event loop. */
export async function overlaySessionTitlesYielding(
  entries: FileEntry[],
  batchSize = 48,
  yieldControl: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<void> {
  const project = sessionTitleProjector();
  for (let index = 0; index < entries.length; index += 1) {
    project(entries[index]);
    if ((index + 1) % batchSize === 0) await yieldControl();
  }
}

/** Projects registry launch-profile projects before an empty-query project
 * filter runs. This stays metadata-only and leaves transcript heads untouched. */
export function overlaySessionProjects(entries: FileEntry[]): void {
  const projectByPath = sessionProjectProjection().projectByPath;
  for (const entry of entries) {
    const project = projectByPath.get(entry.path);
    if (project) entry.project = project;
  }
}

/** Registry metadata that shapes the scanner shortlist. Reading this through
 * the same signature cache as title projection keeps repeated scheme scans
 * free of another registry parse. */
export function sessionProjectProjection(surfaceUnexpectedError = false): {
  projectByPath: ReadonlyMap<string, string>;
  projectMetadataByPath: ReadonlyMap<string, { displayName: string; projectRoot?: string; unresolved?: true }>;
  archivedPaths: ReadonlySet<string>;
} {
  const projection = sessionRegistryProjection(agentRegistry(), surfaceUnexpectedError);
  if (!projection) return { projectByPath: new Map(), projectMetadataByPath: new Map(), archivedPaths: new Set() };
  return {
    projectByPath: projection.projectByPath,
    projectMetadataByPath: projection.projectMetadataByPath,
    archivedPaths: projection.archivedPaths,
  };
}
