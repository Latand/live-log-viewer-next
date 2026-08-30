import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import type { ProjectSpawnResolution } from "./contracts";

/**
 * Account↔project bindings (issue #1279).
 *
 * The relation is many-to-many: an account may be allowed on many projects, a
 * project may allow many accounts. What it constrains is one direction only —
 * which accounts a project's work may run on. A project nobody has bound is
 * UNRESTRICTED for that engine, which is exactly the behaviour the Viewer has
 * always had, so the constraint is opt-in per project and per engine and the
 * first deploy changes nothing for anyone.
 *
 * The set is per engine on purpose: account ids are engine-scoped, so binding a
 * project to one Claude account must not silently forbid every Codex account
 * from it. Restriction begins for an engine at that engine's first binding.
 */

export type BindingEngine = "claude" | "codex";

export interface AccountProjectBinding {
  engine: BindingEngine;
  accountId: string;
  project: string;
  createdAt: string;
}

interface BindingFile {
  schemaVersion: 1;
  bindings: AccountProjectBinding[];
}

type BindingCache = {
  file: string;
  mtimeMs: number;
  size: number;
  bindings: AccountProjectBinding[];
};

let cache: BindingCache | null = null;

function bindingsFile(): string {
  return statePath("account-project-bindings.json");
}

function bindingList(value: unknown): AccountProjectBinding[] | null {
  if (!Array.isArray(value)) return null;
  const entries: AccountProjectBinding[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if ((record.engine !== "claude" && record.engine !== "codex")
      || typeof record.accountId !== "string" || !record.accountId.trim()
      || typeof record.project !== "string" || !record.project.trim()
      || typeof record.createdAt !== "string" || !record.createdAt.trim()) return null;
    entries.push({
      engine: record.engine,
      accountId: record.accountId,
      project: record.project,
      createdAt: record.createdAt,
    });
  }
  return entries;
}

function readBindings(): AccountProjectBinding[] {
  const file = bindingsFile();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = { file, mtimeMs: -1, size: -1, bindings: [] };
    return cache.bindings;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.bindings;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BindingFile>;
    const bindings = parsed.schemaVersion === 1 ? bindingList(parsed.bindings) : null;
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, bindings: bindings ?? [] };
    return cache.bindings;
  } catch {
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, bindings: [] };
    return cache.bindings;
  }
}

/** Every binding on record, ordered by engine, project, then account. */
export function accountProjectBindings(): AccountProjectBinding[] {
  return readBindings()
    .map((binding) => ({ ...binding }))
    .sort((left, right) =>
      left.engine.localeCompare(right.engine)
      || left.project.localeCompare(right.project)
      || left.accountId.localeCompare(right.accountId));
}

/** Drops the in-memory cache; the file stays authoritative. */
export function resetAccountProjectBindingsForTests(): void {
  cache = null;
}

function writeBindings(bindings: AccountProjectBinding[]): boolean {
  const file = bindingsFile();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, bindings } satisfies BindingFile, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(temporary, file);
    cache = null;
    return true;
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The next mutation retries the write.
    }
    return false;
  }
}

export type BindingMutationFailure =
  | "INVALID_ENGINE"
  | "INVALID_ACCOUNT"
  | "INVALID_PROJECT"
  | "STORE_ERROR"
  /** The write reported success and the re-read does not show it. Reported as
      its own failure rather than folded into STORE_ERROR: the caller has to be
      able to tell "the write was refused" from "the write claimed to land and
      the record disagrees", which is the failure this codebase has already
      shipped once as an action answering `ok` and changing nothing. */
  | "NOT_CONFIRMED";

export type BindingMutationResult =
  /** `bindings` is always the record re-read from disk after the write, never
      an echo of the request: it is the only evidence the change landed. */
  | { ok: true; changed: boolean; bindings: AccountProjectBinding[] }
  | { ok: false; code: BindingMutationFailure; message: string; bindings: AccountProjectBinding[] };

function normalized(engine: unknown, accountId: unknown, project: unknown):
  | { ok: true; engine: BindingEngine; accountId: string; project: string }
  | { ok: false; code: BindingMutationFailure; message: string } {
  if (engine !== "claude" && engine !== "codex") {
    return { ok: false, code: "INVALID_ENGINE", message: "engine must be claude or codex" };
  }
  const account = typeof accountId === "string" ? accountId.trim() : "";
  if (!account) return { ok: false, code: "INVALID_ACCOUNT", message: "accountId is required" };
  const key = typeof project === "string" ? project.trim() : "";
  if (!key) return { ok: false, code: "INVALID_PROJECT", message: "project is required" };
  return { ok: true, engine, accountId: account, project: key };
}

function sameBinding(binding: AccountProjectBinding, engine: BindingEngine, accountId: string, project: string): boolean {
  return binding.engine === engine && binding.accountId === accountId && binding.project === project;
}

/**
 * Allows `accountId` to carry `project`'s work. Idempotent. The result carries
 * the bindings re-read from the file, and the mutation is only reported `ok`
 * once that re-read actually contains the row.
 */
export function bindAccountToProject(
  engine: unknown,
  accountId: unknown,
  project: unknown,
  now: () => string = () => new Date().toISOString(),
): BindingMutationResult {
  const input = normalized(engine, accountId, project);
  if (!input.ok) return { ...input, bindings: accountProjectBindings() };
  const current = readBindings();
  const existing = current.some((binding) => sameBinding(binding, input.engine, input.accountId, input.project));
  if (!existing) {
    const next = [...current, { engine: input.engine, accountId: input.accountId, project: input.project, createdAt: now() }];
    if (!writeBindings(next)) {
      return { ok: false, code: "STORE_ERROR", message: "the binding could not be written", bindings: accountProjectBindings() };
    }
  }
  const confirmed = accountProjectBindings();
  if (!confirmed.some((binding) => sameBinding(binding, input.engine, input.accountId, input.project))) {
    return { ok: false, code: "NOT_CONFIRMED", message: "the binding is not present in the record read back", bindings: confirmed };
  }
  return { ok: true, changed: !existing, bindings: confirmed };
}

/** Removes one binding. Idempotent, and confirmed by the same re-read. */
export function unbindAccountFromProject(
  engine: unknown,
  accountId: unknown,
  project: unknown,
): BindingMutationResult {
  const input = normalized(engine, accountId, project);
  if (!input.ok) return { ...input, bindings: accountProjectBindings() };
  const current = readBindings();
  const next = current.filter((binding) => !sameBinding(binding, input.engine, input.accountId, input.project));
  const existed = next.length !== current.length;
  if (existed && !writeBindings(next)) {
    return { ok: false, code: "STORE_ERROR", message: "the binding could not be removed", bindings: accountProjectBindings() };
  }
  const confirmed = accountProjectBindings();
  if (confirmed.some((binding) => sameBinding(binding, input.engine, input.accountId, input.project))) {
    return { ok: false, code: "NOT_CONFIRMED", message: "the binding is still present in the record read back", bindings: confirmed };
  }
  return { ok: true, changed: existed, bindings: confirmed };
}

/**
 * The accounts `project` may use for `engine`, or `null` when the project has
 * no binding for that engine — which means every account, exactly as before.
 * `null` and `[]` are deliberately different answers: an empty array is a
 * project whose entire allowed set is unusable, and nothing may run there.
 */
export function allowedAccountIdsForProject(
  project: string | null | undefined,
  engine: BindingEngine,
  bindings: readonly AccountProjectBinding[] = readBindings(),
): string[] | null {
  const key = typeof project === "string" ? project.trim() : "";
  if (!key) return null;
  const allowed = bindings
    .filter((binding) => binding.engine === engine && binding.project === key)
    .map((binding) => binding.accountId);
  return allowed.length ? [...new Set(allowed)].sort() : null;
}

/** Projects an account is bound to, for the accounts-side view of the relation. */
export function projectsForAccount(
  engine: BindingEngine,
  accountId: string,
  bindings: readonly AccountProjectBinding[] = readBindings(),
): string[] {
  return [...new Set(bindings
    .filter((binding) => binding.engine === engine && binding.accountId === accountId)
    .map((binding) => binding.project))].sort();
}

/** True when `project` permits `accountId`, including the unbound case. */
export function projectAllowsAccount(
  project: string | null | undefined,
  engine: BindingEngine,
  accountId: string,
  bindings: readonly AccountProjectBinding[] = readBindings(),
): boolean {
  const allowed = allowedAccountIdsForProject(project, engine, bindings);
  return allowed === null || allowed.includes(accountId);
}

/**
 * The one wording for a binding refusal, so a parked stage, a parked flow and
 * an API error all say the same thing about the same state. The exhausted case
 * names capacity explicitly: the boundary held and the work is waiting, which
 * reads nothing like "no account exists".
 */
export function projectAccountRefusalDetail(
  resolution: Exclude<ProjectSpawnResolution, { kind: "available" }>,
  engine: BindingEngine,
  project: string,
): string {
  const allowed = resolution.allowedAccountIds.length
    ? `allowed ${engine} accounts: ${resolution.allowedAccountIds.join(", ")}`
    : `project ${project} allows no ${engine} account`;
  if (resolution.kind === "not_allowed") {
    return `${engine} account ${resolution.accountId} is not allowed on project ${project} (${allowed})`;
  }
  if (resolution.kind === "exhausted") {
    const reset = resolution.resetsAt === null ? "unknown" : new Date(resolution.resetsAt * 1_000).toISOString();
    return `no allowed ${engine} account has capacity for project ${project} (${allowed}); resetsAt=${reset}`;
  }
  return `no allowed ${engine} account is available for project ${project} (${allowed})`;
}
