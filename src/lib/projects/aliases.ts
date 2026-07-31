import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import {
  projectIdentityFromRepositoryRoot,
  repositoryRootForPath,
} from "@/lib/projects/identity";

export interface ProjectAliasRegistration {
  source: string;
  target: string;
  displayName: string;
}

export interface ProjectAliasSnapshot {
  aliases: Record<string, string>;
  displayNames: Record<string, string>;
}

export interface DurableProjectAliasCandidates {
  registrations: ProjectAliasRegistration[];
  conflicts: string[];
}

interface ProjectAliasFile extends ProjectAliasSnapshot {
  schemaVersion: 1;
}

type AliasCache = {
  file: string;
  mtimeMs: number;
  size: number;
  snapshot: ProjectAliasSnapshot;
};

let cache: AliasCache | null = null;

function aliasesFile(): string {
  return statePath("project-aliases.json");
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([key, item]) => Boolean(key.trim()) && typeof item === "string" && Boolean(item.trim()))
    ? Object.fromEntries(entries)
    : null;
}

function readSnapshot(): ProjectAliasSnapshot {
  const file = aliasesFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { file, mtimeMs: -1, size: -1, snapshot: { aliases: {}, displayNames: {} } };
    return cache.snapshot;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.snapshot;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectAliasFile>;
    const aliases = parsed.schemaVersion === 1 ? stringRecord(parsed.aliases) : null;
    const displayNames = parsed.schemaVersion === 1 ? stringRecord(parsed.displayNames) : null;
    const snapshot = aliases && displayNames ? { aliases, displayNames } : { aliases: {}, displayNames: {} };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  } catch {
    const snapshot = { aliases: {}, displayNames: {} };
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  }
}

function resolveAlias(project: string, aliases: Readonly<Record<string, string>>): string {
  let current = project;
  const seen = new Set<string>();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current]!;
  }
  return seen.has(current) ? project : current;
}

export function canonicalProject(project: string): string {
  return resolveAlias(project, readSnapshot().aliases);
}

export function projectAliasSnapshot(): ProjectAliasSnapshot {
  const snapshot = readSnapshot();
  return {
    aliases: { ...snapshot.aliases },
    displayNames: { ...snapshot.displayNames },
  };
}

function readObject(filename: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(filename), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function storedWorktreeRepositories(): ReadonlyMap<string, string> {
  const stored = readObject("worktree-map.json");
  if (!stored) return new Map();
  const repositories = new Map<string, string>();
  for (const [cwd, value] of Object.entries(stored)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const repo = (value as Record<string, unknown>).repo;
    if (typeof repo === "string" && repo.trim()) repositories.set(cwd, repo);
  }
  return repositories;
}

function projectPathPairs(filename: string, collection: string, pathField: string): Array<[string, string]> {
  const stored = readObject(filename)?.[collection];
  if (!Array.isArray(stored)) return [];
  const pairs: Array<[string, string]> = [];
  for (const value of stored) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.project === "string" && record.project.trim()
      && typeof record[pathField] === "string" && record[pathField].trim()) {
      pairs.push([record.project, record[pathField]]);
    }
  }
  return pairs;
}

function collectionRecords(filename: string, collection: string): Record<string, unknown>[] {
  const stored = readObject(filename)?.[collection];
  return Array.isArray(stored)
    ? stored.filter((value): value is Record<string, unknown> => (
        Boolean(value) && typeof value === "object" && !Array.isArray(value)
      ))
    : [];
}

function convergenceIdCollisions(registrations: readonly ProjectAliasRegistration[]): {
  labels: string[];
  sources: Set<string>;
} {
  const proposed = new Map(registrations.map((registration) => [registration.source, registration.target]));
  const labels = new Set<string>();
  const sources = new Set<string>();
  for (const [filename, collection] of [
    ["tasks.json", "tasks"],
    ["flows.json", "flows"],
    ["pipelines.json", "pipelines"],
    ["workflows.json", "workflows"],
  ] as const) {
    const seen = new Map<string, string>();
    for (const record of collectionRecords(filename, collection)) {
      if (typeof record.id !== "string" || !record.id.trim()
        || typeof record.project !== "string" || !record.project.trim()) continue;
      const current = canonicalProject(record.project);
      const target = proposed.get(current) ?? current;
      const key = `${target}\0${record.id}`;
      const held = seen.get(key);
      if (held && held !== current) {
        labels.add(`${collection} id collision`);
        if (proposed.has(held)) sources.add(held);
        if (proposed.has(current)) sources.add(current);
      } else {
        seen.set(key, current);
      }
    }
  }
  return { labels: [...labels], sources };
}

type TargetEvidence = { registration: ProjectAliasRegistration; records: number };

/**
 * Pre-change flow, pipeline, and workflow records carry both the legacy
 * project key and a repository path. Re-resolving those paths establishes an
 * alias even when the prior project catalog has already disappeared. One stale
 * record stamped with a foreign checkout must not poison a source the rest of
 * the records agree on, so each source resolves by strict record majority and
 * only a genuinely split source is reported as a conflict.
 */
export function durableProjectAliasCandidates(): DurableProjectAliasCandidates {
  const rememberedRepositories = storedWorktreeRepositories();
  const pairs = [
    ...projectPathPairs("flows.json", "flows", "cwd"),
    ...projectPathPairs("pipelines.json", "pipelines", "repoDir"),
    ...projectPathPairs("workflows.json", "workflows", "repoDir"),
  ];
  const targets = new Map<string, Map<string, TargetEvidence>>();
  for (const [source, candidatePath] of pairs) {
    const root = repositoryRootForPath(candidatePath) ?? rememberedRepositories.get(candidatePath);
    const identity = root ? projectIdentityFromRepositoryRoot(root) : null;
    if (!identity) continue;
    const sourceTargets = targets.get(source) ?? new Map<string, TargetEvidence>();
    const evidence = sourceTargets.get(identity.project) ?? {
      registration: { source, target: identity.project, displayName: identity.displayName },
      records: 0,
    };
    evidence.records += 1;
    sourceTargets.set(identity.project, evidence);
    targets.set(source, sourceTargets);
  }
  const registrations: ProjectAliasRegistration[] = [];
  const conflicts: string[] = [];
  for (const [source, sourceTargets] of targets) {
    /* A repository id that still points at its own repository is already a
       valid canonical identity. Historical records stamped with that same id
       while rooted in another repository are per-record corruption; turning
       them into a global alias would merge two unrelated boards. */
    if (sourceTargets.has(source)) {
      if (sourceTargets.size > 1) conflicts.push(source);
      continue;
    }
    const ranked = [...sourceTargets.values()].sort((left, right) => right.records - left.records);
    const total = ranked.reduce((sum, evidence) => sum + evidence.records, 0);
    const leader = ranked[0]!;
    if (leader.records * 2 > total) registrations.push(leader.registration);
    else conflicts.push(source);
  }
  const collisions = convergenceIdCollisions(registrations);
  conflicts.push(...collisions.labels);
  return {
    registrations: registrations.filter((registration) => !collisions.sources.has(registration.source)),
    conflicts,
  };
}

function mergeRegistrations(
  registrations: readonly ProjectAliasRegistration[],
): ProjectAliasSnapshot | null {
  const current = readSnapshot();
  const aliases = { ...current.aliases };
  const displayNames = { ...current.displayNames };
  for (const registration of registrations) {
    const source = registration.source.trim();
    const target = resolveAlias(registration.target.trim(), aliases);
    const displayName = registration.displayName.trim();
    if (!source || !target || !displayName) return null;
    const held = aliases[source] ? resolveAlias(aliases[source]!, aliases) : null;
    if (held && held !== target) return null;
    if (source !== target) aliases[source] = target;
    displayNames[target] = displayName;
  }
  return { aliases, displayNames };
}

export function projectAliasesCanAccept(registrations: readonly ProjectAliasRegistration[]): boolean {
  return mergeRegistrations(registrations) !== null;
}

export function persistProjectAliases(registrations: readonly ProjectAliasRegistration[]): boolean {
  if (registrations.length === 0) return true;
  const merged = mergeRegistrations(registrations);
  if (!merged) return false;
  const file = aliasesFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, ...merged } satisfies ProjectAliasFile, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    cache = null;
    readSnapshot();
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // A later catalog pass retries the alias publication.
    }
    return false;
  }
}

export function resetProjectAliasesForTests(): void {
  cache = null;
}
