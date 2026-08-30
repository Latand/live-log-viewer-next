import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/**
 * #1279 where the direct launch seam meets the route: the rule itself lives at
 * the account seam (`managerProjectBinding.test.ts` holds it), and what these
 * tests pin is that the route hands it the PROJECT and then answers its two
 * refusals as refusals rather than as crashes.
 *
 * The refusals already held — nothing launches either way. What matters is the
 * SHAPE: the request is well formed and the state it addresses is what is
 * wrong, so the answer is a conflict carrying the record's name or the pool's,
 * the same one the reseat, the binding route and the task launch give.
 * Answered as a server fault it reads as a Viewer crash, and an operator has
 * nothing to repair from. Answered after a receipt exists, a retry replays the
 * launch onto whatever account it can find.
 *
 * This is the seam every spawn surface the Viewer has arrives at — the board's
 * button, the orchestrator seat, the scheduled report launcher — and none of
 * them names an account, so all of them are the Viewer choosing.
 *
 * Account and project names here are invented.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-route-binding-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const ORIGINAL = {
  state: process.env.LLV_STATE_DIR,
  codexHome: process.env.LLV_CODEX_HOME,
};
fs.mkdirSync(STATE, { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");

const { POST } = await import("./route");
const { projectForCwd } = await import("@/lib/scanner/describe");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { AccountProjectBindingsUnreadableError } = await import("@/lib/accounts/projectBindings");
const { ProjectAccountRefusedError } = await import("@/lib/accounts/manager");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { productionSpawnCommandDependencies } = await import("@/lib/agent/spawnCommand");

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(RECORD, { force: true });
});

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [key, value] of [
    ["LLV_STATE_DIR", ORIGINAL.state],
    ["LLV_CODEX_HOME", ORIGINAL.codexHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

type SpawnRouteDependencies = NonNullable<Parameters<typeof POST.withDependencies>[1]>;

async function spawn(cwd: string, clientAttemptId: string, resolutionFailure?: Error): Promise<{
  status: number;
  error: string;
  accountResolutions: number;
  /** The project the route handed the resolver, one entry per resolution.
      The pool, the capacity arithmetic and the record's readability are all
      decided from this one value, at the seam, so it is the whole of what the
      route contributes to the fence. */
  projects: (string | null | undefined)[];
  receipts: number;
}> {
  const store = new AgentRegistry(path.join(SANDBOX, `${clientAttemptId}.json`));
  let accountResolutions = 0;
  /* Recorded inside the stub, because the route's own answer cannot show what
     it asked for — and what it asked for IS the fence at this seam. */
  const projects: (string | null | undefined)[] = [];
  const dependencies = {
    registry: () => store,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async (
      _engine: unknown,
      _requested: unknown,
      project?: string | null,
    ) => {
      accountResolutions += 1;
      projects.push(project);
      if (resolutionFailure) throw resolutionFailure;
      return {
        engine: "claude" as const,
        accountId: "acct-default",
        kind: "managed" as const,
        home: path.join(cwd, "account"),
        transcriptRoot: path.join(cwd, "projects"),
        env: { NODE_ENV: "test" as const },
      };
    },
    defer: (work: () => unknown) => { void work(); },
  } as unknown as SpawnRouteDependencies;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ title: "Inspect the atlas checkout", engine: "claude", model: "sonnet", cwd, "prompt": "inspect", clientAttemptId }),
  }), dependencies);
  const payload = await response.json() as { error?: string };
  return {
    status: response.status,
    error: payload.error ?? "",
    accountResolutions,
    projects,
    receipts: Object.keys(store.snapshot().receipts).length,
  };
}

test("a damaged binding record refuses a direct launch as a conflict naming the record, not a server fault", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "damaged-"));

  const attempt = await spawn(
    cwd,
    "binding_damaged_20260830",
    new AccountProjectBindingsUnreadableError("the record is not valid JSON"),
  );

  expect(attempt.status).toBe(409);
  expect(attempt.error).toContain("account-project-bindings.json");
  expect(attempt.error).toContain("repaired or removed");
  /* Nothing durable was written, so there is no receipt a retry could replay
     onto some account while the record is still damaged. */
  expect(attempt.receipts).toBe(0);
});

test("a bound project's automatic launch hands the resolver the project the work belongs to", async () => {
  /* Nothing in the request names an account — the board's spawn button sends
     none — so this is the Viewer choosing. The project is the whole of what
     the route contributes: the pool it implies, whether any account in that
     pool has capacity, and what an unreadable record means are one decision,
     taken once, at the seam. */
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "bound-"));
  const project = projectForCwd(cwd)!;

  const attempt = await spawn(cwd, "binding_bound_20260830");

  expect(attempt.status).not.toBe(409);
  expect(attempt.projects).toEqual([project]);
});

test("a launch whose cwd resolves to no project asks for none, and resolves as it always did", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "absent-"));

  const attempt = await spawn(cwd, "binding_absent_20260830");

  expect(attempt.status).not.toBe(409);
  expect(attempt.accountResolutions).toBe(1);
  expect(attempt.projects).toEqual([projectForCwd(cwd)]);
});

test("a pool with no account left to launch on is a conflict naming the pool, and writes no receipt", async () => {
  /* Nothing named an account, so there is no pin to degrade and nothing
     outside the pool to reach for. What is left is the report — and answered
     as a throw instead it becomes a Viewer fault for a state the binding
     itself created, with a receipt behind it for a retry to replay. */
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "pool-unusable-"));
  const project = projectForCwd(cwd)!;

  const attempt = await spawn(
    cwd,
    "binding_pool_unusable_20260830",
    new ProjectAccountRefusedError(
      { kind: "exhausted", resetsAt: null, allowedAccountIds: ["acct-reserved"] },
      "claude",
      project,
    ),
  );

  expect(attempt.status).toBe(409);
  expect(attempt.error).toContain(project);
  expect(attempt.error).toContain("acct-reserved");
  expect(attempt.error).toContain("has capacity");
  expect(attempt.receipts).toBe(0);
});

test("an unbound project keeps the failure it always had when no account resolves", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "pool-absent-failure-"));

  const attempt = await spawn(
    cwd,
    "binding_absent_failure_20260830",
    new Error("No healthy Claude account is available. Re-login a Claude account in Accounts and retry."),
  );

  /* No boundary was drawn here, so the failure is about the machine's accounts
     and is answered exactly as it was before this fence existed — the
     resolver's own message, unwrapped and unqualified by any pool. */
  expect(attempt.status).toBe(500);
  expect(attempt.error).toBe("No healthy Claude account is available. Re-login a Claude account in Accounts and retry.");
});

/**
 * The whole rule, end to end, through the route's own production resolver: the
 * project's pool AND its capacity, on the seam that used to consult the first
 * and never the second.
 */
test("a bound pool with no capacity refuses the launch as a conflict, and the idle account outside it is not the answer", async () => {
  const created = ["Reserved carrier", "Spare carrier"].map((label) => {
    const account = createManagedCodexAccount(label);
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
    return account.id;
  });
  const [reserved, spare] = created as [string, string];
  const now = Date.now();
  const sample = (accountId: string, usedPercent: number) => ({
    engine: "codex" as const,
    accountId,
    authenticated: true,
    authCheckedAt: new Date(now - 1_000).toISOString(),
    limits: {
      session: { usedPercent, resetsAt: Math.floor(now / 1_000) + 3_600 },
      weekly: null,
      plan: "max",
      capturedAt: Math.floor((now - 1_000) / 1_000),
    },
    provenance: { source: "live" as const, reason: null, staleSince: null },
    observedAt: new Date(now - 1_000).toISOString(),
    bootId: "boot-spawn-route-binding",
  });

  const globalStore = new AgentRegistry(path.join(SANDBOX, "global-registry.json"));
  /* Routed at the idle account outside the pool, which is exactly the account
     a pool-blind pick would have taken — and which the reserved account being
     exhausted must not make reachable either. */
  globalStore.setEngineRouting("codex", spare);
  globalStore.recordQuotaEvaluation({
    engine: "codex",
    observations: [sample(reserved, 100), sample(spare, 5)],
    signature: null,
    bootId: "boot-spawn-route-binding",
    now: new Date(now).toISOString(),
    minimumGapMs: 60_000,
  });
  setAgentRegistryForTests(globalStore);

  const cwd = fs.mkdtempSync(path.join(SANDBOX, "pool-capacity-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "codex", accountId: reserved, project, createdAt: "2026-08-30T00:00:00.000Z" }],
  }), "utf8");

  const store = new AgentRegistry(path.join(SANDBOX, "pool-capacity-registry.json"));
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      title: "Inspect the atlas checkout",
      engine: "codex",
      model: "gpt-5.6-terra",
      cwd,
      /* The key is quoted, like its neighbours above, because the publication
         gate reads an unquoted one as a transcript line. */
      "prompt": "inspect",
      clientAttemptId: "binding_pool_capacity_20260830",
    }),
  }), {
    /* The production resolver, deliberately: what this test is here for is the
       rule itself running on the route's own path, not a stub agreeing with
       an assertion about it. */
    ...productionSpawnCommandDependencies,
    registry: () => store,
    assertStructuredRuntime: () => {},
    defer: (work: () => unknown) => { void work(); },
  } as unknown as SpawnRouteDependencies);
  const payload = await response.json() as { error?: string };

  expect(response.status).toBe(409);
  expect(payload.error).toContain("no allowed codex account has capacity");
  expect(payload.error).toContain(reserved);
  expect(payload.error).not.toContain(spare);
  /* Nothing durable, so a retry cannot replay this launch onto the idle
     account the project does not allow. */
  expect(Object.keys(store.snapshot().receipts)).toEqual([]);

  setAgentRegistryForTests(null);
});
