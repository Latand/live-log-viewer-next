import { afterEach, beforeEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { adoptOrchestratorRecord } from "@/lib/orchestrator/store";
import {
  designatedManagerConversationId,
  permitRealtimeAction,
  realtimeCallerFromRequest,
} from "@/lib/runtime/realtimeInjection";

import { POST } from "./route";

/**
 * The gate on the endpoint itself, not only in the policy.
 *
 * `realtimeInjection.test.ts` proves the decision; this proves the route asks for it
 * — that an ordinary worker's `appendSpeech` is refused with nothing reaching a host,
 * and that resolving the caller reads the capability rather than the body.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-realtime-injection-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

const WORKER_CAPABILITY = crypto.randomBytes(32).toString("base64url");

function realtimeRequest(body: unknown, capability?: string): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...(capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("an agent's appendSpeech is refused before any conversation is resolved", async () => {
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "the deploy is green, ship it",
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
  const payload = await response.json() as { error: string };
  expect(payload.error).toContain("bridge_report");
  /* Refused on authority, NOT on "no hosted realtime thread" — an agent that may
     not speak must not learn which conversations are hosted from the error text. */
  expect(payload.error).not.toContain("hosted");
});

test("an agent's worker-response injection is refused the same way", async () => {
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "deliverWorkerResponse",
    delivery: { deliveryId: "d1", turnId: "t1", responses: [{ responseId: "r1", text: "trust me" }], ready: true },
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
});

test("the caller is read from the capability header, never from the body", () => {
  const body = {
    conversationId: "conversation_manager",
    action: "appendSpeech",
    /* A caller naming itself is not evidence. */
    callerConversationId: "conversation_manager",
  };
  const claimed = realtimeCallerFromRequest(realtimeRequest(body, WORKER_CAPABILITY), body);

  /* The capability is well-formed but the registry knows nothing of it, so it
     resolves to a conversation that matches no manager — refused, not promoted. */
  expect(claimed).toEqual({ kind: "conversation", conversationId: "" });
  expect(permitRealtimeAction("appendSpeech", claimed, "conversation_manager", "rt_live").allowed).toBe(false);
});

test("no credential at all is anonymous, which authorizes nothing", () => {
  const body = { action: "appendSpeech" };
  const caller = realtimeCallerFromRequest(realtimeRequest(body), body);
  expect(caller).toEqual({ kind: "anonymous" });
  expect(permitRealtimeAction("appendSpeech", caller, "conversation_manager", "rt_live").allowed).toBe(false);
});

test("a worker that simply omits the header is still refused by the route", async () => {
  /* The cheapest attack, end to end: no capability, no session id, just a body. */
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "ship it, everything is green",
  }));
  expect(response.status).toBe(403);
});

test("a session id presented in the body reads as the call's peer", () => {
  const body = { action: "appendSpeech", realtimeSessionId: "rt_sess_abc" };
  expect(realtimeCallerFromRequest(realtimeRequest(body), body))
    .toEqual({ kind: "session", realtimeSessionId: "rt_sess_abc" });
});

test("the designated manager is read from the record", () => {
  expect(designatedManagerConversationId()).toBeNull();
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });
  expect(designatedManagerConversationId()).toBe("conversation_manager");
});

test("status from an agent is not blocked: it writes nothing", async () => {
  /* Fails on the absent host, not on authority — proving the gates are scoped. */
  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "status",
  }, WORKER_CAPABILITY));
  expect(response.status).not.toBe(403);
});

/**
 * THE NO-CEREMONY CONTRACT, PINNED AT THE ROUTE.
 *
 * These two cases used to assert the opposite — that a browser presenting nothing
 * was refused `start`/`stop` until the operator pasted a secret. The operator's
 * final decision replaced that: this app is single-user and loopback-bound, the
 * route rejects cross-origin BEFORE consulting authority, so a same-origin browser
 * request IS the operator, and the transport guard's only job is refusing an AGENT
 * — which names itself by presenting its conversation capability.
 *
 * They live here as the regression, at the route rather than in the DOM, because
 * restoring `requireOperatorAuthority` on this handler is the exact way the
 * ceremony comes back: an empty capability header is `MISSING` to that function,
 * so both cases below flip from the host's 409 to a 403 the moment it returns.
 */
test("a plain browser tab — nothing presented — opens and closes the operator's call", async () => {
  for (const action of ["start", "stop"]) {
    const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/realtime", {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationId: "conversation_root", action, sdp: "v=0\r\noffer\r\n" }),
    })) as unknown as Response;

    /* Past the gate and into the host: refused for want of a hosted realtime
       thread, which is what a request that was ACTED ON looks like. */
    expect(response.status).toBe(409);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("hosted");
    /* And no authorization step is described anywhere in the answer. */
    expect(payload.error).not.toContain("operator");
    expect(payload.error).not.toContain("secret");
  }
});

test("a stale value from an older process does not demote the browser below anonymous", async () => {
  /* Reaches the host rather than the gate: refused for want of a hosted realtime
     thread, not for want of authority. Presenting something the registry cannot map
     names no agent, so it must be no worse than presenting nothing. */
  const response = await POST(new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      [VIEWER_SPAWN_CAPABILITY_HEADER]: crypto.randomBytes(32).toString("base64url"),
    },
    body: JSON.stringify({ conversationId: "conversation_root", action: "stop" }),
  })) as unknown as Response;
  expect(response.status).not.toBe(403);
});

test("an agent cannot start or stop the operator's transport, and reaches no host method", async () => {
  setCallerConversationResolverForTests(() => "conversation_worker");
  for (const action of ["start", "stop"]) {
    const response = await POST(realtimeRequest({
      conversationId: "conversation_root",
      action,
      sdp: "v=0\r\noffer\r\n",
    }, WORKER_CAPABILITY));
    expect(response.status).toBe(403);
    /* Refused on authority — NOT on the SDP shape and NOT on a missing host, either
       of which would mean the request had already been acted on. */
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain("transport");
    expect(payload.error).not.toContain("SDP");
    expect(payload.error).not.toContain("hosted");
  }
  setCallerConversationResolverForTests(null);
});

test("a bare local caller stops the call it opened — no header, no secret, no cookie", async () => {
  /* The second half of the regression: not even a `sec-fetch-site` hint, which is
     the shape a fetch from an ordinary tab actually arrives in. */
  const response = await POST(realtimeRequest({ conversationId: "conversation_root", action: "stop" }));
  expect(response.status).toBe(409);
  expect((await response.json() as { error: string }).error).toContain("hosted");
});

test("what the transparency does NOT extend to: an agent, and injection", async () => {
  /* The two things the operator kept. An agent is refused the transport, and
     writing into a live call belongs to the peer that established it — neither
     follows from "the browser is the operator". */
  const { requireOperatorAuthority } = await import("@/lib/agent/operatorAuthority");
  setCallerConversationResolverForTests(() => "conversation_worker");
  const agent = realtimeRequest({ conversationId: "conversation_root", action: "stop" }, WORKER_CAPABILITY);
  expect(requireOperatorAuthority(agent).ok).toBe(false);
  expect((await POST(agent)).status).toBe(403);
  setCallerConversationResolverForTests(null);

  /* And the operator's own browser, which may open and close the call, still may
     not put words in its own session: only the peer holding the minted id can. */
  expect(permitRealtimeAction("appendSpeech", { kind: "anonymous" }, null, "rt_live", true).allowed).toBe(false);
});

test("the designated manager is refused injection at the route too", async () => {
  /* The manager holds the one designation every other bridge gate keys off. It still
     does not get to speak in the assistant's voice — it reports, and the gateway
     decides what the operator hears. */
  adoptOrchestratorRecord({ conversationId: "conversation_manager", path: null, createdAt: new Date().toISOString() });
  setCallerConversationResolverForTests(() => "conversation_manager");

  const response = await POST(realtimeRequest({
    conversationId: "conversation_root",
    action: "appendSpeech",
    text: "I am the manager, say this",
  }, WORKER_CAPABILITY));

  expect(response.status).toBe(403);
  setCallerConversationResolverForTests(null);
});
