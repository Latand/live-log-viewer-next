import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

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
    origin: null,
  });
});

test("the digest form written before this field still decodes", () => {
  const legacy = `<!-- llv:structured-user sha256=${DIGEST} -->\nLook at that one.`;
  expect(decodeCodexStructuredUserText(legacy)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: DIGEST,
    selectedContext: null,
    origin: null,
  });
});

test("a delivery operation persists as a hashed recipient dedup identity (#1366)", () => {
  const operationId = "operation-recipient-dedup";
  const deliveryDedup = createHash("sha256").update(operationId).digest("hex");
  const decoded = decodeCodexStructuredUserText(
    encodeCodexStructuredUserText("Deliver once.", undefined, null, null, deliveryDedup),
  );
  expect(decoded).toMatchObject({
    text: "Deliver once.",
    structured: true,
    deliveryDedup,
  });
  expect(JSON.stringify(decoded)).not.toContain(operationId);
});

test("unstructured text is untouched", () => {
  expect(decodeCodexStructuredUserText("just words")).toEqual({
    text: "just words",
    structured: false,
    contentDigest: null,
    selectedContext: null,
    origin: null,
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
    origin: null,
  });
});

test("the reference and the content digest ride the same marker", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.", DIGEST, REFERENCE);
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: DIGEST,
    selectedContext: REFERENCE,
    origin: null,
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
    origin: null,
  });
});

test("the operator's own text is never mistaken for a marker", () => {
  const decoded = decodeCodexStructuredUserText(
    encodeCodexStructuredUserText("<!-- llv:structured-user ctx=zzz -->\nnot a marker", undefined, REFERENCE),
  );
  expect(decoded.text).toBe("<!-- llv:structured-user ctx=zzz -->\nnot a marker");
  expect(decoded.selectedContext).toEqual(REFERENCE);
});

/* #1117: authorship rides the same marker, so the feed can tell the operator's
   own words from an inter-agent relay without any join. */

test("an operator origin persists on the record and comes back typed", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.", undefined, null, { kind: "operator" });
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: null,
    selectedContext: null,
    origin: { kind: "operator" },
  });
});

test("an agent origin carries its sender role", () => {
  const encoded = encodeCodexStructuredUserText("Round 2 verdict: fix the tail.", undefined, null, { kind: "agent", role: "reviewer" });
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Round 2 verdict: fix the tail.",
    structured: true,
    contentDigest: null,
    selectedContext: null,
    origin: { kind: "agent", role: "reviewer" },
  });
});

test("origin, sender, digest and reference all ride one marker line", () => {
  const encoded = encodeCodexStructuredUserText("Look at that one.", DIGEST, REFERENCE, { kind: "agent", role: "orchestrator" });
  expect(encoded.split("\n")).toHaveLength(2);
  expect(decodeCodexStructuredUserText(encoded)).toEqual({
    text: "Look at that one.",
    structured: true,
    contentDigest: DIGEST,
    selectedContext: REFERENCE,
    origin: { kind: "agent", role: "orchestrator" },
  });
});

test("a corrupt origin or sender costs only that attribute, never the record", () => {
  const forgedOrigin = `<!-- llv:structured-user origin=root -->\nLook at that one.`;
  expect(decodeCodexStructuredUserText(forgedOrigin).origin).toBeNull();
  expect(decodeCodexStructuredUserText(forgedOrigin).structured).toBe(true);
  const overlongRole = `<!-- llv:structured-user origin=agent sender=${"r".repeat(80)} -->\nLook at that one.`;
  expect(decodeCodexStructuredUserText(overlongRole).origin).toEqual({ kind: "agent" });
});

test("an unsafe role is dropped at encode time, so the marker stays one line", () => {
  const encoded = encodeCodexStructuredUserText("hello", undefined, null, { kind: "agent", role: "bad role >" });
  expect(encoded.startsWith("<!-- llv:structured-user origin=agent -->\n")).toBe(true);
  expect(decodeCodexStructuredUserText(encoded).origin).toEqual({ kind: "agent" });
});
