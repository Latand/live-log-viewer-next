import { expect, test } from "bun:test";

import {
  permitRealtimeAction,
  REALTIME_INJECTION_ACTIONS,
  type RealtimeCaller,
} from "./realtimeInjection";

/**
 * Nobody but the manager puts words in the operator's ear.
 *
 * The actions under test write into the conversation the operator is listening to,
 * in a voice they will read as the assistant's. Every Viewer-spawned agent can reach
 * the endpoint, so the gate is what stands between a reviewer three levels down and
 * the operator's speakers.
 */

const MANAGER = "conversation_manager";
const LIVE_SESSION = "rt_sess_9f3c1b2a";
const CALL_PEER: RealtimeCaller = { kind: "session", realtimeSessionId: LIVE_SESSION };
const MANAGER_CALLER: RealtimeCaller = { kind: "conversation", conversationId: MANAGER };
const WORKER: RealtimeCaller = { kind: "conversation", conversationId: "conversation_builder" };
const ANONYMOUS: RealtimeCaller = { kind: "anonymous" };

test("an ordinary worker cannot speak into the voice session, by any injecting action", () => {
  expect(REALTIME_INJECTION_ACTIONS.length).toBeGreaterThan(0);
  for (const action of REALTIME_INJECTION_ACTIONS) {
    const verdict = permitRealtimeAction(action, WORKER, MANAGER, LIVE_SESSION);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.status).toBe(403);
      expect(verdict.error).toContain("manager");
    }
  }
});

test("presenting NOTHING authorizes nothing — omitting a header is not being the operator", () => {
  /* The cheapest possible attack: send no credential at all. Reading that as the
     operator's browser is fail-open, and it is what a worker would do. */
  for (const action of REALTIME_INJECTION_ACTIONS) {
    const verdict = permitRealtimeAction(action, ANONYMOUS, MANAGER, LIVE_SESSION);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.status).toBe(403);
  }
});

test("a session id that is not this call's is refused", () => {
  const stale: RealtimeCaller = { kind: "session", realtimeSessionId: "rt_sess_from_a_dead_call" };
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, stale, MANAGER, LIVE_SESSION).allowed).toBe(false);
    /* And with no live session at all, no session id can match. */
    expect(permitRealtimeAction(action, CALL_PEER, MANAGER, null).allowed).toBe(false);
  }
});

test("the designated manager may inject", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, MANAGER_CALLER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  }
});

test("the peer that established the call may inject: it holds this call's session id", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, CALL_PEER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  }
});

test("an unresolvable capability is refused rather than promoted to anything", () => {
  /* A wrong or stale token is exactly what an impostor presents. */
  const unknown: RealtimeCaller = { kind: "conversation", conversationId: "" };
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, unknown, MANAGER, LIVE_SESSION).allowed).toBe(false);
  }
});

test("with no manager designated, no agent may inject at all", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, MANAGER_CALLER, null, LIVE_SESSION).allowed).toBe(false);
    expect(permitRealtimeAction(action, WORKER, null, LIVE_SESSION).allowed).toBe(false);
  }
  /* The call's own peer is unaffected: its authority comes from the session, not
     from any designation. */
  expect(permitRealtimeAction("appendSpeech", CALL_PEER, null, LIVE_SESSION).allowed).toBe(true);
});

test("the non-injecting actions stay open to whoever owns the transport", () => {
  /* `start`/`stop` establish and tear down the operator's own WebRTC leg and
     `status` explains a dead transport. None writes into the conversation, and
     gating them would break the operator's own call before it has a session id to
     present. */
  for (const action of ["start", "stop", "status"]) {
    expect(permitRealtimeAction(action, ANONYMOUS, MANAGER, LIVE_SESSION).allowed).toBe(true);
    expect(permitRealtimeAction(action, WORKER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  }
});

test("an unknown or absent action is not an injection and is left to the executor", () => {
  expect(permitRealtimeAction("nonsense", WORKER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  expect(permitRealtimeAction(undefined, WORKER, MANAGER, LIVE_SESSION).allowed).toBe(true);
});
