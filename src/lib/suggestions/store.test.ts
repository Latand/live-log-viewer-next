import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearReplySuggestions,
  readReplySuggestions,
  readReplySuggestionsFile,
  recordReplySuggestions,
  replySuggestionsFile,
  retireReplySuggestionsOnOperatorMessage,
} from "./store";
import {
  MAX_REPLY_SUGGESTIONS,
  REPLY_SUGGESTION_ADMISSION_CAPACITY,
  REPLY_SUGGESTION_CONVERSATION_CAPACITY,
  ReplySuggestionValidationError,
} from "./types";

/*
 * The durable half of #1202: one reply-draft set per conversation, replaced by
 * the next call and cleared the moment the operator sends. Modelled on the
 * attention record — schema version, revision, atomic write under the shared
 * file transaction — because the pills have to survive a page reload and a
 * viewer restart exactly like every other viewer-side record.
 */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-suggestions-"));
  process.env.LLV_STATE_DIR = sandbox;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const MANAGER = { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" } as const;

function record(conversationId: string, replies: { label: string; text: string }[], at = "2026-08-26T10:00:00.000Z") {
  return recordReplySuggestions({ conversationId, replies, origin: MANAGER, at: new Date(at) });
}

/**
 * Every write to the record blocked, at the shared file transaction's own
 * queue: the lock enqueues under a directory beside the record, and a plain
 * file in its place refuses the mkdir. Answers the path to unblock with.
 */
function blockWrites(): string {
  const queuePath = `${replySuggestionsFile()}.write-locks`;
  fs.rmSync(queuePath, { recursive: true, force: true });
  fs.writeFileSync(queuePath, "blocked", "utf8");
  return queuePath;
}

test("a recorded set is readable back for its conversation and nobody else's", () => {
  record("conversation_a", [{ label: "yes, do it", text: "Yes — go ahead with the merge." }]);

  const stored = readReplySuggestions("conversation_a");
  expect(stored?.replies).toEqual([{ label: "yes, do it", text: "Yes — go ahead with the merge." }]);
  expect(stored?.origin).toEqual(MANAGER);
  expect(stored?.at).toBe("2026-08-26T10:00:00.000Z");
  expect(readReplySuggestions("conversation_b")).toBeNull();
});

test("the newest set replaces the previous one for that conversation, and names what it replaced", () => {
  const first = record("conversation_a", [{ label: "yes", text: "Yes." }]);
  const second = record("conversation_a", [{ label: "hold", text: "Hold — explain the rollback first." }], "2026-08-26T10:05:00.000Z");

  expect(second.replaced).toBe(first.set.setId);
  expect(readReplySuggestions("conversation_a")?.replies).toEqual([{ label: "hold", text: "Hold — explain the rollback first." }]);
  /* Replacement, not accumulation: one set per conversation, ever. */
  expect(readReplySuggestionsFile().sets.filter((set) => set.conversationId === "conversation_a")).toHaveLength(1);
});

test("clearing removes the conversation's set and says whether there was one", () => {
  record("conversation_a", [{ label: "yes", text: "Yes." }]);

  expect(clearReplySuggestions("conversation_a")).toBe(true);
  expect(readReplySuggestions("conversation_a")).toBeNull();
  expect(clearReplySuggestions("conversation_a")).toBe(false);
});

test("the operator's message retires the set that was standing when they sent it, and no later one", () => {
  const sentAt = new Date("2026-08-26T10:02:00.000Z");
  record("conversation_a", [{ label: "yes", text: "Yes." }], "2026-08-26T10:00:00.000Z");

  expect(retireReplySuggestionsOnOperatorMessage("conversation_a", sentAt).cleared).toBe(true);
  expect(readReplySuggestions("conversation_a")).toBeNull();

  /* Offered while the send was in flight: it answers a question the operator
     has not read yet, so their message must not take it down — the delayed
     clear that used to arrive later and wipe the manager's newest offer. */
  const fresh = record("conversation_a", [{ label: "hold", text: "Hold." }], "2026-08-26T10:03:00.000Z");
  expect(retireReplySuggestionsOnOperatorMessage("conversation_a", sentAt).cleared).toBe(false);
  expect(readReplySuggestions("conversation_a")?.setId).toBe(fresh.set.setId);
  expect(clearReplySuggestions("conversation_a", { offeredAtOrBefore: new Date("2026-08-26T10:04:00.000Z") })).toBe(true);
  expect(readReplySuggestions("conversation_a")).toBeNull();
});

test("a message re-delivered under the key it already used clears against its FIRST admission", () => {
  const firstAdmission = new Date("2026-08-26T10:02:00.000Z");
  record("conversation_a", [{ label: "yes", text: "Yes." }], "2026-08-26T10:00:00.000Z");

  expect(retireReplySuggestionsOnOperatorMessage("conversation_a", firstAdmission, "client-message-7").cleared).toBe(true);

  /* The manager asked something else while the client was still retrying its
     delivery. The retry is the SAME message: it cannot have answered a
     question that did not exist when the operator pressed send. */
  const fresh = record("conversation_a", [{ label: "hold", text: "Hold." }], "2026-08-26T10:03:00.000Z");
  const replay = retireReplySuggestionsOnOperatorMessage(
    "conversation_a",
    new Date("2026-08-26T10:05:00.000Z"),
    "client-message-7",
  );

  expect(replay.cleared).toBe(false);
  expect(readReplySuggestions("conversation_a")?.setId).toBe(fresh.set.setId);
  /* One remembered admission for the key, not one per delivery. */
  expect(readReplySuggestionsFile().admissions.filter((entry) => entry.key === "client-message-7")).toHaveLength(1);

  /* A genuinely different message still retires what is standing. */
  expect(retireReplySuggestionsOnOperatorMessage(
    "conversation_a",
    new Date("2026-08-26T10:06:00.000Z"),
    "client-message-8",
  ).cleared).toBe(true);
  expect(readReplySuggestions("conversation_a")).toBeNull();
});

test("a message key is remembered even when the conversation had no drafts to retire", () => {
  /* The replay that must not clear a newer set is just as likely to follow a
     message that answered nothing — so the admission is recorded either way. */
  expect(retireReplySuggestionsOnOperatorMessage(
    "conversation_a",
    new Date("2026-08-26T10:00:00.000Z"),
    "client-message-9",
  ).cleared).toBe(false);

  const offered = record("conversation_a", [{ label: "hold", text: "Hold." }], "2026-08-26T10:01:00.000Z");
  expect(retireReplySuggestionsOnOperatorMessage(
    "conversation_a",
    new Date("2026-08-26T10:02:00.000Z"),
    "client-message-9",
  ).cleared).toBe(false);
  expect(readReplySuggestions("conversation_a")?.setId).toBe(offered.set.setId);
});

test("only the recent message keys are kept: the record is a replay window, not a history", () => {
  for (let index = 0; index < REPLY_SUGGESTION_ADMISSION_CAPACITY + 5; index += 1) {
    retireReplySuggestionsOnOperatorMessage(
      "conversation_a",
      new Date(Date.UTC(2026, 7, 26, 10, 0, index)),
      `client-message-${index}`,
    );
  }

  expect(readReplySuggestionsFile().admissions).toHaveLength(REPLY_SUGGESTION_ADMISSION_CAPACITY);
});

test("a retirement that cannot be written hides the answered set and lands on the next read", () => {
  record("conversation_a", [{ label: "yes", text: "Yes." }], "2026-08-26T10:00:00.000Z");
  /* The shared file transaction queues under a directory beside the record; a
     file sitting in its place is a write the store cannot take — a busy lock,
     a full disk and a read-only state dir all arrive here the same way. */
  const queuePath = blockWrites();

  const retirement = retireReplySuggestionsOnOperatorMessage("conversation_a", new Date("2026-08-26T10:02:00.000Z"), "blocked-1");
  expect(retirement).toEqual({ cleared: false, pending: true });
  /* The operator's message landed and the drafts are gone from the surface
     that reads them, even though the record still holds the set. */
  expect(readReplySuggestions("conversation_a")).toBeNull();
  expect(readReplySuggestionsFile().sets).toHaveLength(1);

  fs.rmSync(queuePath);
  /* The retry rides the next read: the record catches up without anyone
     sending a second message. */
  expect(readReplySuggestions("conversation_a")).toBeNull();
  expect(readReplySuggestionsFile().sets).toHaveLength(0);
});

test("a set offered after a retirement the record could not write is still shown", () => {
  record("conversation_a", [{ label: "yes", text: "Yes." }], "2026-08-26T10:00:00.000Z");
  const queuePath = blockWrites();
  expect(retireReplySuggestionsOnOperatorMessage("conversation_a", new Date("2026-08-26T10:02:00.000Z"), "blocked-2").pending).toBe(true);
  fs.rmSync(queuePath);

  /* Held retirements answer one question, not the conversation: the manager's
     next offer is not covered by them. */
  const fresh = record("conversation_a", [{ label: "hold", text: "Hold." }], "2026-08-26T10:03:00.000Z");
  expect(readReplySuggestions("conversation_a")?.setId).toBe(fresh.set.setId);
});

test("retiring is quiet about a conversation with nothing to retire", () => {
  expect(retireReplySuggestionsOnOperatorMessage("conversation_quiet", new Date()).cleared).toBe(false);
  expect(retireReplySuggestionsOnOperatorMessage("", new Date())).toEqual({ cleared: false, pending: false });
});

test("the record survives on disk under the state dir", () => {
  record("conversation_a", [{ label: "yes", text: "Yes." }]);

  const onDisk = JSON.parse(fs.readFileSync(replySuggestionsFile(), "utf8")) as { schemaVersion: number; revision: number; sets: unknown[] };
  expect(replySuggestionsFile().startsWith(sandbox)).toBe(true);
  expect(onDisk.schemaVersion).toBe(1);
  expect(onDisk.revision).toBe(1);
  expect(onDisk.sets).toHaveLength(1);
});

test("labels and texts are trimmed, bounded and secret-redacted before anything durable exists", () => {
  const stored = record("conversation_a", [{
    label: "  yes, do it  ",
    text: `  ship it with sk-ant-api03-${"a".repeat(40)}  `,
  }]).set;

  expect(stored.replies[0]!.label).toBe("yes, do it");
  expect(stored.replies[0]!.text.startsWith("ship it with")).toBe(true);
  expect(stored.replies[0]!.text).not.toContain("sk-ant-api03");
});

test("an empty, oversized or malformed set is refused with a named code and writes nothing", () => {
  for (const replies of [
    [],
    Array.from({ length: MAX_REPLY_SUGGESTIONS + 1 }, (_, index) => ({ label: `l${index}`, text: `t${index}` })),
    [{ label: "", text: "body" }],
    [{ label: "label", text: "   " }],
  ]) {
    expect(() => record("conversation_a", replies)).toThrow(ReplySuggestionValidationError);
  }
  expect(fs.existsSync(replySuggestionsFile())).toBe(false);
});

test("a label longer than the pill can carry is refused rather than silently truncated", () => {
  expect(() => record("conversation_a", [{ label: "x".repeat(200), text: "body" }])).toThrow(ReplySuggestionValidationError);
});

test("the oldest conversation falls away once the capacity is full", () => {
  for (let index = 0; index < REPLY_SUGGESTION_CONVERSATION_CAPACITY + 3; index += 1) {
    record(`conversation_${index}`, [{ label: "yes", text: "Yes." }], new Date(Date.UTC(2026, 7, 26, 10, index)).toISOString());
  }

  const file = readReplySuggestionsFile();
  expect(file.sets).toHaveLength(REPLY_SUGGESTION_CONVERSATION_CAPACITY);
  expect(readReplySuggestions("conversation_0")).toBeNull();
  expect(readReplySuggestions(`conversation_${REPLY_SUGGESTION_CONVERSATION_CAPACITY + 2}`)).not.toBeNull();
});

test("an unreadable record reads as no suggestions: disposable drafts never take a composer down", () => {
  fs.mkdirSync(path.dirname(replySuggestionsFile()), { recursive: true });
  fs.writeFileSync(replySuggestionsFile(), "{not json", "utf8");

  expect(readReplySuggestions("conversation_a")).toBeNull();
  /* And the next write recovers the file rather than inheriting the wreckage. */
  record("conversation_a", [{ label: "yes", text: "Yes." }]);
  expect(readReplySuggestions("conversation_a")?.replies).toHaveLength(1);
});
