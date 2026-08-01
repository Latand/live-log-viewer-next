import { expect, test } from "bun:test";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { SELECTED_CONTEXT_MAX_AGE_MS, bindSelectedContextToVoiceSession } from "./selectedContextBinding";

/**
 * #844 §4: a voice session resolves the selection of the view it was bound to,
 * and of no other. Two devices in the operator's house are two selections; a
 * reloaded tab is a different view session on the same device. Neither may be
 * silently substituted, so every non-match is a TYPED refusal rather than a
 * best-effort pick.
 */

const NOW = Date.parse("2026-07-31T09:00:00.000Z");
const BOUND = { viewSessionId: "vs-desk-1", deviceId: "dev-desk" };

function reference(overrides: Partial<{ viewSessionId: string; deviceId: string; at: number }> = {}): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
    identity: {
      viewSessionId: overrides.viewSessionId ?? BOUND.viewSessionId,
      deviceId: overrides.deviceId ?? BOUND.deviceId,
    },
    revision: 3,
    now: overrides.at ?? NOW,
  });
}

const bind = (reference: SelectedContextRef | null, binding = BOUND, now = NOW) =>
  bindSelectedContextToVoiceSession({ binding, reference, now });

test("a reference from the bound view resolves", () => {
  const ref = reference();
  expect(bind(ref)).toEqual({ ok: true, reference: ref });
});

test("an unbound session refuses with a typed missing-binding error", () => {
  const result = bindSelectedContextToVoiceSession({ binding: null, reference: reference(), now: NOW });
  expect(result).toEqual({
    ok: false,
    failure: { code: "unbound", message: expect.stringContaining("not bound") },
  });
});

test("an utterance carrying no reference refuses as missing, never as an empty selection", () => {
  const result = bind(null);
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("missing");
});

test("another DEVICE is ambiguous and is never selected implicitly", () => {
  const result = bind(reference({ deviceId: "dev-phone", viewSessionId: "vs-phone-1" }));
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("ambiguous");
});

test("another view session on the SAME device is stale — the tab reloaded", () => {
  const result = bind(reference({ viewSessionId: "vs-desk-2" }));
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("stale");
});

test("a reference with no view/device evidence cannot prove it came from the bound view", () => {
  const anonymous = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: null,
    revision: null,
    now: NOW,
  });
  const result = bind(anonymous);
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("missing");
});

test("a reference older than the binding window is stale", () => {
  const fresh = bind(reference({ at: NOW - SELECTED_CONTEXT_MAX_AGE_MS + 1_000 }));
  expect(fresh.ok).toBe(true);
  const aged = bind(reference({ at: NOW - SELECTED_CONTEXT_MAX_AGE_MS - 1 }));
  expect(aged.ok).toBe(false);
  expect(aged.ok === false && aged.failure.code).toBe("stale");
});

test("an explicit empty selection from the bound view resolves — it is an answer, not an absence", () => {
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: BOUND,
    revision: 4,
    now: NOW,
  });
  const result = bind(empty);
  expect(result).toEqual({ ok: true, reference: empty });
});
