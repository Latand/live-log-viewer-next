import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { readTailChunk } from "@/lib/logRead";
import { MAX_CHUNK, ROOTS } from "@/lib/scanner/roots";
import type { LogChunk } from "@/lib/types";

import { LogTailStreamSession, type LogTailStreamEvent } from "./logTailStream";

fs.mkdirSync(ROOTS["codex-sessions"], { recursive: true });
const SANDBOX = fs.mkdtempSync(path.join(ROOTS["codex-sessions"], "llv-log-tail-stream-test-"));

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function writeLog(name: string, data: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, data);
  return pathname;
}

async function waitFor(check: () => boolean, timeoutMs = 2500): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await Bun.sleep(20);
  }
}

function asChunk(event: LogTailStreamEvent): LogChunk {
  if ("error" in event.chunk) throw new Error(event.chunk.error);
  return event.chunk;
}

describe("LogTailStreamSession", () => {
  test("a stale live offset skips an oversized backlog and resumes from the bounded tail", async () => {
    const prefix = "x".repeat(MAX_CHUNK + 128);
    const tail = "y".repeat(MAX_CHUNK);
    const file = writeLog("stale-offset.log", prefix + tail);

    const chunk = await readTailChunk(file, 1);

    expect(chunk).not.toBeNull();
    expect(chunk).toMatchObject({
      start: prefix.length,
      offset: prefix.length + tail.length,
      size: prefix.length + tail.length,
      data: tail,
    });
  });

  test("initial catch-up spends one connection byte budget and continues later", async () => {
    const first = writeLog("budget-a.log", "0123456789");
    const second = writeLog("budget-b.log", "abcde");
    const events: LogTailStreamEvent[] = [];
    const session = new LogTailStreamSession(
      [
        { id: "a", path: first, offset: 2 },
        { id: "b", path: second, offset: 0 },
      ],
      {
        batchBudget: 4,
        restatMs: 60_000,
        heartbeatMs: 60_000,
        catchUpDelayMs: 20,
        onEvent: (event) => events.push(event),
      },
    );
    try {
      session.start();
      await waitFor(() => events.length >= 2);
      expect(events[0].id).toBe("a");
      expect(asChunk(events[0])).toMatchObject({ start: 2, offset: 6, data: "2345" });
      expect(events[1].id).toBe("b");
      expect(asChunk(events[1])).toMatchObject({ start: 0, offset: 0, size: 5, data: "" });

      await waitFor(() => events.some((event) => event.id === "b" && !("error" in event.chunk) && event.chunk.data === "abcd"));
    } finally {
      session.close();
    }
  });

  test("file growth pushes the appended bytes", async () => {
    const file = writeLog("growth.log", "one\n");
    const events: LogTailStreamEvent[] = [];
    const session = new LogTailStreamSession([{ id: "log", path: file, offset: 4 }], {
      restatMs: 60_000,
      heartbeatMs: 60_000,
      onEvent: (event) => events.push(event),
    });
    try {
      session.start();
      await waitFor(() => events.length >= 1);
      fs.appendFileSync(file, "two\n");
      await waitFor(() => events.some((event) => event.id === "log" && !("error" in event.chunk) && event.chunk.data === "two\n"));
    } finally {
      session.close();
    }
  });

  test("file growth still arrives when native watching fails", async () => {
    const file = writeLog("watch-fails.log", "one\n");
    const events: LogTailStreamEvent[] = [];
    const session = new LogTailStreamSession([{ id: "log", path: file, offset: 4 }], {
      restatMs: 20,
      heartbeatMs: 60_000,
      watchFile: () => {
        throw new Error("watch unavailable");
      },
      onEvent: (event) => events.push(event),
    });
    try {
      session.start();
      await waitFor(() => events.length >= 1);
      fs.appendFileSync(file, "two\n");
      await waitFor(() => events.some((event) => event.id === "log" && !("error" in event.chunk) && event.chunk.data === "two\n"));
    } finally {
      session.close();
    }
  });

  test("a rejected read reports an error and keeps other subscribers moving", async () => {
    const events: LogTailStreamEvent[] = [];
    const session = new LogTailStreamSession(
      [
        { id: "bad", path: "bad.log", offset: 0 },
        { id: "ok", path: "ok.log", offset: 0 },
      ],
      {
        restatMs: 60_000,
        heartbeatMs: 60_000,
        readTailChunk: async (pathname) => {
          if (pathname === "bad.log") throw new Error("rotated during read");
          return { offset: 4, start: 0, size: 4, data: "ok\n" };
        },
        watchFile: () => ({
          close: () => undefined,
        }),
        onEvent: (event) => events.push(event),
      },
    );
    try {
      session.start();
      await waitFor(() => events.length >= 2);
      expect(events.find((event) => event.id === "bad")?.chunk).toEqual({ error: "failed to read log" });
      expect(events.find((event) => event.id === "ok")?.chunk).toMatchObject({ offset: 4, start: 0, size: 4, data: "ok\n" });
    } finally {
      session.close();
    }
  });

  test("teardown closes watchers and stops timers", async () => {
    const file = writeLog("teardown.log", "ready\n");
    let openCount = 0;
    let closeCount = 0;
    let comments = 0;
    const session = new LogTailStreamSession([{ id: "log", path: file, offset: 0 }], {
      restatMs: 60_000,
      heartbeatMs: 20,
      watchFile: () => {
        openCount += 1;
        return {
          close: () => {
            closeCount += 1;
          },
        };
      },
      onEvent: () => undefined,
      onComment: () => {
        comments += 1;
      },
    });
    session.start();
    await waitFor(() => openCount === 1);
    session.close();
    const commentsAtClose = comments;
    await Bun.sleep(80);
    expect(closeCount).toBe(1);
    expect(comments).toBe(commentsAtClose);
  });
});
