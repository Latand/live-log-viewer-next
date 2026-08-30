import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * #1279 on the two migration paths that select an account without being told
 * which — the engine-wide automatic drain, and the lazy reseat onto whatever
 * the engine's routing currently points at.
 *
 * Both used to be project-blind in the same way: one global target, then every
 * unpinned conversation queued behind it, with nothing between the decision and
 * the conversation that could say "not this project's work". So a target that
 * one project's pool allowed carried a DIFFERENT project's conversations onto
 * an account their own pool forbids, and a binding record nobody could read
 * stopped none of it.
 *
 * The tests below are the three shapes that broke: disjoint pools, a pool whose
 * allowed target has no capacity left, and a damaged record. Each is paired
 * with the case that must NOT change — a project whose pool allows the target,
 * and a migration that NAMES its target, which is a control and is carried out.
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-migration-binding-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const PREVIOUS_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = STATE;

const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { AccountProjectBindingsUnreadableError } = await import("@/lib/accounts/projectBindings");
const { AgentRegistry } = await import("./registry");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");

type Registry = InstanceType<typeof AgentRegistry>;

const ATLAS = "project-atlas";
const ORION = "project-orion";
/** The account both projects are being migrated TOWARDS. */
const TARGET = "carrier-north";
const ORIGIN_ACCOUNT = "carrier-origin";
const NOW = Date.now();

let sequence = 0;

function observation(project: string, accountId: string) {
  sequence += 1;
  return {
    engine: "codex" as const,
    path: `/sessions/${project}-${sequence}.jsonl`,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: `/checkouts/${project}`, project, title: "Worker" }),
    turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
    observedAt: "2026-08-30T09:00:00.000Z",
  };
}

/** A registry holding one idle conversation per named project, all on the
    account the migration is moving away from. */
function registryWith(projects: readonly string[]): { store: Registry; ids: Map<string, string> } {
  sequence = 0;
  const store = new AgentRegistry(
    path.join(SANDBOX, `registry-${crypto.randomUUID()}.json`),
    undefined,
    undefined,
    { sqliteMode: "off" },
  );
  const observations = projects.map((project) => observation(project, ORIGIN_ACCOUNT));
  store.reconcileConversations(observations);
  const ids = new Map(observations.map((item, index) =>
    [projects[index]!, store.conversationForPath(item.path)!.id] as const));
  return { store, ids };
}

/** A live, fresh sample: `usedPercent` 100 is a confirmed exhaustion. */
function quota(store: Registry, accountId: string, usedPercent: number): void {
  store.recordQuotaEvaluation({
    engine: "codex",
    observations: [{
      engine: "codex",
      accountId,
      authenticated: true,
      authCheckedAt: new Date(NOW - 1_000).toISOString(),
      limits: {
        session: { usedPercent, resetsAt: Math.floor(NOW / 1_000) + 3_600 },
        weekly: null,
        plan: "max",
        capturedAt: Math.floor((NOW - 1_000) / 1_000),
      },
      provenance: { source: "live", reason: null, staleSince: null },
      observedAt: new Date(NOW - 1_000).toISOString(),
      bootId: "boot-registry-migration-binding",
    }],
    signature: null,
    bootId: "boot-registry-migration-binding",
    now: new Date(NOW).toISOString(),
    minimumGapMs: 60_000,
  });
}

function bind(rows: readonly { project: string; accountId: string }[]): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: rows.map((row) => ({
      engine: "codex",
      accountId: row.accountId,
      project: row.project,
      createdAt: "2026-08-30T00:00:00.000Z",
    })),
  }), "utf8");
}

function damageRecord(): void {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");
}

/** The target each conversation is queued to move to, or null for parked. */
function queuedTargets(store: Registry, ids: Map<string, string>): Record<string, string | null> {
  const state: Record<string, string | null> = {};
  for (const [project, id] of ids) {
    state[project] = store.conversation(id as never)?.migration?.targetId ?? null;
  }
  return state;
}

function drain(store: Registry, origin: "auto" | "manual") {
  return store.commitMigrationIntent({
    engine: "codex",
    targetId: TARGET,
    origin,
    requestId: `drain-${origin}-${crypto.randomUUID()}`,
    expectedRevision: store.engineRouting("codex").revision,
  });
}

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(RECORD, { force: true });
  resetProjectAliasesForTests();
});

afterAll(() => {
  if (PREVIOUS_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = PREVIOUS_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("an automatic engine drain moves only the projects whose own pool allows the target", () => {
  /* The failure this replaces: one global target, and every unpinned
     conversation queued behind it. Atlas allows the target; Orion allows a
     different account entirely, and its conversation was carried across that
     boundary by a decision taken for a project it has nothing to do with. */
  const { store, ids } = registryWith([ATLAS, ORION]);
  bind([
    { project: ATLAS, accountId: TARGET },
    { project: ORION, accountId: "carrier-south" },
  ]);

  drain(store, "auto");

  expect(queuedTargets(store, ids)).toEqual({ [ATLAS]: TARGET, [ORION]: null });
});

test("an automatic engine drain parks a project whose allowed target has no capacity left", () => {
  /* Being IN the pool is not the same as having room in it. The target is the
     only account Atlas allows, and it carries a fresh, confirmed, zero-capacity
     sample — so moving Atlas's work onto it is an automatic selection landing
     somewhere it cannot be served, and the binding alone would have waved it
     through. */
  const exhausted = registryWith([ATLAS]);
  quota(exhausted.store, TARGET, 100);
  bind([{ project: ATLAS, accountId: TARGET }]);

  drain(exhausted.store, "auto");
  expect(queuedTargets(exhausted.store, exhausted.ids)).toEqual({ [ATLAS]: null });

  /* The identical binding with room left in the same account moves, so the
     park above is the capacity reading and not the pool. */
  const spare = registryWith([ATLAS]);
  quota(spare.store, TARGET, 5);

  drain(spare.store, "auto");
  expect(queuedTargets(spare.store, spare.ids)).toEqual({ [ATLAS]: TARGET });
});

test("an automatic engine drain refuses a damaged record before the routing revision moves", () => {
  /* Answered as "unbound" a damaged record reads as "every account is allowed",
     which is every fence disappearing at once. The refusal has to land BEFORE
     the routing change, because the engine's default account is where every
     later automatic pick starts from. */
  const { store, ids } = registryWith([ATLAS]);
  const before = store.engineRouting("codex");
  damageRecord();

  expect(() => drain(store, "auto")).toThrow(AccountProjectBindingsUnreadableError);

  expect(store.engineRouting("codex")).toEqual(before);
  expect(queuedTargets(store, ids)).toEqual({ [ATLAS]: null });
  expect(Object.keys(store.readOnlySnapshot().migrationIntents)).toEqual([]);
});

test("a migration that names its target is carried out, outside the pool and past a damaged record", () => {
  /* The other half of the rule, and it must not regress: a manual migration
     NAMES an account. It is a control, it is carried out even where the pool
     would not have chosen it, and evidence this process cannot read is not a
     veto on a choice somebody made. */
  const disallowed = registryWith([ATLAS, ORION]);
  bind([{ project: ATLAS, accountId: "carrier-south" }, { project: ORION, accountId: "carrier-south" }]);
  drain(disallowed.store, "manual");
  expect(queuedTargets(disallowed.store, disallowed.ids)).toEqual({ [ATLAS]: TARGET, [ORION]: TARGET });

  const damaged = registryWith([ATLAS]);
  damageRecord();
  drain(damaged.store, "manual");
  expect(queuedTargets(damaged.store, damaged.ids)).toEqual({ [ATLAS]: TARGET });
});

test("the lazy active-account migration draws the same boundary as the engine drain", () => {
  /* The same decision on the delivery path: a send arrives, the engine's
     routing has moved, and the Viewer decides by itself that this conversation
     should follow. Nobody named the conversation and nobody named its project,
     so the pool and the capacity both apply — and a project the target is
     forbidden on simply stays where it is, still running, still sendable. */
  const { store, ids } = registryWith([ATLAS, ORION]);
  store.setEngineRouting("codex", TARGET);
  bind([{ project: ORION, accountId: "carrier-south" }]);

  store.requestConversationMigrationToActiveAccount(ids.get(ATLAS)! as never);
  store.requestConversationMigrationToActiveAccount(ids.get(ORION)! as never);

  expect(queuedTargets(store, ids)).toEqual({ [ATLAS]: TARGET, [ORION]: null });
});

test("the lazy active-account migration parks an allowed target that is out of capacity", () => {
  const { store, ids } = registryWith([ATLAS]);
  store.setEngineRouting("codex", TARGET);
  quota(store, TARGET, 100);
  bind([{ project: ATLAS, accountId: TARGET }]);

  store.requestConversationMigrationToActiveAccount(ids.get(ATLAS)! as never);

  expect(queuedTargets(store, ids)).toEqual({ [ATLAS]: null });
});

test("the lazy active-account migration refuses a damaged record instead of reading it as unbound", () => {
  const { store, ids } = registryWith([ATLAS]);
  store.setEngineRouting("codex", TARGET);
  damageRecord();

  expect(() => store.requestConversationMigrationToActiveAccount(ids.get(ATLAS)! as never))
    .toThrow(AccountProjectBindingsUnreadableError);
  expect(queuedTargets(store, ids)).toEqual({ [ATLAS]: null });
});

test("a project with no binding migrates exactly as it always did, on both paths", () => {
  /* The record is absent, which is the state every project is in until someone
     configures one, and both paths must be byte for byte what they were. */
  const drained = registryWith([ATLAS, ORION]);
  drain(drained.store, "auto");
  expect(queuedTargets(drained.store, drained.ids)).toEqual({ [ATLAS]: TARGET, [ORION]: TARGET });

  const lazy = registryWith([ATLAS]);
  lazy.store.setEngineRouting("codex", TARGET);
  lazy.store.requestConversationMigrationToActiveAccount(lazy.ids.get(ATLAS)! as never);
  expect(queuedTargets(lazy.store, lazy.ids)).toEqual({ [ATLAS]: TARGET });
});
