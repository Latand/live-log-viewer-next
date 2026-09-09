import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

/**
 * THE ROTATION THE BINDING REFUSED (operator report, 2026-09-10).
 *
 * The seat for this repository's project was running on a Codex account the
 * project's binding does not list. The operator opened the rotate draft — which
 * PREFILLS the incumbent's account — pressed Confirm, and the panel answered
 *
 *   codex account <account> is not allowed on project <project>
 *   (allowed codex accounts: …)
 *
 * over a live incumbent, with the durable pending intent carrying that error.
 * The seat could not be rotated at all: every account the draft offered by
 * default was the one the fence refused, and the operator's own explicit choice
 * of any other unbound account was refused on the same grounds.
 *
 * The directive that settles it: a manually selected authenticated account is
 * usable for rotation and launch whatever the project's automatic-account
 * binding says. ONLY autonomous selection and fallback stay inside the pool.
 *
 * WHAT THIS FILE DRIVES, and what it does not:
 *
 *  - The real `POST /api/orchestrator/rotate` route module, over a loopback
 *    listener, so the rotate draft's own body shape is what travels.
 *  - The real seat command behind it: the durable intent, the handoff
 *    composition, the activation, the pending intent's error field.
 *  - The real account decision, `resolveHealthySpawnAccount`, reading a real
 *    binding record from a private state directory.
 *
 * The one seam standing in for production is `/api/spawn` itself: the seat
 * command's `spawn` dependency here resolves the account exactly as that route
 * does — same function, same arguments, same 409-with-message on a refusal —
 * and then reports an accepted launch instead of starting a process. Its
 * fidelity is the argument tuple, and that tuple is asserted below.
 *
 * Account and project names are invented; every path is inside the sandbox.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-account-choice-"));
const STATE = path.join(SANDBOX, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const OVERRIDES = path.join(STATE, "account-project-overrides.json");
const PROJECT = "project-atlas";
const AT = "2026-09-10T00:00:00.000Z";
const INCUMBENT_ID = "conversation_44444444-4444-4444-8444-444444444444";
const SUCCESSOR_ID = "conversation_55555555-5555-4555-8555-555555555555";

const PREVIOUS = {
  state: process.env.LLV_STATE_DIR,
  codexHome: process.env.LLV_CODEX_HOME,
  claudeHome: process.env.LLV_CLAUDE_HOME,
  home: process.env.HOME,
  xdgConfig: process.env.XDG_CONFIG_HOME,
  xdgCache: process.env.XDG_CACHE_HOME,
  tmp: process.env.TMPDIR,
};

/* Every root this test could otherwise reach into, pointed at the sandbox
   BEFORE the modules under test are imported: the Viewer's state, both provider
   homes, the operator's home and XDG roots, and the temp dir. Nothing here
   reads or writes anything the running Viewer owns. */
fs.mkdirSync(path.join(SANDBOX, "home"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "tmp"), { recursive: true });
process.env.LLV_STATE_DIR = STATE;
process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");
process.env.HOME = path.join(SANDBOX, "home");
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "home", ".config");
process.env.XDG_CACHE_HOME = path.join(SANDBOX, "home", ".cache");
process.env.TMPDIR = path.join(SANDBOX, "tmp");

const { POST: rotateRoute } = await import("@/app/api/orchestrator/rotate/route");
const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
const { ProjectAccountRefusedError, resolveHealthySpawnAccount } = await import("@/lib/accounts/manager");
const { accountProjectOverrides } = await import("@/lib/accounts/accountOverrides");
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { resetProjectAliasesForTests } = await import("@/lib/projects/aliases");
import type { SeatCommandDependencies } from "./seatCommand";

const { setSeatCommandDependenciesForTests } = await import("./seatCommand");
const {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorSeatFor,
} = await import("./seats");

let listener: ReturnType<typeof Bun.serve> | null = null;
let origin = "";
/** Bound to the project; the pool. */
let bound = "";
/** Authenticated, and deliberately NOT bound to the project. */
let unbound = "";

beforeAll(() => {
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/orchestrator/rotate" || request.method !== "POST") {
        return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
      }
      const answer = await rotateRoute(new NextRequest(url, {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      }));
      return new Response(await answer.text(), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${listener.port}`;
});

afterAll(() => {
  listener?.stop(true);
  listener = null;
  setAgentRegistryForTests(null);
  setSeatCommandDependenciesForTests(null);
  for (const [key, value] of [
    ["LLV_STATE_DIR", PREVIOUS.state],
    ["LLV_CODEX_HOME", PREVIOUS.codexHome],
    ["LLV_CLAUDE_HOME", PREVIOUS.claudeHome],
    ["HOME", PREVIOUS.home],
    ["XDG_CONFIG_HOME", PREVIOUS.xdgConfig],
    ["XDG_CACHE_HOME", PREVIOUS.xdgCache],
    ["TMPDIR", PREVIOUS.tmp],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX, "accounts"), { recursive: true, force: true });
  resetProjectAliasesForTests();
  const created = new Map<string, string>();
  for (const label of ["Bound carrier", "Unbound carrier"]) {
    const account = createManagedCodexAccount(label);
    /* Authenticated: the directive covers an authenticated account, and an
       account with no credential is a different refusal that still stands. */
    fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
    created.set(label, account.id);
  }
  bound = created.get("Bound carrier")!;
  unbound = created.get("Unbound carrier")!;
  const registry = new AgentRegistry(path.join(SANDBOX, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  /* The engine is routed at the BOUND account, so nothing below can pass by
     accident: an automatic pick and the pool agree, and only an explicit choice
     can reach the unbound account. */
  registry.setEngineRouting("codex", bound);
  setAgentRegistryForTests(registry);
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({
    schemaVersion: 1,
    bindings: [{ engine: "codex", accountId: bound, project: PROJECT, createdAt: AT }],
  }), "utf8");
});

afterEach(() => {
  setSeatCommandDependenciesForTests(null);
});

/** The incumbent, seated exactly as production's was: designated, active, and
    — the condition that made this unrecoverable — running on an account the
    project's binding does not list. */
function seatIncumbent(): void {
  beginOrchestratorSeatIntent({
    project: PROJECT,
    mandate: "own the board",
    clientRequestId: "seed_atlas_0001",
    mode: "spawn",
    engine: "codex",
    model: "gpt-6-astra",
    now: AT,
  });
  completeOrchestratorSeatIntent({
    project: PROJECT,
    clientRequestId: "seed_atlas_0001",
    conversationId: INCUMBENT_ID,
    path: path.join(SANDBOX, "incumbent.jsonl"),
    now: AT,
  });
}

interface SpawnAsk {
  accountId: unknown;
  project: unknown;
  engine: unknown;
}

/** `/api/spawn`'s account decision, and nothing else it does. */
function dependencies(): { asks: SpawnAsk[]; resolved: string[] } {
  const asks: SpawnAsk[] = [];
  const resolved: string[] = [];
  const deps: SeatCommandDependencies = {
    spawn: async (body) => {
      asks.push({ accountId: body.accountId, project: body.project, engine: body.engine });
      try {
        const account = await resolveHealthySpawnAccount(
          body.engine as "claude" | "codex",
          body.accountId as string | undefined,
          (body.project as string | null) ?? null,
        );
        resolved.push(account.accountId);
        return { status: 200, body: { ok: true, conversationId: SUCCESSOR_ID, path: path.join(SANDBOX, "successor.jsonl") } };
      } catch (error) {
        /* The route answers a boundary as a conflict carrying the refusal's
           own wording; the seat command records that wording on the intent. */
        const status = error instanceof ProjectAccountRefusedError ? 409 : 500;
        return { status, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
      }
    },
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: (conversationId) => ({
      kind: "eligible",
      conversationId,
      path: path.join(SANDBOX, "incumbent.jsonl"),
      cwd: path.join(SANDBOX, "checkout"),
      project: PROJECT,
      engine: "codex",
    }),
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: "codex", model: "gpt-6-astra" }),
    now: () => AT,
  };
  setSeatCommandDependenciesForTests(deps);
  return { asks, resolved };
}

async function rotate(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/api/orchestrator/rotate", origin), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ project: PROJECT, ...body }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("REGRESSION: the operator rotates the seat onto an authenticated account the project's binding does not list", async () => {
  seatIncumbent();
  const { asks, resolved } = dependencies();

  const answer = await rotate({ clientRequestId: "rotate-onto-unbound-1", accountId: unbound });

  /* The refusal that shipped answered 409 here and wrote its message onto the
     pending intent, which is what the panel rendered over the live incumbent. */
  expect(answer.status).toBe(200);
  expect(answer.body.error).toBeUndefined();
  /* The rotate draft's account reached the account seam unchanged... */
  expect(asks).toEqual([{ accountId: unbound, project: PROJECT, engine: "codex" }]);
  /* ...and the seam launched on the account the operator chose, not on the
     pool's account with the choice quietly dropped. */
  expect(resolved).toEqual([unbound]);

  const seat = orchestratorSeatFor(PROJECT);
  expect(seat.active?.conversationId).toBe(SUCCESSOR_ID);
  expect(seat.active?.predecessorConversationId).toBe(INCUMBENT_ID);
  /* Nothing is left pending for the panel to render as a failed designation. */
  expect(seat.pending).toBeNull();
});

test("the AUTONOMOUS pick behind the same rotation still draws from the pool only", async () => {
  /* The identical rotation with no account named. Nobody chose, so the fence is
     the fence: the pool decides, and the unbound account is not in it. */
  seatIncumbent();
  const { asks, resolved } = dependencies();

  const answer = await rotate({ clientRequestId: "rotate-automatic-1" });

  expect(answer.status).toBe(200);
  expect(asks).toEqual([{ accountId: undefined, project: PROJECT, engine: "codex" }]);
  expect(resolved).toEqual([bound]);
});

test("a refused rotation leaves the incumbent seated and the refusal readable, with no fabricated successor", async () => {
  /* The refusal that must still happen, and the shape a truthful failure keeps.
     The record is damaged and nothing is named, so this is the AUTONOMOUS pick
     — no pool can be seen and none may be picked. What the panel is owed
     afterwards is the incumbent it still has, the reason on the record, and no
     successor: a designation that failed must not read as one that landed. */
  seatIncumbent();
  const { resolved } = dependencies();
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");

  const answer = await rotate({ clientRequestId: "rotate-damaged-record-1" });

  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(resolved).toEqual([]);
  const seat = orchestratorSeatFor(PROJECT);
  expect(seat.active?.conversationId).toBe(INCUMBENT_ID);
  expect(seat.pending?.intent.error).toContain("account-project-bindings.json");
  expect(seat.pending?.conversationId).toBeNull();
});

test("a rotation onto an unbound account is ATTRIBUTED, so the crossing is visible rather than silent", async () => {
  /* The binding stops being a veto here, so it has to become a record: the
     project view renders this journal beside the pool. Written by the launch
     seam itself — `/api/spawn` — so this asserts the journal that seam appends
     to, from the same explicit choice, with the record and the pool it read. */
  seatIncumbent();
  dependencies();
  const { attributeNamedAccountChoice } = await import("@/lib/accounts/accountOverrides");

  await rotate({ clientRequestId: "rotate-attributed-1", accountId: unbound });
  const notice = attributeNamedAccountChoice({
    engine: "codex",
    project: PROJECT,
    accountId: unbound,
    conversationId: SUCCESSOR_ID,
    actor: { kind: "operator" },
    via: "launch",
    now: () => AT,
  });

  expect(notice).toMatchObject({ outsidePool: true, accountId: unbound, reason: "outside-pool", recorded: true });
  expect(notice?.allowedAccountIds).toEqual([bound]);
  expect(fs.existsSync(OVERRIDES)).toBe(true);
  expect(accountProjectOverrides({ project: PROJECT })).toEqual([expect.objectContaining({
    engine: "codex",
    accountId: unbound,
    conversationId: SUCCESSOR_ID,
    actor: "operator",
    via: "launch",
  })]);
});
