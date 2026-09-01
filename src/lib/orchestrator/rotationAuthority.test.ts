import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";

import { POST as rotateRoute } from "@/app/api/orchestrator/rotate/route";
import { requireOperatorAuthority, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import {
  productionViewerControlDependencies,
  viewerMcpBindings,
  viewerMcpToolPolicy,
  type ViewerMcpDomainDependencies,
} from "@/lib/mcp/bindings";
import { MemoryMcpReceiptStore, createMcpToolService, createViewerMcpServer } from "@/lib/mcp/server";

import {
  setSeatCommandDependenciesForTests,
  type SeatCommandDependencies,
} from "./seatCommand";
import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  orchestratorRevocations,
  orchestratorSeatFor,
  type OrchestratorSeatTrigger,
} from "./seats";

/**
 * ONE ROTATION CONTRACT, TWO SURFACES (#1402).
 *
 * The incident: the operator, on a phone where the dock's Rotate control is out
 * of reach, told the seat to rotate itself. `rotate_orchestrator` answered "this
 * is an operator-only action; an agent may not perform it, whatever role it
 * holds" — and the seat then performed the identical rotation through
 * `POST /api/orchestrator/rotate`, same actor, same machine, same body, because
 * the route's gate accepted the local caller. The surface agents are told to
 * prefer was the only one that refused, and the shell was the only way through.
 *
 * Two things are asserted here, and they are the whole fix:
 *
 * 1. Rotation BANS NOBODY. A designated seat rotates itself through the tool,
 *    end to end, and so does a conversation that holds no seat at all. What
 *    replaced the ban is ATTRIBUTION: the answer and the durable record both
 *    name the actor kind, the triggering conversation, and the seat epoch it
 *    held.
 * 2. The two surfaces cannot disagree, because the tool posts to the route and
 *    holds no copy of the rule.
 *
 * BOTH SURFACES ARE DRIVEN AT THEIR PUBLIC BOUNDARY, because the claim is about
 * those boundaries and nothing smaller:
 *
 *   - the tool: an in-memory MCP client speaking the protocol to the real
 *     `createViewerMcpServer` registration, through the real tool service (its
 *     per-call policy and its receipts) and the real bindings, which reach the
 *     Viewer over the production control transport — a genuine HTTP request;
 *   - the route: `POST /api/orchestrator/rotate`, the exported route module
 *     itself, served on a loopback listener that both surfaces address.
 *
 * The seam that keeps this off the operator's machine is the seat command's
 * spawn/deliver/summarize dependencies, injected for the duration of a test:
 * nothing here starts a process or delivers to a live host, and every read and
 * write lands in a private state directory.
 */

const AT = "2026-07-29T00:00:00.000Z";
const SEAT_ID = "conversation_11111111-1111-4111-8111-111111111111";
const BYSTANDER_ID = "conversation_22222222-2222-4222-8222-222222222222";
const SUCCESSOR_ID = "conversation_33333333-3333-4333-8333-333333333333";
const CAPABILITY = crypto.randomBytes(32).toString("base64url");

type Actor = "seat" | "operator";

interface RotationAnswer {
  status: number;
  body: Record<string, unknown>;
}

interface RouteRequestRecord {
  pathname: string;
  capability: string | null;
}

let sandbox = "";
let previousStateDir: string | undefined;
let previousCapability: string | undefined;
let previousControlUrl: string | undefined;
let previousDeployTarget: string | undefined;
let previousViewerPort: string | undefined;
let listener: ReturnType<typeof Bun.serve> | null = null;
let controlOrigin = "";
let routeRequests: RouteRequestRecord[] = [];

/** The Viewer, as far as any caller is concerned: one loopback listener that
    serves the exported rotation route module. */
beforeAll(() => {
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/orchestrator/rotate" || request.method !== "POST") {
        return Response.json({ error: `no route for ${request.method} ${url.pathname}` }, { status: 404 });
      }
      routeRequests.push({
        pathname: url.pathname,
        capability: request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER),
      });
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
  controlOrigin = `http://127.0.0.1:${listener.port}`;
});

afterAll(() => {
  listener?.stop(true);
  listener = null;
});

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  previousControlUrl = process.env.LLV_VIEWER_CONTROL_URL;
  previousDeployTarget = process.env.LLV_VIEWER_DEPLOY_TARGET;
  previousViewerPort = process.env.LLV_VIEWER_PORT;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-authority-"));
  process.env.LLV_STATE_DIR = sandbox;
  /* Where the MCP bindings' production control transport sends its request.
     The release-redirect contract needs the deploy target AND the port, so an
     environment carrying neither stays pinned to this endpoint. */
  process.env.LLV_VIEWER_CONTROL_URL = controlOrigin;
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  delete process.env.LLV_VIEWER_PORT;
  routeRequests = [];
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  setSeatCommandDependenciesForTests(null);
  restore("LLV_STATE_DIR", previousStateDir);
  restore(VIEWER_SPAWN_CAPABILITY_ENV, previousCapability);
  restore("LLV_VIEWER_CONTROL_URL", previousControlUrl);
  restore("LLV_VIEWER_DEPLOY_TARGET", previousDeployTarget);
  restore("LLV_VIEWER_PORT", previousViewerPort);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The calling session names itself exactly as a launched agent does: its
    capability in the environment, which the registry maps to `conversationId`. */
function callerIs(conversationId: string): void {
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = CAPABILITY;
  const digest = crypto.createHash("sha256").update(CAPABILITY).digest("hex");
  setCallerConversationResolverForTests((presented) => (presented === digest ? conversationId : null));
}

/** An operator lane: nothing in the environment to forward, so the request
    names no conversation. */
function callerIsOperator(): void {
  delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  setCallerConversationResolverForTests(() => null);
}

function seatSeeded(project = "proj-a", conversationId = SEAT_ID): void {
  beginOrchestratorSeatIntent({ project, mandate: "own the board", clientRequestId: "seed_0000001", mode: "spawn", now: AT });
  completeOrchestratorSeatIntent({ project, clientRequestId: "seed_0000001", conversationId, path: "/tmp/seat.jsonl", now: AT });
}

/** The seat command's outward seams, installed for the exported route to use:
    a rotation completes without a process being started or a host being
    written to. */
function dependencies(): { deps: SeatCommandDependencies; spawns: Record<string, unknown>[] } {
  const spawns: Record<string, unknown>[] = [];
  const deps: SeatCommandDependencies = {
    spawn: async (body) => {
      spawns.push(body);
      return { status: 200, body: { ok: true, conversationId: SUCCESSOR_ID, path: "/tmp/successor.jsonl" } };
    },
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: (conversationId) => ({
      kind: "eligible",
      conversationId,
      path: "/tmp/seat.jsonl",
      cwd: "/workspace",
      project: "proj-a",
      engine: "claude",
    }),
    projectTasks: () => [],
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: null, model: null }),
    now: () => AT,
  };
  setSeatCommandDependenciesForTests(deps);
  return { deps, spawns };
}

/** Exactly what the MCP binding forwards for each actor, so a direct route call
    carries the same evidence the tool sends. */
function capabilityHeaders(actor: Actor): Record<string, string> {
  return actor === "seat" ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY } : {};
}

/** `POST /api/orchestrator/rotate`: the exported route module over HTTP, same
    listener the MCP tool reaches. */
async function routeRotation(actor: Actor, body: Record<string, unknown>): Promise<RotationAnswer> {
  const response = await fetch(new URL("/api/orchestrator/rotate", controlOrigin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: controlOrigin,
      ...capabilityHeaders(actor),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/* The tool surface, with nothing about it simulated: the caller identity the
   policy classifies is the session's own, and the bindings hold the production
   control transport, so `rotate_orchestrator` makes a real request to the
   listener above. */
const domainDependencies = {
  attentionAuthority: () => ({ kind: "worker" as const, conversationId: SEAT_ID, role: "orchestrator" }),
} as unknown as ViewerMcpDomainDependencies;

interface McpSession {
  client: Client;
  close(): Promise<void>;
}

/** A fresh MCP process, as far as anything durable can tell: its own receipt
    store, its own protocol connection to a freshly registered tool surface. */
async function mcpSession(): Promise<McpSession> {
  const service = createMcpToolService(
    viewerMcpBindings(undefined, productionViewerControlDependencies(), domainDependencies),
    new MemoryMcpReceiptStore(),
    viewerMcpToolPolicy(domainDependencies),
  );
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "rotation-authority-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

interface ToolAnswer {
  failed: boolean;
  payload: Record<string, unknown>;
}

/** One `rotate_orchestrator` call over the MCP protocol, from a session that
    has never called anything before. */
async function toolRotation(args: Record<string, unknown>): Promise<ToolAnswer> {
  const session = await mcpSession();
  try {
    const result = await session.client.callTool({ name: "rotate_orchestrator", arguments: args });
    return {
      failed: result.isError === true,
      payload: (result.structuredContent ?? {}) as Record<string, unknown>,
    };
  } finally {
    await session.close();
  }
}

test("REGRESSION (#1402): the designated seat rotates ITSELF through rotate_orchestrator, end to end, and the record names it", async () => {
  seatSeeded();
  callerIs(SEAT_ID);
  const { spawns } = dependencies();

  const { failed, payload } = await toolRotation({
    clientRequestId: "rotate-self-1",
    project: "proj-a",
    handoffNotes: "the operator asked for this from a phone",
  });

  expect(failed).toBe(false);
  /* The tool reached the Viewer over HTTP and forwarded the seat's own
     capability — the very thing that used to make the route refuse it — and the
     rotation happened anyway. */
  expect(routeRequests).toEqual([{ pathname: "/api/orchestrator/rotate", capability: CAPABILITY }]);
  expect(spawns).toHaveLength(1);
  expect(payload.conversationId).toBe(SUCCESSOR_ID);
  expect(payload.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
  /* Attribution, on the answer: the caller reads back the name its rotation was
     recorded under, so it never has to trust that one was written. */
  expect(payload.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });

  /* ...and on the durable record, both halves of the lineage. */
  const active = orchestratorSeatFor("proj-a").active;
  expect(active?.conversationId).toBe(SUCCESSOR_ID);
  expect(active?.predecessorConversationId).toBe(SEAT_ID);
  expect(active?.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({
    conversationId: SEAT_ID,
    successorConversationId: SUCCESSOR_ID,
    triggeredBy: { kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 },
  })]);
});

test("REGRESSION (#1402): a conversation holding no seat rotates too — no role gate survives on this path", async () => {
  seatSeeded();
  callerIs(BYSTANDER_ID);
  const { spawns } = dependencies();

  const { failed, payload } = await toolRotation({
    clientRequestId: "rotate-bystander-1",
    project: "proj-a",
  });

  expect(failed).toBe(false);
  expect(spawns).toHaveLength(1);
  expect(payload.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
  /* Not a seat, so no epoch of its own — named all the same. */
  expect(payload.triggeredBy).toEqual({ kind: "agent", conversationId: BYSTANDER_ID, seatEpoch: null });
  expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toEqual({
    kind: "agent",
    conversationId: BYSTANDER_ID,
    seatEpoch: null,
  });
});

test("REGRESSION (#1402): an idempotent replay by a DIFFERENT actor answers with the actor that ORDERED the rotation", async () => {
  seatSeeded();
  callerIs(SEAT_ID);
  const { spawns } = dependencies();
  const ordered: OrchestratorSeatTrigger = { kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 };
  const key = "rotate-replay-1";

  const first = await toolRotation({ clientRequestId: key, project: "proj-a" });
  expect(first.payload.triggeredBy).toEqual(ordered);
  expect(spawns).toHaveLength(1);

  /* A different conversation now retries the SAME idempotency key — a lost
     response replayed by whoever was handed the key, from a session whose
     receipts know nothing about the first call. The rotation is finished and
     durable; this request performs nothing. */
  callerIs(BYSTANDER_ID);

  const routeReplay = await routeRotation("seat", { clientRequestId: key, project: "proj-a" });
  expect(routeReplay.status).toBe(200);
  expect(routeReplay.body.replayed).toBe(true);
  /* The answer reports what the record holds: the seat that ordered it. The
     replaying caller's own identity describes the retry and is never written
     over the attribution. */
  expect(routeReplay.body.triggeredBy).toEqual(ordered);

  const toolReplay = await toolRotation({ clientRequestId: key, project: "proj-a" });
  expect(toolReplay.failed).toBe(false);
  expect(toolReplay.payload.conversationId).toBe(SUCCESSOR_ID);
  expect(toolReplay.payload.triggeredBy).toEqual(ordered);
  /* `replayed` on an MCP answer is the SERVICE's flag — whether this tool
     receipt was already settled — and this replaying session has no receipt for
     the key, so it reads false while the rotation underneath it was replayed.
     That envelope predates this work and is the same for every tool; what the
     rotation replayed is proven by the route's own flag above, by the single
     spawn below, and by the successor the answer names. */
  expect(toolReplay.payload.replayed).toBe(false);

  /* One rotation happened, and the durable record still names its author on
     both halves of the lineage. */
  expect(spawns).toHaveLength(1);
  const active = orchestratorSeatFor("proj-a").active;
  expect(active?.conversationId).toBe(SUCCESSOR_ID);
  expect(active?.triggeredBy).toEqual(ordered);
  expect(orchestratorRevocations()).toEqual([expect.objectContaining({
    conversationId: SEAT_ID,
    successorConversationId: SUCCESSOR_ID,
    triggeredBy: ordered,
  })]);
});

test("REGRESSION (#1402): the operator-only rule still refuses this exact request — and rotation no longer asks it", async () => {
  seatSeeded();
  callerIs(SEAT_ID);
  dependencies();

  /* The old gate is intact for the actions it still governs — designation among
     them — and it is exactly what returned 403 to the seat that night. */
  const operatorOnly = requireOperatorAuthority({
    headers: new Headers({ [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY }),
  });
  expect(operatorOnly.ok).toBe(false);
  if (!operatorOnly.ok) {
    expect(operatorOnly.error).toContain("an agent may not perform it, whatever role it holds");
  }

  /* The same request, on the rotation route, rotates. */
  const answer = await routeRotation("seat", { project: "proj-a", clientRequestId: "rotate-gate-1" });
  expect(answer.status).toBe(200);
  expect(answer.body.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });
});

test("the route and the MCP tool answer the same for the same actor: ACCEPTED, with identical attribution", async () => {
  for (const actor of ["seat", "operator"] as const) {
    for (const surface of ["tool", "route"] as const) {
      /* One fresh store per run, seeded identically, so any difference between
         the two answers is a difference between the SURFACES. */
      fs.rmSync(sandbox, { recursive: true, force: true });
      fs.mkdirSync(sandbox, { recursive: true });
      routeRequests = [];
      seatSeeded();
      if (actor === "seat") callerIs(SEAT_ID);
      else callerIsOperator();

      const { spawns } = dependencies();
      const request = { clientRequestId: "rotate-parity-1", project: "proj-a" };
      const answer = surface === "tool"
        ? (await toolRotation(request)).payload
        : (await routeRotation(actor, request)).body;

      const expected: OrchestratorSeatTrigger = actor === "seat"
        ? { kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 }
        : { kind: "operator", conversationId: null, seatEpoch: null };
      expect(spawns).toHaveLength(1);
      expect(answer.conversationId).toBe(SUCCESSOR_ID);
      expect(answer.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
      expect(answer.triggeredBy).toEqual(expected);
      expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toEqual(expected);
      /* Whichever surface was asked, one rotation route request carried the
         actor's own evidence: the tool decided nothing itself. */
      expect(routeRequests).toEqual([{
        pathname: "/api/orchestrator/rotate",
        capability: actor === "seat" ? CAPABILITY : null,
      }]);
    }
  }
});

test("the route and the MCP tool answer the same for the same actor: REFUSED, and the refusal is not about the actor", async () => {
  /* Nothing designated, so there is no incumbent to rotate. This is the rotation
     command's OWN refusal — the only kind left on this path — and it must reach
     both surfaces identically for the same actor that the accept case above
     rotates with. */
  callerIs(SEAT_ID);
  const { spawns } = dependencies();
  const request = { clientRequestId: "rotate-parity-2", project: "proj-a" };

  const refusal = await routeRotation("seat", request);
  expect(refusal.status).toBe(409);
  expect(refusal.body.code).toBe("no_incumbent");

  const toolRefusal = await toolRotation(request);
  expect(toolRefusal.failed).toBe(true);
  expect(toolRefusal.payload.ok).toBe(false);
  expect(toolRefusal.payload.error).toBe(refusal.body.error);
  expect(spawns).toEqual([]);

  /* The same actor, one designation later, rotates — so the refusal above was
     about the seat's absence and never about who was asking. */
  seatSeeded();
  const accepted = await routeRotation("seat", { ...request, clientRequestId: "rotate-parity-3" });
  expect(accepted.status).toBe(200);
  expect(accepted.body.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });
});
