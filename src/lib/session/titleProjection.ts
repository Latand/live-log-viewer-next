import fs from "node:fs";

import { agentRegistry, RegistryReadError } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { isRenameableSessionEntry } from "./renameEligibility";
import { applyTitleOverride, indexSessionTitles, loadSessionTitles } from "./titleStore";

type Registry = ReturnType<typeof agentRegistry>;
type RegistrySnapshot = ReturnType<Registry["snapshot"]>;

interface RegistryProjection {
  signature: string;
  snapshot: RegistrySnapshot;
  conversationByPath: Map<string, ViewerConversationId>;
  aliasesByCanonical: Map<string, string[]>;
  ownedPathsByConversation: Map<string, string[]>;
  projectByPath: Map<string, string>;
  archivedPaths: Set<string>;
}

const registryProjectionCache = new WeakMap<Registry, RegistryProjection>();

function registrySignature(registry: Registry): string {
  try {
    const stat = fs.statSync(registry.filename, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

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

function registryProjection(registry: Registry, surfaceUnexpectedError = false): RegistryProjection | null {
  const signature = registrySignature(registry);
  const cached = registryProjectionCache.get(registry);
  if (cached?.signature === signature) return cached;
  let snapshot: RegistrySnapshot;
  try {
    snapshot = registry.snapshot();
  } catch (error) {
    if (surfaceUnexpectedError && !(error instanceof RegistryReadError)) throw error;
    return null;
  }
  const conversationByPath = new Map<string, ViewerConversationId>();
  const aliasesByCanonical = new Map<string, string[]>();
  const ownedPathsByConversation = new Map<string, string[]>();
  const projectByPath = new Map<string, string>();
  const archivedPaths = new Set<string>();
  for (const conversation of Object.values(snapshot.conversations)) {
    const owned = [...conversation.generations.map((generation) => generation.path), ...conversation.continuityPaths];
    ownedPathsByConversation.set(conversation.id, owned);
    for (const pathname of owned) if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation.id);
    const latest = conversation.generations.at(-1);
    if (!latest) continue;
    if (latest.launchProfile.project) projectByPath.set(latest.path, latest.launchProfile.project);
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
    conversationByPath,
    aliasesByCanonical,
    ownedPathsByConversation,
    projectByPath,
    archivedPaths,
  };
  registryProjectionCache.set(registry, projection);
  return projection;
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
export function overlaySessionTitles(entries: FileEntry[]): void {
  const project = sessionTitleProjector();
  for (const entry of entries) project(entry);
}

function sessionTitleProjector(): (entry: FileEntry) => void {
  const index = indexSessionTitles(loadSessionTitles());
  const registry = agentRegistry();
  const projection = registryProjection(registry);
  const snapshot = projection?.snapshot ?? null;
  const conversationByPath = projection?.conversationByPath ?? new Map<string, ViewerConversationId>();
  const aliasesByCanonical = projection?.aliasesByCanonical ?? new Map<string, string[]>();
  const ownedPathsByConversation = projection?.ownedPathsByConversation ?? new Map<string, string[]>();

  return (entry) => {
    if (entry.engine !== "claude" && entry.engine !== "codex") return;
    const owner = conversationByPath.get(entry.path);
    if (!entry.conversationId) {
      if (owner) entry.conversationId = owner;
    }
    const conversation = owner ? snapshot?.conversations[owner] : undefined;
    const latest = conversation?.generations.at(-1);
    if (latest?.path === entry.path) {
      entry.title = latest.launchProfile.title ?? entry.title;
      entry.project = latest.launchProfile.project ?? entry.project;
    }
    entry.renamable = isRenameableSessionEntry(entry);
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
  archivedPaths: ReadonlySet<string>;
} {
  const projection = registryProjection(agentRegistry(), surfaceUnexpectedError);
  if (!projection) return { projectByPath: new Map(), archivedPaths: new Set() };
  return { projectByPath: projection.projectByPath, archivedPaths: projection.archivedPaths };
}
