import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";

import { buildFeed } from "@/components/feed/parse";
import type { FileEntry } from "@/lib/types";

import {
  enqueueOutbox,
  publishTranscriptEchoes,
  readOutbox,
  rebindOutboxEchoText,
  resetOutboxForTests,
  updateOutbox,
  visibleOutbox,
  type TranscriptEchoObservation,
} from "./outbox";

/**
 * Echo recognition against the REAL transcript record shapes both engines
 * journal for a composer delivery (the delivered-bubble successor of the
 * #922/#933 class). The Codex fixture is a redacted production rollout: the
 * runtime wraps the operator's draft in the `<!-- llv:structured-user … -->`
 * marker (with a `ctx` attribute), and the feed parser must hand the outbox an
 * echo carrying the RAW draft so the delivered bubble retires when it lands.
 */

const dom = new Window();
Object.assign(globalThis, { window: dom, sessionStorage: dom.sessionStorage });

beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});

const codexFile = { path: "/tmp/x.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const claudeFile = { path: "/tmp/x.jsonl", engine: "claude", fmt: "claude", activity: "recent" } as FileEntry;

/** Exactly what LogFeed publishes: every rendered user row, under its
    generation and a stable row anchor. */
function userEchoObservations(file: FileEntry, lines: string[]): TranscriptEchoObservation[] {
  return buildFeed(file, lines, false, "")
    .items.flatMap((item, index) => {
      if (item.kind !== "user" || !("text" in item) || !item.text.trim()) return [];
      return [{ generation: file.path, id: `row:${index}:0`, text: item.text }];
    });
}

test("a Codex composer delivery echo (structured-user marker + ctx) retires the delivered bubble", () => {
  const lines = fs
    .readFileSync(path.join(import.meta.dir, "fixtures", "codex-composer-delivery.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  const observations = userEchoObservations(codexFile, lines);
  /* The parser strips the marker line: the echo carries the raw draft. */
  expect(observations.map((echo) => echo.text)).toEqual(["every minute or two"]);

  enqueueOutbox("conv", { id: "k1", text: "every minute or two", images: 0, at: 1_000 });
  updateOutbox("conv", "k1", { state: "delivered", settledAt: 1_500 });
  publishTranscriptEchoes("conv", observations);

  expect(readOutbox("conv")[0]?.retiredEchoId).toBeString();
  expect(visibleOutbox(readOutbox("conv"), new Map([["every minute or two", 1]]), 2_000)).toEqual([]);
});

test("a Claude structured-host user record retires the delivered bubble", () => {
  const lines = [JSON.stringify({
    type: "user",
    timestamp: "2026-08-06T13:44:25.320Z",
    message: { role: "user", content: [{ type: "text", text: "every minute or two" }] },
  })];
  const observations = userEchoObservations(claudeFile, lines);
  expect(observations.map((echo) => echo.text)).toEqual(["every minute or two"]);

  enqueueOutbox("conv", { id: "k1", text: "every minute or two", images: 0, at: 1_000 });
  updateOutbox("conv", "k1", { state: "delivered", settledAt: 1_500 });
  publishTranscriptEchoes("conv", observations);

  expect(readOutbox("conv")[0]?.retiredEchoId).toBeString();
});

test("a scaffolded dispatch re-binds the echo identity so the scaffolded echo retires the bubble", () => {
  const draft = "every minute or two";
  const scaffolded = `[viewer context]\nThe operator is looking at project-a.\n${draft}`;

  /* Without the re-bind the scaffolded transcript echo can never match the
     raw-draft identity — the delivered bubble would linger in the tail. */
  enqueueOutbox("conv", { id: "unbound", text: draft, images: 0, at: 1_000 });
  updateOutbox("conv", "unbound", { state: "delivered", settledAt: 1_500 });
  publishTranscriptEchoes("conv", [{ generation: "/tmp/x.jsonl", id: "row:0:0", text: scaffolded }]);
  expect(readOutbox("conv")[0]?.retiredEchoId).toBeUndefined();

  resetOutboxForTests();
  dom.sessionStorage.clear();

  enqueueOutbox("conv", { id: "bound", text: draft, images: 0, at: 1_000 });
  rebindOutboxEchoText("conv", "bound", scaffolded);
  updateOutbox("conv", "bound", { state: "delivered", settledAt: 1_500 });
  publishTranscriptEchoes("conv", [{ generation: "/tmp/x.jsonl", id: "row:0:0", text: scaffolded }]);

  const entry = readOutbox("conv")[0];
  /* The bubble still DISPLAYS the raw draft; only its echo identity re-bound. */
  expect(entry?.text).toBe(draft);
  expect(entry?.echoText).toBe(scaffolded);
  expect(entry?.retiredEchoId).toBeString();
});

test("re-binding recomputes the submission watermark against the composed key", () => {
  const scaffolded = "[bridge]\n\ngo";
  /* An identical scaffolded text already echoed once (an earlier delivery). */
  publishTranscriptEchoes("conv", [{ generation: "/tmp/x.jsonl", id: "row:0:0", text: scaffolded }]);

  enqueueOutbox("conv", { id: "k1", text: "go", images: 0, at: 1_000 });
  rebindOutboxEchoText("conv", "k1", scaffolded);
  /* The pre-existing echo belongs to the past — it must not retire the fresh
     bubble; only its OWN later echo does. */
  expect(readOutbox("conv")[0]?.retiredEchoId).toBeUndefined();

  publishTranscriptEchoes("conv", [{ generation: "/tmp/x.jsonl", id: "row:1:0", text: scaffolded }]);
  expect(readOutbox("conv")[0]?.retiredEchoId).toBeString();
});
