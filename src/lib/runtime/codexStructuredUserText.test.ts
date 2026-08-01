import { expect, test } from "bun:test";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "./codexStructuredUserText";

/**
 * The canonical structured-user record's marker line (#844 §persistence). The
 * selected-card reference is durable HERE — on the record the operator's turn
 * actually becomes — so it survives a restart, a replay and a re-parse of the
 * transcript, and the transcript row can render the same badge the composer did.
 *
 * The marker predates this field, so every older form must keep decoding
 * unchanged: a transcript written last month is not migrated, it is read.
 */

const DIGEST = "a".repeat(64);

const REFERENCE: SelectedContextRef = captureSelectedContext({
  context: { project: "atlas" },
  slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
  cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: "conversation_atlas_a", label: "Worker A" }],
  identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  revision: 2,
  now: Date.parse("2026-07-31T09:00:00.000Z"),
});

test("a plain structured record still round-trips with no reference", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.");
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: null,
    selectedContext: null,
  });
});

test("the digest form written before this field still decodes", () => {
  const legacy = `<!-- llv:structured-user sha256=${DIGEST} -->\nLook at that one.`;
  expect(decodeCodexStructuredUserText(legacy)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: DIGEST,
    selectedContext: null,
  });
});

test("unstructured text is untouched", () => {
  expect(decodeCodexStructuredUserText("just words")).toEqual({
    text: "just words",
    structured: false,
    contentDigest: null,
    selectedContext: null,
  });
});

test("the reference persists on the record and comes back typed", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.", undefined, REFERENCE);
  expect(encoded.split("\n")).toHaveLength(2);
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: null,
    selectedContext: REFERENCE,
  });
});

test("the reference and the content digest ride the same marker", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.", DIGEST, REFERENCE);
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: DIGEST,
    selectedContext: REFERENCE,
  });
});

test("an explicit empty selection persists as an answer, not as an absent field", () => {
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
    revision: 3,
    now: Date.parse("2026-07-31T09:00:00.000Z"),
  });
  const decoded = decodeCodexStructuredUserText(encodeCodexStructuredUserText("Anything running?", undefined, empty));
  expect(decoded.selectedContext).toEqual(empty);
  expect(decoded.selectedContext?.state).toBe("none");
});

test("a corrupt or forged reference decodes as absent and never breaks the record", () => {
  const corrupt = "<!-- llv:structured-user ctx=notbase64!!! -->\nLook at that one.";
  expect(decodeCodexStructuredUserText(corrupt)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: null,
    selectedContext: null,
  });
});

test("the operator's own text is never mistaken for a marker", () => {
  const decoded = decodeCodexStructuredUserText(
    encodeCodexStructuredUserText("<!-- llv:structured-user ctx=zzz -->\nnot a marker", undefined, REFERENCE),
  );
  expect(decoded.text).toBe("<!-- llv:structured-user ctx=zzz -->\nnot a marker");
  expect(decoded.selectedContext).toEqual(REFERENCE);
});
