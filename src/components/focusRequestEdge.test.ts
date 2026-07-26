import { expect, test } from "bun:test";

import { createFocusEdgeGate, type FocusRequestEdge } from "./focusRequestEdge";

/*
 * The one-shot contract for automatic focus (sticky-focus defect).
 *
 * The live failure: an explicit focus event moved the view, and then kept
 * moving it. `focusRequest` stayed set in state, the effect reading it also
 * depended on `files`/`pipelines`/`deckFlows` — all of which get fresh
 * identities on every scanner poll — so each poll re-armed the board's focus
 * channel and re-centred the camera, pulling the operator back from wherever
 * they had navigated by hand.
 *
 * These are the five facts the fix has to hold, driven through the gate the
 * dashboard effect actually calls.
 */

const edge = (path: string, nonce: number): FocusRequestEdge => ({ path, nonce });

/** One scanner poll: the effect re-runs because its data dependencies changed,
    with the request state completely untouched. */
function heartbeats(gate: ReturnType<typeof createFocusEdgeGate>, request: FocusRequestEdge, times: number): number {
  let applied = 0;
  for (let i = 0; i < times; i += 1) if (gate.consume(request)) applied += 1;
  return applied;
}

test("event A focuses once, and no amount of heartbeats, renders or refreshes refocuses it", () => {
  const gate = createFocusEdgeGate();
  const a = edge("/transcripts/a.jsonl", 1);

  expect(gate.consume(a)).toBe(true);
  /* Twenty polls' worth of re-runs. Before the fix every one of these re-armed
     the focus channel; the camera's own guard had expired by then, so every one
     of them was a fresh re-centre. */
  expect(heartbeats(gate, a, 20)).toBe(0);
  expect(gate.appliedNonce()).toBe(1);
});

test("a replayed, idempotent retry of event A does not refocus", () => {
  const gate = createFocusEdgeGate();
  const a = edge("/transcripts/a.jsonl", 7);
  expect(gate.consume(a)).toBe(true);

  /* A retried MCP call carrying the same clientRequestId replays the same
     receipt, so the surface is handed the same edge again. Same identity, so it
     has already happened — re-applying it would be a second unasked-for move. */
  expect(gate.consume(edge("/transcripts/a.jsonl", 7))).toBe(false);
  /* Even re-delivered after other work has run. */
  expect(heartbeats(gate, a, 5)).toBe(0);
});

test("manual navigation is never undone: the gate stays consumed while the operator moves", () => {
  const gate = createFocusEdgeGate();
  const a = edge("/transcripts/a.jsonl", 3);
  expect(gate.consume(a)).toBe(true);

  /* The operator pans, selects another card, opens a third. The request state is
     still sitting there — that is precisely the level signal that caused the
     defect — and the effect re-runs on each of those renders. */
  for (const _ of ["pan", "select", "open", "pan", "zoom"]) {
    expect(gate.consume(a)).toBe(false);
  }
  expect(gate.appliedNonce()).toBe(3);
});

test("a distinct event B focuses once of its own, and then is equally consumed", () => {
  const gate = createFocusEdgeGate();
  const a = edge("/transcripts/a.jsonl", 1);
  const b = edge("/transcripts/b.jsonl", 2);

  expect(gate.consume(a)).toBe(true);
  expect(heartbeats(gate, a, 3)).toBe(0);

  /* A new explicit event is the only thing that may move the view again. */
  expect(gate.consume(b)).toBe(true);
  expect(heartbeats(gate, b, 10)).toBe(0);
  expect(gate.appliedNonce()).toBe(2);
});

test("a repeat request for the SAME path is a new edge when it carries a new nonce", () => {
  /* The nonce, not the path, is the identity: asking twice for the same
     conversation is two events and legitimately moves the view twice. This is
     why the fix could not simply de-duplicate on path. */
  const gate = createFocusEdgeGate();
  expect(gate.consume(edge("/transcripts/a.jsonl", 1))).toBe(true);
  expect(gate.consume(edge("/transcripts/a.jsonl", 2))).toBe(true);
  expect(gate.consume(edge("/transcripts/a.jsonl", 2))).toBe(false);
});

test("no request is never an application, and nonce 0 is a real edge", () => {
  const gate = createFocusEdgeGate();
  expect(gate.consume(null)).toBe(false);
  expect(gate.appliedNonce()).toBeNull();
  /* A fresh mount's first edge can be nonce 0; a gate seeded with 0 rather than
     null would silently swallow it. */
  expect(gate.consume(edge("/transcripts/a.jsonl", 0))).toBe(true);
  expect(gate.consume(edge("/transcripts/a.jsonl", 0))).toBe(false);
});
