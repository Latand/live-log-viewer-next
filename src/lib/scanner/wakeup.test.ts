import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "../types";
import { pendingWakeupFor } from "./wakeup";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakeup-test-"));
afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

const TS = "2026-07-07T10:09:45.030Z";


function entry(records: unknown[], root: FileEntry["root"] = "claude-projects"): FileEntry {
  const pathname = path.join(SANDBOX, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(pathname, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stat = fs.statSync(pathname);
  return {
    path: pathname, root, name: path.basename(pathname), project: "proj", title: "session",
    engine: root === "codex-sessions" ? "codex" : "claude", kind: "session",
    fmt: root === "codex-sessions" ? "codex" : "claude", parent: null,
    mtime: stat.mtimeMs / 1000, size: stat.size, activity: "idle", proc: null,
    pid: null, model: null, pendingQuestion: null, waitingInput: null,
  };
}

const wakeupRecord = (id: string, input: Record<string, unknown>, timestamp = TS) => ({
  type: "assistant", timestamp, message: { content: [{ type: "tool_use", id, name: "ScheduleWakeup", input }] },
});

describe("pendingWakeupFor", () => {
  test("surfaces a wakeup whose fire time is still ahead", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "Fallback poll", prompt: "p" })]);
    expect(pendingWakeupFor(e, now)).toEqual({ fireAt: Date.parse(TS) + 1200 * 1000, reason: "Fallback poll" });
  });

  test("returns null once the wakeup has fired", () => {
    const now = Date.parse(TS) + 2000 * 1000;
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "r", prompt: "p" })]);
    expect(pendingWakeupFor(e, now)).toBeNull();
  });

  test("uses the newest wakeup when several were scheduled", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([
      wakeupRecord("w1", { delaySeconds: 300, reason: "first", prompt: "p" }, TS),
      wakeupRecord("w2", { delaySeconds: 3600, reason: "second", prompt: "p" }, "2026-07-07T10:12:00.000Z"),
    ]);
    const pending = pendingWakeupFor(e, now);
    expect(pending?.reason).toBe("second");
    expect(pending?.fireAt).toBe(Date.parse("2026-07-07T10:12:00.000Z") + 3600 * 1000);
  });

  test("recovers the fire time from the tool result when the input lacks a delay", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([
      wakeupRecord("w1", { reason: "r", prompt: "p" }, TS),
      {
        type: "user", timestamp: TS,
        message: { content: [{ type: "tool_result", tool_use_id: "w1", content: [{ type: "text", text: "Next wakeup scheduled for 13:30:00 (in 1215s)." }] }] },
      },
    ]);
    expect(pendingWakeupFor(e, now)?.fireAt).toBe(Date.parse(TS) + 1215 * 1000);
  });

  test("skips a rejected newest wakeup and keeps the prior successful one", () => {
    const now = Date.parse(TS) + 60_000;
    const good = "2026-07-07T10:05:00.000Z";
    const bad = "2026-07-07T10:12:00.000Z";
    const e = entry([
      wakeupRecord("w1", { delaySeconds: 3600, reason: "valid", prompt: "p" }, good),
      { type: "user", timestamp: good, message: { content: [{ type: "tool_result", tool_use_id: "w1", content: [{ type: "text", text: "Next wakeup scheduled for 13:05:00 (in 3600s)." }] }] } },
      wakeupRecord("w2", { delaySeconds: 900, reason: "rejected", prompt: "p" }, bad),
      { type: "user", timestamp: bad, message: { content: [{ type: "tool_result", tool_use_id: "w2", is_error: true, content: [{ type: "text", text: "delaySeconds must be between 60 and 3600" }] }] } },
    ]);
    const pending = pendingWakeupFor(e, now);
    expect(pending?.reason).toBe("valid");
    expect(pending?.fireAt).toBe(Date.parse(good) + 3600 * 1000);
  });

  test("returns null when the only wakeup was rejected", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([
      wakeupRecord("w1", { delaySeconds: 1200, reason: "r", prompt: "p" }, TS),
      { type: "user", timestamp: TS, message: { content: [{ type: "tool_result", tool_use_id: "w1", is_error: true, content: [{ type: "text", text: "rejected" }] }] } },
    ]);
    expect(pendingWakeupFor(e, now)).toBeNull();
  });

  test("selects the newest call when one record carries several", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([
      {
        type: "assistant", timestamp: TS,
        message: {
          content: [
            { type: "tool_use", id: "a", name: "ScheduleWakeup", input: { delaySeconds: 300, reason: "earlier", prompt: "p" } },
            { type: "tool_use", id: "b", name: "ScheduleWakeup", input: { delaySeconds: 3600, reason: "later", prompt: "p" } },
          ],
        },
      },
    ]);
    const pending = pendingWakeupFor(e, now);
    expect(pending?.reason).toBe("later");
    expect(pending?.fireAt).toBe(Date.parse(TS) + 3600 * 1000);
  });

  test("bounds the surfaced reason to a safe length", () => {
    const now = Date.parse(TS) + 60_000;
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "x".repeat(5000), prompt: "p" })]);
    const pending = pendingWakeupFor(e, now);
    expect(pending?.reason.length).toBeLessThanOrEqual(300);
  });

  test("a cached pending wakeup expires against the clock without a size change", () => {
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "r", prompt: "p" })]);
    // First scan while the wakeup is ahead caches it under the file size.
    expect(pendingWakeupFor(e, Date.parse(TS) + 60_000)).not.toBeNull();
    // A later scan of the same (unchanged) file, now past the fire time, hits the
    // cache but must re-validate and surface nothing.
    expect(pendingWakeupFor(e, Date.parse(TS) + 2000 * 1000)).toBeNull();
  });

  test("ignores non-claude transcripts", () => {
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "r", prompt: "p" })], "codex-sessions");
    expect(pendingWakeupFor(e, Date.parse(TS) + 60_000)).toBeNull();
  });
});
