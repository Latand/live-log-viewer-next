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
const OPERATOR: RealtimeCaller = { kind: "operator" };
const MANAGER_CALLER: RealtimeCaller = { kind: "conversation", conversationId: MANAGER };
const WORKER: RealtimeCaller = { kind: "conversation", conversationId: "conversation_builder" };

test("an ordinary worker cannot speak into the voice session, by any injecting action", () => {
  expect(REALTIME_INJECTION_ACTIONS.length).toBeGreaterThan(0);
  for (const action of REALTIME_INJECTION_ACTIONS) {
    const verdict = permitRealtimeAction(action, WORKER, MANAGER);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.status).toBe(403);
      expect(verdict.error).toContain("manager");
    }
  }
});

test("the designated manager may inject", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, MANAGER_CALLER, MANAGER).allowed).toBe(true);
  }
});

test("the operator's own browser may inject: it owns the call and the transcript", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, OPERATOR, MANAGER).allowed).toBe(true);
  }
});

test("an unresolvable capability is refused rather than promoted to the operator", () => {
  /* A wrong or stale token is exactly what an impostor presents. Reading it as
     "no capability, therefore the browser" would turn a bad token into full
     authority — strictly worse than presenting none. */
  const unknown: RealtimeCaller = { kind: "conversation", conversationId: "" };
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, unknown, MANAGER).allowed).toBe(false);
  }
});

test("with no manager designated, no agent may inject at all", () => {
  for (const action of REALTIME_INJECTION_ACTIONS) {
    expect(permitRealtimeAction(action, MANAGER_CALLER, null).allowed).toBe(false);
    expect(permitRealtimeAction(action, WORKER, null).allowed).toBe(false);
  }
  /* The operator is unaffected: their browser still owns its own call. */
  expect(permitRealtimeAction("appendSpeech", OPERATOR, null).allowed).toBe(true);
});

test("the non-injecting actions stay open to whoever owns the transport", () => {
  /* `start`/`stop` establish and tear down the operator's own WebRTC leg and
     `status` explains a dead transport. None writes into the conversation, and
     gating them would break the operator's own call. */
  for (const action of ["start", "stop", "status"]) {
    expect(permitRealtimeAction(action, WORKER, MANAGER).allowed).toBe(true);
    expect(permitRealtimeAction(action, OPERATOR, MANAGER).allowed).toBe(true);
  }
});

test("an unknown or absent action is not an injection and is left to the executor", () => {
  expect(permitRealtimeAction("nonsense", WORKER, MANAGER).allowed).toBe(true);
  expect(permitRealtimeAction(undefined, WORKER, MANAGER).allowed).toBe(true);
});
