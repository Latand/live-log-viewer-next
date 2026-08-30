import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #1279 at the seam every AUTOMATIC selection goes through.
 *
 * `projectSelection.test.ts` covers the rule as a pure function, with the
 * bindings handed to it. That is exactly what it cannot prove: every automatic
 * caller reaches the rule through the account manager, which READS the record
 * itself — so the two properties that matter most on this side live here and
 * only here. The pool is what the pick is drawn from, and a record this process
 * cannot read stops the pick instead of answering "nobody bound anything".
 *
 * Account and project names are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-manager-project-binding-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const PREVIOUS = {
  state: process.env.LLV_STATE_DIR,
  codexHome: process.env.LLV_CODEX_HOME,
  claudeHome: process.env.LLV_CLAUDE_HOME,
};
process.env.LLV_STATE_DIR = STATE;
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");

const { createManagedCodexAccount, listCodexAccounts } = await import("./codex");
const { createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
const { accountManager, resolveContinuityAccount, resolveHealthySpawnAccount } = await import("./manager");
const { AccountProjectBindingsUnreadableError } = await import("./projectBindings");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");

const ATLAS = "project-atlas";
const NOW = Date.now();

let reserved = "";
let spare = "";
let claudeReserved = "";
let claudeSpare = "";

function seedAccounts(): void {
  const created = new Map<string, string>();
  for (const label of ["Reserved carrier", "Spare carrier"]) {
    const account = createManagedCodexAccount(label);
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
    created.set(label, account.id);
  }
  reserved = created.get("Reserved carrier")!;
  spare = created.get("Spare carrier")!;
  /* Credentials with no OAuth expiry in them: the account is present enough to
     be a candidate, and the Claude health pass then reads its metadata, finds
     nothing current or refreshable, and refuses by NAMING every account it
     considered — which is how the tests below read the candidate set without a
     network probe or a fake dependency between them and the rule. */
  for (const label of ["Reserved reviewer", "Spare reviewer"]) {
    const account = createManagedClaudeAccount(label);
    fs.writeFileSync(path.join(account.home, ".credentials.json"), "{}", { mode: 0o600 });
    created.set(label, account.id);
  }
  claudeReserved = created.get("Reserved reviewer")!;
  claudeSpare = created.get("Spare reviewer")!;
}

/** A live sample with `usedPercent` burned, fresh enough to be believed. */
function observation(accountId: string, usedPercent: number) {
  return {
    engine: "codex" as const,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(NOW - 1_000).toISOString(),
    limits: {
      session: { usedPercent, resetsAt: Math.floor(NOW / 1_000) + 3_600 },
      weekly: null,
      plan: "max",
      capturedAt: Math.floor((NOW - 1_000) / 1_000),
    },
    provenance: { source: "live" as const, reason: null, staleSince: null },
    observedAt: new Date(NOW - 1_000).toISOString(),
    bootId: "boot-manager-project-binding",
  };
}

function registryWith(
  routedTo: string,
  observations: ReturnType<typeof observation>[],
  claudeRoutedTo?: string,
): void {
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  registry.setEngineRouting("codex", routedTo);
  if (claudeRoutedTo) registry.setEngineRouting("claude", claudeRoutedTo);
  if (observations.length) {
    registry.recordQuotaEvaluation({
      engine: "codex",
      observations,
      signature: null,
      bootId: "boot-manager-project-binding",
      now: new Date(NOW).toISOString(),
      minimumGapMs: 60_000,
    });
  }
  setAgentRegistryForTests(registry);
}

function bind(accountId: string, project = ATLAS, engine: "codex" | "claude" = "codex"): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine, accountId, project, createdAt: new Date(NOW - 60_000).toISOString() }],
  }), "utf8");
}

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  setAgentRegistryForTests(null);
  resetProjectAliasesForTests();
  seedAccounts();
});

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [key, value] of [
    ["LLV_STATE_DIR", PREVIOUS.state],
    ["LLV_CODEX_HOME", PREVIOUS.codexHome],
    ["LLV_CLAUDE_HOME", PREVIOUS.claudeHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("an automatic pick on a bound project is drawn from the pool, not the engine's routing", () => {
  /* The engine is routed at the spare account and the project is bound to the
     reserved one. Nothing names an account, so this is the Viewer choosing —
     and what it may choose from is the pool, not what it happens to be
     pointing at. */
  registryWith(spare, []);
  bind(reserved);

  const project = accountManager.resolveProjectSpawn("codex", { project: ATLAS });
  expect(project.kind).toBe("available");
  expect(project.kind === "available" && project.account.accountId).toBe(reserved);

  const headless = accountManager.resolveHeadlessSpawn("codex", null, [], ATLAS);
  expect(headless.kind).toBe("available");
  expect(headless.kind === "available" && headless.account.accountId).toBe(reserved);
});

test("every allowed account out of capacity is reported, never widened to the idle one next door", () => {
  /* The reserved account has a fresh zero-capacity sample and the spare has
     plenty. Widening here is the whole failure the pool exists to prevent, so
     both automatic seams report a shortage and let the work wait. */
  registryWith(spare, [observation(reserved, 100), observation(spare, 5)]);
  bind(reserved);

  const project = accountManager.resolveProjectSpawn("codex", { project: ATLAS });
  expect(project.kind).toBe("exhausted");
  expect(project.kind === "exhausted" && project.allowedAccountIds).toEqual([reserved]);

  expect(accountManager.resolveHeadlessSpawn("codex", null, [], ATLAS).kind).toBe("exhausted");
});

test("a preference for an account outside the pool orders nothing and widens nothing", () => {
  /* `resolveHeadlessSpawn` passes its requested id as a PREFERENCE. A
     preference the project forbids must not become a selection. */
  registryWith(spare, [observation(reserved, 5), observation(spare, 1)]);
  bind(reserved);

  const headless = accountManager.resolveHeadlessSpawn("codex", spare, [], ATLAS);
  expect(headless.kind === "available" && headless.account.accountId).toBe(reserved);
});

test("a binding record that cannot be read refuses both automatic seams", () => {
  /* Damaged, not absent. Answered as "unbound" this reads as "every account is
     allowed", which is the fence disappearing in the one condition where it
     matters most — so the pick is refused and the operator is named the record
     to repair. */
  registryWith(spare, []);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");

  expect(() => accountManager.resolveProjectSpawn("codex", { project: ATLAS }))
    .toThrow(AccountProjectBindingsUnreadableError);
  expect(() => accountManager.resolveHeadlessSpawn("codex", null, [], ATLAS))
    .toThrow(AccountProjectBindingsUnreadableError);
});

test("a project with no binding keeps the answer it always had", () => {
  /* No record at all: the pipeline seam takes the engine's routing with no
     capacity arithmetic, and the capacity-aware seam selects across every
     account. Both are byte for byte the pre-#1279 behaviour. */
  registryWith(spare, [observation(spare, 5)]);

  const project = accountManager.resolveProjectSpawn("codex", { project: ATLAS });
  expect(project.kind === "available" && project.account.accountId).toBe(spare);
  expect(listCodexAccounts().some((account) => account.id === reserved)).toBe(true);

  const headless = accountManager.resolveHeadlessSpawn("codex", null, [], ATLAS);
  expect(headless.kind === "available" && headless.account.accountId).toBe(spare);
});

/**
 * The third automatic seam, and the one no test reached: `/api/spawn` does not
 * resolve through `resolveProjectSpawn`. A raw launch that names no account
 * goes to `resolveHealthySpawnAccount`, and every spawn surface the Viewer has
 * rides on it — the board's own button, the orchestrator seat and the scheduled
 * report launcher among them. Each test below states what the seam answers on
 * an UNBOUND project as well, so the pool is visibly what decided, rather than
 * the routing agreeing by accident.
 */
test("the direct launch seam draws its automatic pick from the pool, not the engine's routing (#1279)", async () => {
  registryWith(spare, []);

  /* Routed at the spare account and the project bound to the reserved one. */
  bind(reserved);
  expect((await resolveHealthySpawnAccount("codex", undefined, ATLAS)).accountId).toBe(reserved);
  /* Unbound, the same call answers with the routing, exactly as it always did
     — so the line above is the pool overriding it, not a coincidence. */
  fs.rmSync(RECORD, { force: true });
  expect((await resolveHealthySpawnAccount("codex", undefined, ATLAS)).accountId).toBe(spare);
});

test("the direct launch seam refuses an allowed account that is out of capacity, rather than launching on it (#1279)", async () => {
  /* Being IN the pool is not the same as having room in it. The reserved
     account is the project's only allowed account and carries a fresh,
     confirmed, zero-capacity sample; the spare is idle and outside the pool.
     The seam used to take the first allowed id and resolve it on the spot,
     consulting the pool and never the quota — so this launch went onto an
     account that could not serve it, and the idle account next door was never
     the answer either. */
  registryWith(spare, [observation(reserved, 100), observation(spare, 5)]);
  bind(reserved);

  const refused = await resolveHealthySpawnAccount("codex", undefined, ATLAS)
    .then(() => null, (error: unknown) => error);
  expect((refused as Error).name).toBe("ProjectAccountRefusedError");
  expect((refused as Error).message).toContain("no allowed codex account has capacity");
  expect((refused as Error).message).toContain(reserved);
  /* And the idle account outside the pool is not offered as a way around it. */
  expect((refused as Error).message).not.toContain(spare);

  /* The same shortage on an UNBOUND project changes nothing: no boundary was
     drawn, so the routing account is resolved exactly as it always was. */
  fs.rmSync(RECORD, { force: true });
  expect((await resolveHealthySpawnAccount("codex", undefined, ATLAS)).accountId).toBe(spare);
});

test("the direct launch's health pass considers the pool's accounts and no others (#1279)", async () => {
  registryWith(spare, [], claudeSpare);
  /* None of these homes carries an OAuth credential, so the pass admits none
     and refuses. Bound, that refusal is reported against the pool it drew
     from, with the pass's own reason kept after it so the operator learns
     which account to repair. */
  bind(claudeReserved, ATLAS, "claude");
  const fenced = await resolveHealthySpawnAccount("claude", undefined, ATLAS)
    .then(() => null, (error: unknown) => error);
  expect((fenced as Error).name).toBe("ProjectAccountRefusedError");
  expect((fenced as Error).message).toContain(`allowed claude accounts: ${claudeReserved}`);
  expect((fenced as Error).message).toContain("Re-login");
  /* The candidate set the pass actually looked at, read out of its own
     message rather than asserted about the seam's inputs. */
  expect((fenced as Error).message).not.toContain(claudeSpare);

  fs.rmSync(RECORD, { force: true });
  const unbound = await resolveHealthySpawnAccount("claude", undefined, ATLAS)
    .then(() => null, (error: unknown) => error);
  /* Unbound, every Claude account in the catalogue is a candidate, and the
     failure is the seam's own — unwrapped and unqualified by any pool, which
     is both the historical behaviour and the width the pool removed above. */
  expect((unbound as { accountIds?: string[] }).accountIds)
    .toEqual(listClaudeAccounts().map((account) => account.id).sort());
  expect((unbound as { accountIds?: string[] }).accountIds).toContain(claudeSpare);
});

test("a named account outside the pool is refused at the direct launch seam, and capacity never speaks for it (#1279)", async () => {
  /* A launch that NAMES an account is checked against the pool alone: the
     reserved account is allowed and exhausted, and naming it still resolves,
     because nobody may quietly substitute an account somebody asked for. */
  registryWith(spare, [observation(reserved, 100), observation(spare, 5)]);
  bind(reserved);

  expect((await resolveHealthySpawnAccount("codex", reserved, ATLAS)).accountId).toBe(reserved);

  const refused = await resolveHealthySpawnAccount("codex", spare, ATLAS)
    .then(() => null, (error: unknown) => error);
  expect((refused as Error).name).toBe("ProjectAccountRefusedError");
  expect((refused as Error).message).toContain(`account ${spare} is not allowed on project ${ATLAS}`);
});

test("a damaged binding record refuses the direct launch seam before it resolves anything (#1279)", () => {
  registryWith(spare, []);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");

  expect(resolveHealthySpawnAccount("codex", undefined, ATLAS))
    .rejects.toThrow(AccountProjectBindingsUnreadableError);
});

/**
 * The last seam that could still choose an account without being asked: the
 * RESUME of an existing conversation. It resolved through `resolveSpawn`,
 * whose second argument is nullable — and a null there silently answered with
 * the engine's routing account, reading neither the pool nor any quota. The
 * two halves are separated below because they are different questions.
 */
test("a resume of work that records an account continues on it, pool or no pool (#1279)", () => {
  /* The conversation's session lives in that account's home. Nobody is
     choosing here, so neither the pool nor a spent quota may re-seat it —
     resuming anywhere else would resume nothing. */
  registryWith(spare, [observation(spare, 100)]);
  bind(reserved);

  expect(resolveContinuityAccount("codex", spare, ATLAS).accountId).toBe(spare);
});

test("a resume of work that records no account draws from the pool, not the engine's routing (#1279)", () => {
  /* Routed at the spare account, bound to the reserved one, and the
     conversation names neither — an adopted thread whose account was never
     recorded. That makes this resume a PICK, and a pick draws from the pool.
     Both accounts carry room, so the pool is the only thing left deciding. */
  registryWith(spare, [observation(reserved, 5), observation(spare, 5)]);
  bind(reserved);
  expect(resolveContinuityAccount("codex", null, ATLAS).accountId).toBe(reserved);

  /* Unbound, the same call answers with the routing account exactly as it
     always did, so the line above is the pool deciding rather than agreeing. */
  fs.rmSync(RECORD, { force: true });
  expect(resolveContinuityAccount("codex", null, ATLAS).accountId).toBe(spare);
});

test("a resume that has to pick reports an exhausted pool instead of the idle account beside it (#1279)", () => {
  registryWith(spare, [observation(reserved, 100), observation(spare, 5)]);
  bind(reserved);

  const refused = (() => { try { resolveContinuityAccount("codex", null, ATLAS); return null; } catch (error) { return error; } })();
  expect((refused as Error).name).toBe("ProjectAccountRefusedError");
  expect((refused as Error).message).toContain("no allowed codex account has capacity");
  expect((refused as Error).message).not.toContain(spare);
});

test("a damaged binding record refuses a resume that has to pick, and only that one (#1279)", () => {
  registryWith(spare, []);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");

  expect(() => resolveContinuityAccount("codex", null, ATLAS)).toThrow(AccountProjectBindingsUnreadableError);
  /* A record nobody can read never vetoes continuity: the conversation is
     already running there and no routing decision is being taken. */
  expect(resolveContinuityAccount("codex", spare, ATLAS).accountId).toBe(spare);
});
