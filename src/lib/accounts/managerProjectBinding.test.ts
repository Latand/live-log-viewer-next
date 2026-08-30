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
const { accountManager } = await import("./manager");
const { AccountProjectBindingsUnreadableError } = await import("./projectBindings");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");

const ATLAS = "project-atlas";
const NOW = Date.now();

let reserved = "";
let spare = "";

function seedAccounts(): void {
  const created = new Map<string, string>();
  for (const label of ["Reserved carrier", "Spare carrier"]) {
    const account = createManagedCodexAccount(label);
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
    created.set(label, account.id);
  }
  reserved = created.get("Reserved carrier")!;
  spare = created.get("Spare carrier")!;
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

function registryWith(routedTo: string, observations: ReturnType<typeof observation>[]): void {
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  registry.setEngineRouting("codex", routedTo);
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

function bind(accountId: string, project = ATLAS): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "codex", accountId, project, createdAt: new Date(NOW - 60_000).toISOString() }],
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
