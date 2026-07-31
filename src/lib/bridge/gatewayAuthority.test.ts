import { beforeEach, expect, test } from "bun:test";

import {
  authenticateBridgeGateway,
  BRIDGE_ROOT_PROJECTION_REBUILD_MS,
  resetBridgeRootProjectionForTests,
  setBridgeGatewaySourcesForTests,
  type BridgeGatewaySources,
} from "./gatewayAuthority";

/**
 * #845 — the authority is unchanged; what it COSTS is not.
 *
 * `rootConversationId` materialises the whole registry and walks every conversation.
 * At production shape that is roughly 4.7k conversations and 18.5k registry rows, and
 * the relay above asked for it every ten seconds per open call — forever, for a call
 * whose credential the gateway was refusing. These tests are about the bound: what a
 * poll costs when it succeeds, what a refusal costs when it does not, and that
 * neither one loosened who is allowed in.
 */

const ROOT = "conversation_root";
const SESSION = "rt_sess_gateway";

/** Counts whole-registry projections, and can be poisoned to prove one never runs. */
function sources(options: {
  root?: string | null;
  live?: (conversationId: string) => string | null;
  now?: () => number;
} = {}) {
  let poisoned = false;
  let rebuilds = 0;
  let root = options.root === undefined ? ROOT : options.root;
  const injected: BridgeGatewaySources = {
    rootConversationId: () => {
      rebuilds += 1;
      if (poisoned) throw new Error("whole-registry read on a path that must never take one");
      return root;
    },
    liveRealtimeSessionId: options.live ?? ((conversationId) => (conversationId === ROOT ? SESSION : null)),
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    injected,
    rebuilds: () => rebuilds,
    poison: () => { poisoned = true; },
    rollTo: (next: string | null) => { root = next; },
  };
}

beforeEach(() => {
  setBridgeGatewaySourcesForTests(null);
  resetBridgeRootProjectionForTests();
});

test("thirty minutes of successful polls rebuild the registry projection exactly once", () => {
  const registry = sources();
  /* Warm-up: the first caller is entitled to pay for the projection. */
  expect(authenticateBridgeGateway(SESSION, registry.injected)).toEqual({ ok: true, conversationId: ROOT });
  expect(registry.rebuilds()).toBe(1);

  /* Poisoned: any further whole-registry read is now a test failure rather than a
     number to reason about. */
  registry.poison();
  for (let poll = 0; poll < 180; poll += 1) {
    expect(authenticateBridgeGateway(SESSION, registry.injected)).toEqual({ ok: true, conversationId: ROOT });
  }
  expect(registry.rebuilds()).toBe(1);
});

test("a refused credential against a healthy root costs no registry read at any rate", () => {
  /* The storm, from the server's side: before #845 each of these rebuilt the whole
     registry, and the relay produced six a minute per open tab, forever. */
  const registry = sources();
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  registry.poison();

  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    expect(authenticateBridgeGateway("rt_sess_not_the_root", registry.injected).ok).toBe(false);
  }
  expect(registry.rebuilds()).toBe(1);
});

test("no credential is refused without reading anything at all", () => {
  const registry = sources();
  registry.poison();
  for (const presented of [null, undefined, "", "   "]) {
    expect(authenticateBridgeGateway(presented, registry.injected).ok).toBe(false);
  }
  expect(registry.rebuilds()).toBe(0);
});

test("no root fails closed, and repeated asking stays bounded", () => {
  let now = 0;
  const registry = sources({ root: null, now: () => now });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
  }
  /* One inside the window, however many callers arrive. */
  expect(registry.rebuilds()).toBe(1);

  now += BRIDGE_ROOT_PROJECTION_REBUILD_MS;
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
  expect(registry.rebuilds()).toBe(2);
});

test("a root with no live call refuses every credential", () => {
  const registry = sources({ live: () => null });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
  expect(authenticateBridgeGateway("anything", registry.injected).ok).toBe(false);
});

test("a rollover is adopted on the first poll of the successor, not one window later", () => {
  let now = 0;
  let live: Record<string, string | null> = { [ROOT]: SESSION };
  const registry = sources({
    now: () => now,
    live: (conversationId) => live[conversationId] ?? null,
  });
  expect(authenticateBridgeGateway(SESSION, registry.injected)).toEqual({ ok: true, conversationId: ROOT });

  /* Ten quiet minutes of healthy polling, costing nothing. */
  for (let poll = 0; poll < 60; poll += 1) {
    now += 10_000;
    expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  }
  expect(registry.rebuilds()).toBe(1);

  /* The root session rolls over: the previous call ends and a successor takes it. */
  const successor = "conversation_root_successor";
  const successorSession = "rt_sess_successor";
  live = { [successor]: successorSession };
  registry.rollTo(successor);

  /* The successor's very first poll is served, because a projected root with no live
     call is exactly the condition that spends the rebuild budget. */
  expect(authenticateBridgeGateway(successorSession, registry.injected))
    .toEqual({ ok: true, conversationId: successor });
  expect(registry.rebuilds()).toBe(2);

  /* And the predecessor's credential is dead the moment its call is. */
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
});

test("a stale projection can never authorise a credential its root does not hold", () => {
  /* The one thing the projection must not buy: authority for a caller who merely
     guesses. The presented id has to equal what the projected root's own live host
     holds right now, so a stale projection widens nothing. */
  const registry = sources();
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  registry.poison();
  for (const guess of ["rt_sess_gatewa", "rt_sess_gateway_", "RT_SESS_GATEWAY", "conversation_root"]) {
    expect(authenticateBridgeGateway(guess, registry.injected).ok).toBe(false);
  }
  /* Whitespace is trimmed, so the genuine credential still works either way. */
  expect(authenticateBridgeGateway(` ${SESSION} `, registry.injected).ok).toBe(true);
});

test("swapping the injected sources drops the projection built from the old ones", () => {
  const first = sources();
  setBridgeGatewaySourcesForTests(first.injected);
  expect(authenticateBridgeGateway(SESSION).ok).toBe(true);

  const second = sources({ root: "conversation_other", live: () => null });
  setBridgeGatewaySourcesForTests(second.injected);
  expect(authenticateBridgeGateway(SESSION).ok).toBe(false);
  setBridgeGatewaySourcesForTests(null);
});
