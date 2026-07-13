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

  test("ignores non-claude transcripts", () => {
    const e = entry([wakeupRecord("w1", { delaySeconds: 1200, reason: "r", prompt: "p" })], "codex-sessions");
    expect(pendingWakeupFor(e, Date.parse(TS) + 60_000)).toBeNull();
  });
});
