import { afterEach, expect, test } from "bun:test";

import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";
import { bindVoiceSession, recordVoiceHandoff, resetVoiceViewBindings } from "@/lib/runtime/voiceViewBinding";
import { admitVoiceSelectedContext } from "@/lib/runtime/voiceViewBinding";
import { captureSelectedContext } from "@/lib/selection/selectedContext";

import { voiceUtteranceLookup, productionViewerControlDependencies } from "./bindings";

/**
 * The hop itself (#1629): the MCP server runs beside the agent, the voice ledger
 * lives in the Viewer, and everything between them is a real HTTP request.
 *
 * The in-process suite proves what the reader DOES with each state; this one
 * proves the states survive the wire — that the request goes to the right path
 * with the right body, that the capability the agent holds is forwarded, and
 * that a joined answer arrives with its reference and handoff intact. It uses
 * the production control hop against a loopback server that answers with the
 * production `executeRealtimeControl`, so the only thing standing in for real
 * deployment is which port the hop dials.
 *
 * The caller resolution is deliberately NOT here. Which conversation an agent
 * is, and whether it may read another's call, is authority rather than wiring,
 * and it is proven against the real ledger in `voiceUtteranceContext.test.ts`.
 */

const CALLER = "conversation_wiring_caller";
const CARD = "conversation_wiring_card";
const DESK = { viewSessionId: "vs-wire-1", deviceId: "dev-wire" };
const NOW = Date.parse("2026-09-10T10:00:00.000Z");

const servers: { stop(): void }[] = [];
const originalPort = process.env.LLV_VIEWER_PORT;
const originalTarget = process.env.LLV_VIEWER_DEPLOY_TARGET;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  resetVoiceViewBindings();
  if (originalPort === undefined) delete process.env.LLV_VIEWER_PORT;
  else process.env.LLV_VIEWER_PORT = originalPort;
  if (originalTarget === undefined) delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  else process.env.LLV_VIEWER_DEPLOY_TARGET = originalTarget;
});

interface Received {
  pathname: string;
  method: string;
  body: Record<string, unknown>;
  origin: string | null;
  fetchSite: string | null;
}

/** A Viewer on a loopback port, answering with the production control. */
function viewer(received: Received[], answer?: (body: Record<string, unknown>) => Response) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.json() as Record<string, unknown>;
      received.push({
        pathname: url.pathname,
        method: request.method,
        body,
        origin: request.headers.get("origin"),
        fetchSite: request.headers.get("sec-fetch-site"),
      });
      if (answer) return answer(body);
      /* The production control, with the authority the route would have derived
         from the forwarded capability. */
      const result = await executeRealtimeControl(
        body,
        () => null,
        { caller: { kind: "conversation", conversationId: String(body.conversationId) }, operator: false },
      );
      return Response.json(result.body, { status: result.status });
    },
  });
  servers.push(server);
  /* The hop resolves its origin from this, exactly as it does in the image. */
  process.env.LLV_VIEWER_PORT = String(server.port);
  delete process.env.LLV_VIEWER_DEPLOY_TARGET;
  return server;
}

const post = () => productionViewerControlDependencies().post;

/** The native work identity the MCP transport reads off `params._meta` and this
    reader forwards across the hop (#1629). */
const WORK = { threadId: "thread-wire", turnId: "turn-wire", turnTrigger: "realtime", callId: null, itemId: null };

function reference(card: string) {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: `${card}.jsonl`, selectedPaths: [] },
    cards: [{ path: `${card}.jsonl`, conversationId: card, label: card }],
    identity: DESK,
    revision: 1,
    now: NOW,
  });
}

test("the reader asks the realtime control for the named conversation, same-origin", async () => {
  const received: Received[] = [];
  viewer(received);
  await voiceUtteranceLookup(CALLER, post(), WORK);

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    pathname: "/api/runtime/realtime",
    method: "POST",
    /* The work identity rides the same hop: without it the Viewer can only
       answer about the conversation, which is the substitution #1629 removes. */
    body: { action: "utteranceContext", conversationId: CALLER, work: WORK },
    fetchSite: "same-origin",
  });
  /* The same-origin headers the Viewer's cross-origin guard requires. */
  expect(received[0]!.origin).toContain("127.0.0.1");
});

test("a joined answer survives the wire with its reference and handoff", async () => {
  const received: Received[] = [];
  viewer(received);
  const utterance = { id: "a".repeat(32), sequence: 1 };
  const handoff = { handoffId: "handoff-w", itemId: "item-w", userBidiTurnId: "bidi-w" };
  bindVoiceSession(CALLER, "rt-wire", DESK);
  admitVoiceSelectedContext({
    conversationId: CALLER, realtimeSessionId: "rt-wire", reference: reference(CARD), utterance, now: NOW,
  });
  recordVoiceHandoff({ conversationId: CALLER, realtimeSessionId: "rt-wire", utterance, handoff });

  const lookup = await voiceUtteranceLookup(CALLER, post(), WORK);
  expect(lookup.state).toBe("joined");
  expect(lookup.state === "joined" && lookup.reference.state === "selected"
    && lookup.reference.conversationId).toBe(CARD);
  expect(lookup.state === "joined" && lookup.handoff).toEqual(handoff);
});

test("every refusing state crosses the wire as itself", async () => {
  const received: Received[] = [];
  viewer(received);

  expect(await voiceUtteranceLookup(CALLER, post(), WORK)).toEqual({ state: "no-call" });

  bindVoiceSession(CALLER, "rt-wire", DESK);
  expect(await voiceUtteranceLookup(CALLER, post(), WORK)).toEqual({ state: "no-reference" });

  admitVoiceSelectedContext({
    conversationId: CALLER, realtimeSessionId: "rt-wire", reference: reference(CARD),
    utterance: { id: "b".repeat(32), sequence: 1 }, now: NOW,
  });
  expect(await voiceUtteranceLookup(CALLER, post(), WORK)).toEqual({ state: "awaiting-handoff" });

  /* And the two states this reader learned for #1629, both of which carry the
     reason the Viewer gave rather than being flattened into "no card". */
  expect(await voiceUtteranceLookup(CALLER, post(), null)).toMatchObject({ state: "unidentified-work" });
  expect(await voiceUtteranceLookup(CALLER, post(), { ...WORK, turnTrigger: null }))
    .toEqual({ state: "unrelated-work" });
});

test("an ambiguity the Viewer reports crosses the wire with its reason", async () => {
  const received: Received[] = [];
  viewer(received, () => Response.json({
    ok: true,
    utterance: { state: "ambiguous", reason: "more than one spoken turn is waiting to be claimed" },
  }));
  const lookup = await voiceUtteranceLookup(CALLER, post(), WORK);
  expect(lookup.state).toBe("ambiguous");
  expect(lookup.state === "ambiguous" && lookup.reason).toContain("more than one");
});

test("a Viewer that refuses the read is reported as unavailable, never as no card", async () => {
  /* The distinction the agent acts on: "you selected nothing" is a fact about
     the operator, and "nobody could look" is a fact about this machine. */
  const received: Received[] = [];
  viewer(received, () => Response.json({ error: "utteranceContext reads what the operator's own voice call points at." }, { status: 403 }));

  const lookup = await voiceUtteranceLookup(CALLER, post(), WORK);
  expect(lookup.state).toBe("unavailable");
  expect(lookup.state === "unavailable" && lookup.reason).toContain("own voice call");
});

test("an answer in a shape this reader does not know is unavailable, never guessed at", async () => {
  const received: Received[] = [];
  viewer(received, () => Response.json({ ok: true, utterance: { state: "something-new" } }));
  const unknown = await voiceUtteranceLookup(CALLER, post());
  expect(unknown.state).toBe("unavailable");
  expect(unknown.state === "unavailable" && unknown.reason).toContain("something-new");

  servers.splice(0).forEach((server) => server.stop());
  viewer(received, () => Response.json({ ok: true, utterance: { state: "joined", handoff: {} } }));
  const incomplete = await voiceUtteranceLookup(CALLER, post());
  expect(incomplete.state).toBe("unavailable");
  expect(incomplete.state === "unavailable" && incomplete.reason).toContain("no readable reference");
});

test("a Viewer that is not listening is unavailable rather than an empty selection", async () => {
  const server = viewer([]);
  server.stop();
  const lookup = await voiceUtteranceLookup(CALLER, post());
  expect(lookup.state).toBe("unavailable");
});
