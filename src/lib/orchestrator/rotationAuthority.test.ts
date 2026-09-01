import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireOperatorAuthority, setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { viewerMcpBindings, type ViewerControlDependencies } from "@/lib/mcp/bindings";

import {
  handleOrchestratorRotationRequest,
  type SeatCommandDependencies,
  type SeatCommandResult,
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
 *    holds no copy of the rule. Both are driven here through
 *    `handleOrchestratorRotationRequest` — the function the route runs — with
 *    the same actor, and compared in the accept case AND in a refusal.
 *
 * Nothing here spawns a process or touches the operator's live registry: the
 * seat command's spawn/deliver/summarize seams are injected, and every read and
 * write lands in a private state directory.
 */

const AT = "2026-07-29T00:00:00.000Z";
const SEAT_ID = "conversation_11111111-1111-4111-8111-111111111111";
const BYSTANDER_ID = "conversation_22222222-2222-4222-8222-222222222222";
const SUCCESSOR_ID = "conversation_33333333-3333-4333-8333-333333333333";
const CAPABILITY = crypto.randomBytes(32).toString("base64url");

let sandbox = "";
let previousStateDir: string | undefined;
let previousCapability: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  previousCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-rotation-authority-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  setCallerConversationResolverForTests(null);
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  if (previousCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = previousCapability;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

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
  return { deps, spawns };
}

interface PostedCall {
  pathname: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * The MCP tool's real control plane, with only the transport replaced: a post to
 * the rotation route runs the ROUTE's own handler over the headers the binding
 * forwarded, and a refusal is turned into a thrown error by the same rule
 * `postViewerControl` applies in production (`result.error` or a non-ok status
 * becomes the tool's exception). Nothing about authority is re-decided here.
 */
function routeBackedControl(deps: SeatCommandDependencies): {
  control: ViewerControlDependencies;
  posted: PostedCall[];
} {
  const posted: PostedCall[] = [];
  const control: ViewerControlDependencies = {
    post: async (pathname, body, headers) => {
      posted.push({ pathname, body, headers: headers ?? {} });
      if (pathname !== "/api/orchestrator/rotate") return { ok: true, outcome: "delivered" };
      const answer = await routeAnswer(headers ?? {}, body, deps);
      const failed = typeof answer.body.error === "string" || answer.status >= 400;
      if (failed) throw new Error(String(answer.body.error ?? `Viewer control request failed with status ${answer.status}`));
      return answer.body;
    },
  };
  return { control, posted };
}

/** What `POST /api/orchestrator/rotate` answers, driven through the same
    function the route module calls after its cross-origin check. */
function routeAnswer(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deps: SeatCommandDependencies,
): Promise<SeatCommandResult> {
  return handleOrchestratorRotationRequest({ headers: new Headers(headers) }, body, deps);
}

function tools(control: ViewerControlDependencies) {
  return viewerMcpBindings(undefined, control, {} as never);
}

test("REGRESSION (#1402): the designated seat rotates ITSELF through rotate_orchestrator, and the record names it", async () => {
  seatSeeded();
  callerIs(SEAT_ID);
  const { deps, spawns } = dependencies();
  const { control, posted } = routeBackedControl(deps);

  const result = await tools(control).rotate_orchestrator({
    clientRequestId: "rotate-self-1",
    project: "proj-a",
    handoffNotes: "the operator asked for this from a phone",
  }) as Record<string, unknown>;

  /* The tool forwarded the seat's own capability — the very thing that used to
     make the route refuse it — and the rotation happened anyway. */
  expect(posted[0]!.headers[VIEWER_SPAWN_CAPABILITY_HEADER]).toBe(CAPABILITY);
  expect(spawns).toHaveLength(1);
  expect(result.conversationId).toBe(SUCCESSOR_ID);
  expect(result.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
  /* Attribution, on the answer: the caller reads back who it was recorded as
     rather than trusting that anything was recorded. */
  expect(result.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });

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
  const { deps, spawns } = dependencies();
  const { control } = routeBackedControl(deps);

  const result = await tools(control).rotate_orchestrator({
    clientRequestId: "rotate-bystander-1",
    project: "proj-a",
  }) as Record<string, unknown>;

  expect(spawns).toHaveLength(1);
  expect(result.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
  /* Not a seat, so no epoch of its own — named all the same. */
  expect(result.triggeredBy).toEqual({ kind: "agent", conversationId: BYSTANDER_ID, seatEpoch: null });
  expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toEqual({
    kind: "agent",
    conversationId: BYSTANDER_ID,
    seatEpoch: null,
  });
});

test("REGRESSION (#1402): the operator-only rule still refuses this exact request — and rotation no longer asks it", async () => {
  seatSeeded();
  callerIs(SEAT_ID);
  const { deps } = dependencies();
  const request = { headers: new Headers({ [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY }) };

  /* The old gate is intact for the actions it still governs — designation among
     them — and it is exactly what returned 403 to the seat that night. */
  const operatorOnly = requireOperatorAuthority(request);
  expect(operatorOnly.ok).toBe(false);
  if (!operatorOnly.ok) {
    expect(operatorOnly.error).toContain("an agent may not perform it, whatever role it holds");
  }

  /* The same request, on the rotation path, rotates. */
  const answer = await routeAnswer({ [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY }, {
    project: "proj-a",
    clientRequestId: "rotate-gate-1",
  }, deps);
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
      seatSeeded();
      if (actor === "seat") callerIs(SEAT_ID);
      else callerIsOperator();

      const { deps } = dependencies();
      const { control, posted } = routeBackedControl(deps);
      const request = { clientRequestId: "rotate-parity-1", project: "proj-a" };
      const answer = surface === "tool"
        ? await tools(control).rotate_orchestrator(request) as Record<string, unknown>
        : (await routeAnswer(headersFor(actor), request, deps)).body;

      const expected: OrchestratorSeatTrigger = actor === "seat"
        ? { kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 }
        : { kind: "operator", conversationId: null, seatEpoch: null };
      expect(answer.conversationId).toBe(SUCCESSOR_ID);
      expect(answer.rotatedFrom).toMatchObject({ conversationId: SEAT_ID });
      expect(answer.triggeredBy).toEqual(expected);
      expect(orchestratorSeatFor("proj-a").active?.triggeredBy).toEqual(expected);
      if (surface === "tool") {
        /* The tool reached the route rather than deciding anything itself. */
        expect(posted.map((call) => call.pathname)).toEqual(["/api/orchestrator/rotate"]);
      }
    }
  }
});

test("the route and the MCP tool answer the same for the same actor: REFUSED, and the refusal is not about the actor", async () => {
  /* Nothing designated, so there is no incumbent to rotate. This is the rotation
     command's OWN refusal — the only kind left on this path — and it must reach
     both surfaces identically for the same actor that the accept case above
     rotates with. */
  callerIs(SEAT_ID);
  const { deps, spawns } = dependencies();
  const { control } = routeBackedControl(deps);
  const request = { clientRequestId: "rotate-parity-2", project: "proj-a" };

  const refusal = await routeAnswer(headersFor("seat"), request, deps);
  expect(refusal.status).toBe(409);
  expect(refusal.body.code).toBe("no_incumbent");

  await expect(tools(control).rotate_orchestrator(request)).rejects.toThrow(String(refusal.body.error));
  expect(spawns).toEqual([]);

  /* The same actor, one designation later, rotates — so the refusal above was
     about the seat's absence and never about who was asking. */
  seatSeeded();
  const accepted = await routeAnswer(headersFor("seat"), { ...request, clientRequestId: "rotate-parity-3" }, deps);
  expect(accepted.status).toBe(200);
  expect(accepted.body.triggeredBy).toEqual({ kind: "agent", conversationId: SEAT_ID, seatEpoch: 1 });
});

/** Exactly what the MCP binding forwards for each actor, so the route is driven
    with the same evidence the tool sends. */
function headersFor(actor: "seat" | "operator"): Record<string, string> {
  return actor === "seat" ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: CAPABILITY } : {};
}
