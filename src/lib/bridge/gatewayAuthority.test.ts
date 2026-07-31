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

test("five thousand refused attempts cost at most one registry read per window", () => {
  /* The storm, from the server's side: before #845 each of these rebuilt the whole
     registry, and the relay produced six a minute per open tab, forever. The bound has
     to hold against RATE — five thousand attempts inside one window is one read — and
     it has to keep holding as windows pass, which is what lets a mismatch still be the
     thing that adopts a successor. */
  let now = 0;
  const registry = sources({ now: () => now });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  expect(registry.rebuilds()).toBe(1);

  for (let window = 0; window < 6; window += 1) {
    const before = registry.rebuilds();
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      expect(authenticateBridgeGateway("rt_sess_not_the_root", registry.injected).ok).toBe(false);
    }
    expect(registry.rebuilds() - before).toBeLessThanOrEqual(1);
    now += BRIDGE_ROOT_PROJECTION_REBUILD_MS;
  }
  /* Thirty thousand refusals across six windows: at most one read each. */
  expect(registry.rebuilds()).toBeLessThanOrEqual(7);
});

test("a healthy root's own polls never spend the rebuild budget", () => {
  let now = 0;
  const registry = sources({ now: () => now });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  registry.poison();
  for (let poll = 0; poll < 180; poll += 1) {
    now += 10_000;
    expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
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

test("a handover while the predecessor's call is STILL LIVE promotes the successor", () => {
  /*
   * The blocker this closes. A handover does not have to end the predecessor's call:
   * B can be promoted while A is still on the line. The projection used to refuse for
   * free whenever the projected root had a live session, so it pinned A — A kept
   * reading the deploy nonces it was no longer entitled to, and B was refused for as
   * long as A stayed connected.
   */
  let now = 0;
  const live: Record<string, string | null> = { [ROOT]: SESSION };
  const registry = sources({ now: () => now, live: (conversationId) => live[conversationId] ?? null });
  expect(authenticateBridgeGateway(SESSION, registry.injected)).toEqual({ ok: true, conversationId: ROOT });

  /* Ten quiet minutes of healthy polling, costing nothing. */
  for (let poll = 0; poll < 60; poll += 1) {
    now += 10_000;
    expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  }
  expect(registry.rebuilds()).toBe(1);

  /* The handover. A's call stays UP — that is the whole point of this case. */
  const successor = "conversation_root_successor";
  const successorSession = "rt_sess_successor";
  live[successor] = successorSession;
  registry.rollTo(successor);

  /* The successor is served immediately: a healthy root never spends the budget, so
     the window is long expired by the time a handover happens. */
  expect(authenticateBridgeGateway(successorSession, registry.injected))
    .toEqual({ ok: true, conversationId: successor });
  expect(registry.rebuilds()).toBe(2);

  /* And the demoted predecessor is refused from that moment, though its call is still
     live and it still holds a valid session id for it. */
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
});

test("a successor is accepted within one window even when the budget was just spent", () => {
  let now = 0;
  const live: Record<string, string | null> = { [ROOT]: SESSION };
  const registry = sources({ now: () => now, live: (conversationId) => live[conversationId] ?? null });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);

  const successor = "conversation_root_successor";
  const successorSession = "rt_sess_successor";
  live[successor] = successorSession;
  registry.rollTo(successor);

  /* Immediately after the warm build, so the window is still closed. */
  now += 1_000;
  expect(authenticateBridgeGateway(successorSession, registry.injected).ok).toBe(false);
  /* Refused from the memo, without spending a read. */
  expect(registry.rebuilds()).toBe(1);

  /* One window later, and no later than that. */
  now += BRIDGE_ROOT_PROJECTION_REBUILD_MS;
  expect(authenticateBridgeGateway(successorSession, registry.injected))
    .toEqual({ ok: true, conversationId: successor });
  expect(registry.rebuilds()).toBe(2);
  /* The predecessor is refused within the same window, by the same re-derivation. */
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
});

test("a rollover that ends the predecessor's call is adopted the same way", () => {
  let now = 0;
  let live: Record<string, string | null> = { [ROOT]: SESSION };
  const registry = sources({ now: () => now, live: (conversationId) => live[conversationId] ?? null });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  now += 600_000;

  const successor = "conversation_root_successor";
  live = { [successor]: "rt_sess_successor" };
  registry.rollTo(successor);

  expect(authenticateBridgeGateway("rt_sess_successor", registry.injected))
    .toEqual({ ok: true, conversationId: successor });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(false);
});

test("a stale projection can never authorise a credential its root does not hold", () => {
  /* The one thing the projection must not buy: authority for a caller who merely
     guesses. The presented id has to equal what the projected root's own live host
     holds right now, so a stale projection widens nothing. */
  let now = 0;
  const registry = sources({ now: () => now });
  expect(authenticateBridgeGateway(SESSION, registry.injected).ok).toBe(true);
  registry.poison();
  /* Inside the window, so a mismatch is answered from the memo and the poisoned read
     is never reached — the refusal itself is what is under test. */
  for (const guess of ["rt_sess_gatewa", "rt_sess_gateway_", "RT_SESS_GATEWAY", "conversation_root"]) {
    expect(authenticateBridgeGateway(guess, registry.injected).ok).toBe(false);
  }
  now += 1_000;
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
