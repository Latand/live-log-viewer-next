import { expect, test } from "bun:test";

import {
  permitRealtimeAction,
  REALTIME_INJECTION_ACTIONS,
  REALTIME_TRANSPORT_ACTIONS,
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
      expect(verdict.error).toContain("bridge_report");
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

test("not even the designated manager may inject", () => {
  /* Allowing the manager reopened the hole one level up: manager authority is a
     designation, and whatever can obtain that designation would inherit the right to
     speak in the assistant's voice. The manager reports; the gateway speaks. */
  for (const action of REALTIME_INJECTION_ACTIONS) {
    const verdict = permitRealtimeAction(action, MANAGER_CALLER, MANAGER, LIVE_SESSION);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.error).toContain("bridge_report");
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

test("no conversation may inject, whatever the designation says", () => {
  /* Enumerated across the designation states, because the finding was precisely that
     the answer used to depend on one. */
  for (const manager of [MANAGER, null, "conversation_someone_else"]) {
    for (const action of REALTIME_INJECTION_ACTIONS) {
      expect(permitRealtimeAction(action, MANAGER_CALLER, manager, LIVE_SESSION).allowed).toBe(false);
      expect(permitRealtimeAction(action, WORKER, manager, LIVE_SESSION).allowed).toBe(false);
      expect(permitRealtimeAction(action, ANONYMOUS, manager, LIVE_SESSION).allowed).toBe(false);
    }
    /* And the call's own peer is unaffected by the designation entirely. */
    expect(permitRealtimeAction("appendSpeech", CALL_PEER, manager, LIVE_SESSION).allowed).toBe(true);
  }
});

test("an agent can neither open nor close the operator's call", () => {
  /* Not injection — no words reach the operator — but `stop` hangs up their call and
     `start` holds the host's single realtime slot so they cannot make one. */
  for (const action of REALTIME_TRANSPORT_ACTIONS) {
    for (const caller of [ANONYMOUS, WORKER, MANAGER_CALLER]) {
      const verdict = permitRealtimeAction(action, caller, MANAGER, LIVE_SESSION);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.status).toBe(403);
    }
  }
});

test("the operator opens and closes their own call", () => {
  for (const action of REALTIME_TRANSPORT_ACTIONS) {
    expect(permitRealtimeAction(action, ANONYMOUS, MANAGER, LIVE_SESSION, true).allowed).toBe(true);
  }
});

test("the peer that owns a call may hang it up, but may not open a new one", () => {
  /* Hanging up your own call is not an escalation. Starting one has no session to
     present yet, so it stays the operator's alone. */
  expect(permitRealtimeAction("stop", CALL_PEER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  expect(permitRealtimeAction("start", CALL_PEER, MANAGER, LIVE_SESSION).allowed).toBe(false);
  /* A stale session id hangs up nothing. */
  const stale: RealtimeCaller = { kind: "session", realtimeSessionId: "rt_sess_old" };
  expect(permitRealtimeAction("stop", stale, MANAGER, LIVE_SESSION).allowed).toBe(false);
});

test("status stays readable: it explains a dead transport and writes nothing", () => {
  for (const caller of [ANONYMOUS, WORKER, CALL_PEER]) {
    expect(permitRealtimeAction("status", caller, MANAGER, LIVE_SESSION).allowed).toBe(true);
  }
});

test("an unknown or absent action is not an injection and is left to the executor", () => {
  expect(permitRealtimeAction("nonsense", WORKER, MANAGER, LIVE_SESSION).allowed).toBe(true);
  expect(permitRealtimeAction(undefined, WORKER, MANAGER, LIVE_SESSION).allowed).toBe(true);
});
