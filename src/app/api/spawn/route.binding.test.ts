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

async function spawn(
  cwd: string,
  clientAttemptId: string,
  resolutionFailure?: Error,
  /** The account the REQUEST names, when it names one — the board's launch
      draft, the orchestrator's rotate draft, `spawn_agent`. */
  requestedAccountId?: string,
  /** A registry shared across calls, so a second request with the same
      `clientAttemptId` is a REPLAY rather than a fresh launch. */
  sharedStore?: InstanceType<typeof AgentRegistry>,
  /** Report the named account as rate-limited until this instant, which is how
      the route reaches its QUEUED answer: a 202 carrying a real
      `SpawnResponse`, with no process started anywhere. It is the only success
      shape this suite can produce — every other one ends in the tmux launcher,
      which reads the process-global registry rather than the injected one. */
  admissionRetryAt?: string,
): Promise<{
  status: number;
  error: string;
  accountResolutions: number;
  /** The project the route handed the resolver, one entry per resolution.
      The pool, the capacity arithmetic and the record's readability are all
      decided from this one value, at the seam, so it is the whole of what the
      route contributes to the fence. */
  projects: (string | null | undefined)[];
  receipts: number;
  /** The out-of-pool notice on the route's OWN answer, when it carried one. */
  accountOverride: { recorded?: boolean; recordFailure?: string; accountId?: string; reason?: string } | null;
}> {
  const store = sharedStore ?? new AgentRegistry(path.join(SANDBOX, `${clientAttemptId}.json`));
  let accountResolutions = 0;
  /* Recorded inside the stub, because the route's own answer cannot show what
     it asked for — and what it asked for IS the fence at this seam. */
  const projects: (string | null | undefined)[] = [];
  const accountContext = (accountId: string) => ({
    engine: "claude" as const,
    accountId,
    kind: "managed" as const,
    home: path.join(cwd, "account"),
    transcriptRoot: path.join(cwd, "projects"),
    env: { NODE_ENV: "test" as const },
  });
  const dependencies = {
    registry: () => store,
    assertStructuredRuntime: () => {},
    /* The route re-resolves the settled account under the mutation lock before
       it reserves the receipt; without it the reservation never happens and
       nothing downstream of it — the attribution below included — can be
       observed at all. */
    resolveSpawnAccount: (_engine: unknown, accountId: string) => accountContext(accountId),
    /* The queued answer stores the launch's images before it parks the pin;
       this suite sends none. */
    storeImages: () => [],
    resolveHealthySpawnAccount: async (
      _engine: unknown,
      requested: unknown,
      project?: string | null,
    ) => {
      accountResolutions += 1;
      projects.push(project);
      if (resolutionFailure) throw resolutionFailure;
      /* The seam resolves an explicitly named account TO ITSELF, pool or no
         pool — that is the rule this stub stands in for, and it is what the
         route's attribution has to see to record the crossing. */
      const context = accountContext(typeof requested === "string" && requested ? requested : "acct-default");
      return admissionRetryAt
        ? { ...context, requestedAdmission: { kind: "retry-at", retryAt: admissionRetryAt } }
        : context;
    },
    defer: (work: () => unknown) => { void work(); },
  } as unknown as SpawnRouteDependencies;
  const response = await POST.withDependencies(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({
      title: "Inspect the atlas checkout",
      engine: "claude",
      model: "sonnet",
      cwd,
      "prompt": "inspect",
      clientAttemptId,
      ...(requestedAccountId ? { accountId: requestedAccountId } : {}),
    }),
  }), dependencies);
  const payload = await response.json() as {
    error?: string;
    accountOverride?: { recorded?: boolean; recordFailure?: string; accountId?: string; reason?: string };
  };
  return {
    status: response.status,
    error: payload.error ?? "",
    accountResolutions,
    projects,
    receipts: Object.keys(store.snapshot().receipts).length,
    accountOverride: payload.accountOverride ?? null,
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

/**
 * THE BINDING STOPPED BEING A VETO HERE, SO IT HAD TO BECOME A RECORD.
 *
 * A launch that NAMES an account is a control somebody worked, and the operator
 * directive of 2026-09-10 is that no project binding may refuse one. What that
 * costs is attribution: an account carrying work it is not bound to has to read
 * as a decision somebody made, not as a fence that quietly stopped holding, and
 * the project view renders this journal beside the pool.
 */
test("a launch onto an account outside the project's pool is recorded in the override journal", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "named-outside-pool-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-09-10T00:00:00.000Z" }],
  }), "utf8");

  const attempt = await spawn(cwd, "binding_named_outside_20260910", undefined, "acct-chosen-by-hand");

  /* Not refused: the whole point. */
  expect(attempt.status).not.toBe(409);
  const { accountProjectOverrides } = await import("@/lib/accounts/accountOverrides");
  expect(accountProjectOverrides({ project })).toEqual([expect.objectContaining({
    engine: "claude",
    project,
    accountId: "acct-chosen-by-hand",
    allowedAccountIds: ["acct-reserved"],
    reason: "outside-pool",
    actor: "operator",
    via: "launch",
  })]);
});

test("a launch onto an account the pool already contains records nothing", async () => {
  /* Inside the pool nothing was crossed, so the journal must stay empty — a
     record of every launch would bury the crossings it exists to show. */
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "named-inside-pool-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-09-10T00:00:00.000Z" }],
  }), "utf8");

  const attempt = await spawn(cwd, "binding_named_inside_20260910", undefined, "acct-reserved");

  expect(attempt.status).not.toBe(409);
  const { accountProjectOverrides } = await import("@/lib/accounts/accountOverrides");
  expect(accountProjectOverrides({ project })).toEqual([]);
});

test("a second request under the same attempt id appends no second crossing", async () => {
  /* An idempotent retry — a lost response resent under the same
     `clientAttemptId` — is the same launch arriving twice, not a second choice.
     The journal is capped at 200 and drops its oldest entries, so a duplicate
     evicts a crossing this record exists to keep.

     WHAT THIS FIXTURE REACHES, stated because it is less than the guard covers:
     the first launch here reserves its receipt (which is where the crossing is
     recorded) and then dies further in on a stub the harness does not carry, so
     the retry lands on the terminal-pinned-failure branch and answers 409. That
     branch returns before the recording either way. The `begun.kind ===
     "created"` gate in `executeSpawnRequest` is what covers the REPLAY branch,
     which needs a first launch that settles — nothing in this file can produce
     one. So this asserts the property, not the branch. */
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "named-replayed-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-09-10T00:00:00.000Z" }],
  }), "utf8");
  const store = new AgentRegistry(path.join(SANDBOX, "replayed-registry.json"));

  const first = await spawn(cwd, "binding_named_replay_20260910", undefined, "acct-chosen-by-hand", store);
  const second = await spawn(cwd, "binding_named_replay_20260910", undefined, "acct-chosen-by-hand", store);

  /* One receipt across both requests: the second was the same launch, not a
     new one, whichever branch answered it. */
  expect(first.receipts).toBe(1);
  expect(second.receipts).toBe(1);
  const { accountProjectOverrides } = await import("@/lib/accounts/accountOverrides");
  expect(accountProjectOverrides({ project })).toHaveLength(1);
});

/**
 * THE NOTICE RIDES THE ANSWER, which is `attributeNamedAccountChoice`'s own
 * contract and what both switch seams already do: a journal that would not take
 * the record answers `recorded: false` with the reason, and the caller's answer
 * carries it to whoever made the choice. It matters more at this seam than at
 * those — this record is the ONLY thing that makes an out-of-pool launch
 * visible now that the binding does not refuse one, so a state directory that
 * cannot be written to must not leave the crossing behind an ordinary spawn
 * response.
 */
test("an out-of-pool launch carries its notice on the route's own answer", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "notice-recorded-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-09-10T00:00:00.000Z" }],
  }), "utf8");
  const retryAt = new Date(Date.now() + 600_000).toISOString();

  const attempt = await spawn(cwd, "binding_notice_recorded_20260910", undefined, "acct-chosen-by-hand", undefined, retryAt);

  expect(attempt.status).toBe(202);
  expect(attempt.accountOverride).toMatchObject({
    accountId: "acct-chosen-by-hand",
    reason: "outside-pool",
    recorded: true,
  });
});

test("a record the journal REFUSED says so on the answer rather than only in a server log", async () => {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "notice-unrecordable-"));
  const project = projectForCwd(cwd)!;
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "claude", accountId: "acct-reserved", project, createdAt: "2026-09-10T00:00:00.000Z" }],
  }), "utf8");
  /* A DIRECTORY where the journal's file belongs: the durable write cannot
     rename over it, so the record is refused while the launch is not. */
  const journal = path.join(STATE, "account-project-overrides.json");
  fs.rmSync(journal, { recursive: true, force: true });
  fs.mkdirSync(journal, { recursive: true });
  const retryAt = new Date(Date.now() + 600_000).toISOString();
  try {
    const attempt = await spawn(cwd, "binding_notice_refused_20260910", undefined, "acct-chosen-by-hand", undefined, retryAt);

    /* The launch was NOT refused for it — attribution that failed to write is
       not a reason to refuse a gesture the operator is entitled to make. */
    expect(attempt.status).toBe(202);
    expect(attempt.accountOverride).toMatchObject({ accountId: "acct-chosen-by-hand", recorded: false });
    expect(attempt.accountOverride?.recordFailure).toBeTruthy();
  } finally {
    fs.rmSync(journal, { recursive: true, force: true });
  }
});
