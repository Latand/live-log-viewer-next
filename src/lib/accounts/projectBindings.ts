import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";
import { writeJsonDurably } from "@/lib/state/durableJson";

import { AccountMutationBusyError, withAccountMutationLock } from "./accountMutation";
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
 *
 * The record therefore has THREE states, not two, and the third is the one that
 * matters most: ABSENT means unbound, READABLE is enforced, and DAMAGED —
 * malformed, unsupported or unreadable — refuses. A damaged record read as an
 * empty list would say "nobody bound anything", which allows every account on
 * exactly the projects a binding was written to reserve; the reservation would
 * disappear in the one condition where it matters most. Every read below throws
 * instead, and the throw parks the launch, the reseat and the switch.
 *
 * ABSENT is the narrow state, and only a CONFIRMED absence qualifies: nothing
 * at the record's pathname at all. Everything that merely resembles absence
 * from inside a failed read — a state path that is a regular file, a dangling
 * link where the record belongs — is damage, and widens nothing.
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

/** The record's name, in messages an operator has to act on. */
const RECORD_NAME = "account-project-bindings.json";

/**
 * The record exists and this process cannot turn it into a binding list.
 *
 * Thrown by every read that was not given an explicit list, so no caller can
 * mistake a damaged record for an unbound project. Callers that launch work
 * park with this message; callers that mutate refuse without writing, which
 * also keeps a damaged record intact for repair instead of overwriting it.
 */
export class AccountProjectBindingsUnreadableError extends Error {
  constructor(readonly reason: string) {
    super(`the account↔project binding record ${RECORD_NAME} is unreadable (${reason}); no account may be selected for a project until it is repaired or removed`);
    this.name = "AccountProjectBindingsUnreadableError";
  }
}

function bindingsFile(): string {
  return statePath(RECORD_NAME);
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

/**
 * Whether the record's pathname holds nothing at all — the one state that means
 * "nobody bound anything".
 *
 * A failed read cannot answer this on its own: `readFileSync` reports ENOENT
 * both for a pathname with nothing at it AND for a symlink whose target is
 * gone. `lstat` does not follow that last link, so a dangling link answers with
 * the link's own stats — an entry IS there and this process failed to read it.
 * An lstat that fails for any other reason (ENOTDIR when a parent component is
 * a file, EACCES on the directory) leaves absence unestablished, which refuses
 * for the same reason.
 */
function bindingPathnameAbsence(file: string): { absent: true } | { absent: false; reason: string } {
  try {
    fs.lstatSync(file);
    return { absent: false, reason: "an entry at the record's pathname could not be read (a dangling link)" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { absent: true };
    return {
      absent: false,
      reason: code
        ? `the record could not be read and its pathname could not be inspected (${code})`
        : "the record could not be read and its pathname could not be inspected",
    };
  }
}

/**
 * The record, read from disk on every call. No cache: the file is one small
 * record written by an atomic rename, and a cache keyed on mtime and size
 * cannot see a same-millisecond same-size write by another process — which is
 * the write that would drop a fence this process then keeps enforcing from
 * memory.
 *
 * Absent means unbound. Anything else that stops this function from producing a
 * list is a refusal.
 */
function readBindings(): AccountProjectBinding[] {
  const file = bindingsFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    /* ENOENT is the ONLY errno that can mean unbound, and only once the
       pathname is confirmed to hold nothing. Every other errno — ENOTDIR,
       EACCES, EISDIR, ELOOP, EIO — is a record this process failed to read,
       which is not the same statement as "nobody bound anything": answered as
       one, the fence every bound project was given disappears at once, and a
       forbidden account becomes allowed everywhere. ENOTDIR is the one that
       shipped: a regular file in the state path read as "no project is bound". */
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const absence = bindingPathnameAbsence(file);
      if (absence.absent) return [];
      throw new AccountProjectBindingsUnreadableError(absence.reason);
    }
    throw new AccountProjectBindingsUnreadableError(code ? `the read failed with ${code}` : "the read failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new AccountProjectBindingsUnreadableError("the record is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AccountProjectBindingsUnreadableError("the record is not a binding file");
  }
  const record = parsed as Partial<BindingFile>;
  if (record.schemaVersion !== 1) {
    throw new AccountProjectBindingsUnreadableError(typeof record.schemaVersion === "number"
      ? `the record's schemaVersion ${record.schemaVersion} is not supported`
      : "the record names no supported schemaVersion");
  }
  const bindings = bindingList(record.bindings);
  if (!bindings) throw new AccountProjectBindingsUnreadableError("the record's bindings are malformed");
  return bindings;
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

function writeBindings(bindings: AccountProjectBinding[]): boolean {
  const file = bindingsFile();
  try {
    /* The state directory is the operator's; keep it 0700 when this write is
       the one that creates it. The record itself lands 0600 through the shared
       durable write. */
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonDurably(file, { schemaVersion: 1, bindings } satisfies BindingFile);
    return true;
  } catch {
    return false;
  }
}

export type BindingMutationFailure =
  | "INVALID_ENGINE"
  | "INVALID_ACCOUNT"
  | "INVALID_PROJECT"
  /** The record on disk is damaged, so this mutation refused to read it, and
      refused to write over it. Its own failure because the repair is the
      operator's and nothing else will do: no launch, reseat or switch selects
      an account for any project until the record is valid or gone. */
  | "RECORD_UNREADABLE"
  /** Another account mutation holds the cross-process lock. Retryable, and
      distinct from every other failure here because nothing was refused on the
      merits and nothing was written. */
  | "BUSY"
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

function unreadableRefusal(error: AccountProjectBindingsUnreadableError): BindingMutationResult {
  /* An empty list here is not a record: the code is what the caller reads, and
     it says the record could not be read at all. */
  return { ok: false, code: "RECORD_UNREADABLE", message: error.message, bindings: [] };
}

/**
 * Read, mutate, write and confirm as one transaction under the cross-process
 * account mutation lock — the same lock every other account write in this
 * codebase takes.
 *
 * Unlocked, two processes read the same record, each appends its own row, and
 * the later atomic rename erases the earlier one while BOTH report success. A
 * project whose sole binding is the row that vanished is then open to every
 * account, which is the same inversion a damaged record would cause, arrived at
 * by a race. Sixteen concurrent adds reproduced it: fifteen successes, thirteen
 * rows.
 *
 * The lock is re-entrant per transaction, so a caller that already holds it —
 * the API route awaits the async form so an operator's click queues instead of
 * failing fast — runs this inline rather than acquiring a second time.
 */
function inRecordTransaction(operation: () => BindingMutationResult): BindingMutationResult {
  try {
    return withAccountMutationLock(operation);
  } catch (error) {
    if (error instanceof AccountProjectBindingsUnreadableError) return unreadableRefusal(error);
    if (error instanceof AccountMutationBusyError) {
      return { ok: false, code: "BUSY", message: "another account mutation holds the record; retry shortly", bindings: [] };
    }
    throw error;
  }
}

/** A refusal that still carries the record, unless the record is why it failed. */
function refusalWithRecord(input: { ok: false; code: BindingMutationFailure; message: string }): BindingMutationResult {
  try {
    return { ...input, bindings: accountProjectBindings() };
  } catch (error) {
    if (error instanceof AccountProjectBindingsUnreadableError) return unreadableRefusal(error);
    throw error;
  }
}

/**
 * The one key a binding is stored and read under.
 *
 * `projectForCwd` answers with the scanner's project, which may be an ALIAS
 * SOURCE for a project whose repository identities have since converged. Store
 * and read under the alias target and the two spellings are one project; skip
 * this and a fence written from the accounts panel would silently not apply to
 * a pipeline whose cwd resolved to the pre-convergence id.
 */
function bindingKey(project: string): string {
  return canonicalProject(project.trim());
}

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
  return { ok: true, engine, accountId: account, project: bindingKey(key) };
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
  /* Validated before the lock: a malformed request is refused on its own
     terms and never queues behind another process's account mutation. */
  if (!input.ok) return refusalWithRecord(input);
  return inRecordTransaction(() => {
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
  });
}

/** Removes one binding. Idempotent, and confirmed by the same re-read. */
export function unbindAccountFromProject(
  engine: unknown,
  accountId: unknown,
  project: unknown,
): BindingMutationResult {
  const input = normalized(engine, accountId, project);
  if (!input.ok) return refusalWithRecord(input);
  return inRecordTransaction(() => {
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
  });
}

/**
 * The accounts `project` may use for `engine`, or `null` when the project has
 * no binding for that engine — which means every account, exactly as before.
 * `null` and `[]` are deliberately different answers: an empty array is a
 * project whose entire allowed set is unusable, and nothing may run there.
 *
 * Reads the record when the caller passes no `bindings`, so a damaged record
 * throws here rather than answering `null`: "the record could not be read" must
 * never arrive at a caller wearing the answer that means "every account".
 */
export function allowedAccountIdsForProject(
  project: string | null | undefined,
  engine: BindingEngine,
  bindings: readonly AccountProjectBinding[] = readBindings(),
): string[] | null {
  const key = typeof project === "string" && project.trim() ? bindingKey(project) : "";
  if (!key) return null;
  const allowed = bindings
    .filter((binding) => binding.engine === engine && binding.project === key)
    .map((binding) => binding.accountId);
  return allowed.length ? [...new Set(allowed)].sort() : null;
}

/**
 * How a DELIBERATE named-account choice stands against a project's pool.
 *
 * The distinction this whole record rests on: the binding constrains what the
 * Viewer picks BY ITSELF — the one-click reseat, and any account it would
 * default to — and those selectors read `allowedAccountIdsForProject`, where an
 * unreadable record throws and the selection parks. A person or an agent naming
 * an account is exercising a control, and a control is a capability. This
 * function therefore never refuses and never throws: it CLASSIFIES, so the
 * caller can carry the choice out and attribute it.
 *
 * `within-pool` covers the two cases that must stay byte-identical to what they
 * always were: the account is allowed, or the project is unbound and every
 * account always was.
 */
export type ExplicitAccountChoice =
  | { kind: "within-pool" }
  | { kind: "outside-pool"; allowedAccountIds: string[] }
  | { kind: "binding-unreadable"; reason: string };

export function explicitAccountChoice(
  project: string | null | undefined,
  engine: BindingEngine,
  accountId: string,
): ExplicitAccountChoice {
  let allowed: string[] | null;
  try {
    allowed = allowedAccountIdsForProject(project, engine);
  } catch (error) {
    if (!(error instanceof AccountProjectBindingsUnreadableError)) throw error;
    /* The record is damaged, so no pool can be shown. The machine's own
       selection refuses on this; a named choice is carried out and recorded,
       because a damaged file is not a decision anybody made. */
    return { kind: "binding-unreadable", reason: error.message };
  }
  if (allowed === null || allowed.includes(accountId)) return { kind: "within-pool" };
  return { kind: "outside-pool", allowedAccountIds: allowed };
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
