import { afterAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  activityVerdict,
  primeTranscriptTurnEvidence,
  readStableTailRecords,
  recordTranscriptComposerRelease,
  tailRecords,
  transcriptTurnResult,
  turnStateFromRecords,
} from "./activity";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-activity-test-"));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const assistant = (stop: string | null, ...kinds: string[]) => ({
  type: "assistant",
  message: {
    stop_reason: stop,
    content: kinds.map((kind) => (kind === "text" ? { type: "text", text: "Now let me rewrite the file." } : { type: kind })),
  },
});

describe("turnStateFromRecords (claude)", () => {
  test("scanner activity keeps Claude end_turn compatibility", () => {
    const pathname = path.join(sandbox, "claude-end-turn.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "user", message: { content: "Ship" } }),
      JSON.stringify(assistant("end_turn", "text")),
      "",
    ].join("\n"));
    const stat = fs.statSync(pathname);

    expect(activityVerdict("claude-projects", pathname, stat.mtimeMs / 1000, stat.size)).toMatchObject({
      state: "recent",
      reason: "jsonl_turn_completed",
      complete: true,
    });
  });

  test("bounded projection churn preserves complete composer evidence", () => {
    const pathname = path.join(sandbox, "claude-composer-release.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "user", message: { content: "Ship" } }),
      JSON.stringify(assistant("tool_use", "tool_use")),
      "",
    ].join("\n"));
    const stat = fs.statSync(pathname);
    const unknown = { state: "unknown" as const, source: "empty" as const, terminalAt: null };
    const evidenceCacheCapacity = 4_096;
    for (let index = 0; index < evidenceCacheCapacity + 904; index += 1) {
      primeTranscriptTurnEvidence(`/cache-primer-${index}.jsonl`, 1, 1, false, unknown);
    }
    transcriptTurnResult(pathname, stat.size, stat.mtimeMs, false, false);
    recordTranscriptComposerRelease(pathname, stat.size, stat.mtimeMs, false);
    for (let index = 0; index < evidenceCacheCapacity - 2; index += 1) {
      primeTranscriptTurnEvidence(`/cache-churn-${index}.jsonl`, 1, 1, false, unknown);
    }
    expect(transcriptTurnResult(pathname, stat.size, stat.mtimeMs, false).composerReleased).toBe(true);
    primeTranscriptTurnEvidence("/cache-churn-final.jsonl", 1, 1, false, unknown);

    transcriptTurnResult(pathname, stat.size, stat.mtimeMs, false, false);

    expect(transcriptTurnResult(pathname, stat.size, stat.mtimeMs, false).composerReleased).toBe(true);
  });

  test("mid-turn narration — text record before its tool_use lands — keeps the turn open", () => {
    /* The exact window that mislabeled working subagents as «returned with
       result»: Claude appends the narration record first, then the tool_use. */
    const records = [{ type: "user" }, assistant(null, "thinking"), assistant(null, "text")];
    expect(turnStateFromRecords(records, false)).toBe("busy");
  });

  test("end_turn closes the turn", () => {
    const records = [{ type: "user" }, assistant("end_turn", "text")];
    expect(turnStateFromRecords(records, false)).toBe("done");
  });

  test("stop_sequence closes the turn", () => {
    expect(turnStateFromRecords([assistant("stop_sequence", "text")], false)).toBe("done");
  });

  test("tool_use stop_reason keeps the turn open", () => {
    expect(turnStateFromRecords([assistant("tool_use", "tool_use")], false)).toBe("busy");
  });

  test("trailing user record (tool result pending) keeps the turn open", () => {
    const records = [assistant("tool_use", "tool_use"), { type: "user" }];
    expect(turnStateFromRecords(records, false)).toBe("busy");
  });

  test("no assistant/user records yields no verdict", () => {
    expect(turnStateFromRecords([{ type: "summary" }], false)).toBeNull();
  });
});

describe("turnStateFromRecords (codex)", () => {
  const payload = (type: string, extra: Record<string, unknown> = {}) => ({ type: "event_msg", payload: { type, ...extra } });

  test("lifecycle events are authoritative", () => {
    expect(turnStateFromRecords([payload("task_started")], true)).toBe("busy");
    expect(turnStateFromRecords([payload("task_started"), payload("task_complete")], true)).toBe("done");
  });

  test("interim agent_message after tool activity falls back to done only without newer lifecycle", () => {
    const records = [payload("task_started"), payload("function_call"), payload("agent_message")];
    expect(turnStateFromRecords(records, true)).toBe("busy");
  });

  test("token_count and reasoning records are ignored", () => {
    const records = [payload("task_complete"), payload("token_count"), payload("reasoning")];
    expect(turnStateFromRecords(records, true)).toBe("done");
  });
});

describe("readStableTailRecords", () => {
  test("preserves a Codex terminal record aligned to the 128 KiB tail boundary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-aligned-codex-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const record = { timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } };
    const line = JSON.stringify(record);
    const tailBytes = 128 * 1024;
    fs.writeFileSync(transcript, `${JSON.stringify({ padding: "before-window" })}\n${line}${" ".repeat(tailBytes - line.length)}`);

    expect(await readStableTailRecords(transcript)).toEqual({ integrity: "complete", prefixTruncated: true, records: [record] });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("preserves a Claude terminal record aligned to the 128 KiB tail boundary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-aligned-claude-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const record = { type: "result", timestamp: "2026-07-15T10:00:00.000Z", subtype: "success" };
    const line = JSON.stringify(record);
    const tailBytes = 128 * 1024;
    fs.writeFileSync(transcript, `${JSON.stringify({ padding: "before-window" })}\n${line}${" ".repeat(tailBytes - line.length)}`);

    expect(await readStableTailRecords(transcript)).toEqual({ integrity: "complete", prefixTruncated: true, records: [record] });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("rejects corrupt and truncated JSONL rows", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-invalid-"));
    const corrupt = path.join(directory, "corrupt.jsonl");
    const truncated = path.join(directory, "truncated.jsonl");
    fs.writeFileSync(corrupt, '{"type":"result"}\nnot-json\n');
    fs.writeFileSync(truncated, '{"type":"result"}\n{"type":');

    expect(await readStableTailRecords(corrupt)).toEqual({ integrity: "uncertain", records: [] });
    expect(await readStableTailRecords(truncated)).toEqual({ integrity: "uncertain", records: [] });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("accepts a valid final JSON record without a trailing newline", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-final-record-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const record = { type: "result", subtype: "success" };
    fs.writeFileSync(transcript, JSON.stringify(record));

    expect(await readStableTailRecords(transcript)).toEqual({ integrity: "complete", prefixTruncated: false, records: [record] });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("discards only the first partial line created by a bounded tail seek", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-bounded-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const finalRecord = { type: "result", subtype: "success" };
    const finalLine = JSON.stringify(finalRecord);
    fs.writeFileSync(transcript, `${JSON.stringify({ padding: "x".repeat(256) })}\n${finalLine}`);

    expect(await readStableTailRecords(transcript, finalLine.length + 12)).toEqual({
      integrity: "complete",
      prefixTruncated: true,
      records: [finalRecord],
    });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("discards an incomplete UTF-8 character inside the bounded seek prefix", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-utf8-prefix-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const prefix = JSON.stringify({ padding: "😀".repeat(64) });
    const finalRecord = { type: "result", subtype: "success" };
    const content = Buffer.from(`${prefix}\n${JSON.stringify(finalRecord)}`);
    const seek = content.indexOf(Buffer.from("😀")) + 1;
    fs.writeFileSync(transcript, content);

    expect(await readStableTailRecords(transcript, content.length - seek)).toEqual({
      integrity: "complete",
      prefixTruncated: true,
      records: [finalRecord],
    });

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("reports missing and unreadable transcript paths as uncertain", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-unreadable-"));
    const missing = path.join(directory, "missing.jsonl");
    const unreadable = path.join(directory, "unreadable.jsonl");
    fs.writeFileSync(unreadable, '{"type":"result"}');
    fs.chmodSync(unreadable, 0o000);

    expect(await readStableTailRecords(missing)).toEqual({ integrity: "uncertain", records: [] });
    expect(await readStableTailRecords(unreadable)).toEqual({ integrity: "uncertain", records: [] });

    fs.chmodSync(unreadable, 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("bypasses size-keyed scanner cache entries after a same-size rewrite", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stable-tail-cache-"));
    const transcript = path.join(directory, "transcript.jsonl");
    const terminal = { payload: { type: "task_complete" } };
    const active = { payload: { type: "task_started_" } };
    const terminalText = JSON.stringify(terminal);
    const activeText = JSON.stringify(active);
    expect(activeText.length).toBe(terminalText.length);
    fs.writeFileSync(transcript, terminalText);
    const cachedMtimeMs = fs.statSync(transcript).mtimeMs;
    expect(tailRecords(transcript, terminalText.length, cachedMtimeMs)).toEqual([terminal]);
    fs.writeFileSync(transcript, activeText);

    expect(await readStableTailRecords(transcript)).toEqual({ integrity: "complete", prefixTruncated: false, records: [active] });
    expect(tailRecords(transcript, activeText.length, cachedMtimeMs)).toEqual([terminal]);

    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each(["replace", "truncate"] as const)(
    "reports a transcript %s during the bounded read as uncertain",
    async (mutation) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-stable-tail-${mutation}-`));
      const transcript = path.join(directory, "transcript.jsonl");
      const replacement = path.join(directory, "replacement.jsonl");
      fs.writeFileSync(transcript, '{"type":"result","subtype":"success"}');
      const realOpen = fs.promises.open.bind(fs.promises);
      const open = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const realRead = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await realRead(...readArgs);
          if (mutation === "replace") {
            fs.writeFileSync(replacement, '{"type":"user"}');
            fs.renameSync(replacement, transcript);
          } else {
            fs.truncateSync(transcript, 0);
          }
          return result;
        }) as typeof handle.read;
        return handle;
      });

      try {
        expect(await readStableTailRecords(transcript)).toEqual({ integrity: "uncertain", records: [] });
      } finally {
        open.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
