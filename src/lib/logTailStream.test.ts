import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { readTailChunk } from "@/lib/logRead";
import { MAX_CHUNK, ROOTS } from "@/lib/scanner/roots";
import type { LogChunk } from "@/lib/types";

import { createLogTailEventStream, LogTailStreamSession, type LogTailStreamEvent } from "./logTailStream";

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
    /* A backlog of ordinary records: the stale subscriber sits on a record
       boundary and the bounded catch-up jumps it to the live window. */
    const line = "x".repeat(1023) + "\n";
    const prefix = line.repeat(Math.ceil((MAX_CHUNK + 128) / line.length));
    const tail = "y".repeat(MAX_CHUNK);
    const file = writeLog("stale-offset.log", prefix + tail);

    const chunk = await readTailChunk(file, line.length);

    expect(chunk).not.toBeNull();
    expect(chunk).toMatchObject({
      start: prefix.length,
      offset: prefix.length + tail.length,
      size: prefix.length + tail.length,
      data: tail,
    });
  });

  /* #1498: an agent reading a rendered frame appends one 800 KB record — larger
     than the live window — and the operator's feed lost it: the bounded
     catch-up jumped into the middle of the record and the partial line was
     dropped. A record is served from its first byte however long it is; the
     jump only ever skips whole records. */
  test("a record longer than the live window is served from its first byte, in sequence", async () => {
    const head = '{"seq":1}\n';
    const record = '{"frame":"' + "z".repeat(MAX_CHUNK + 4096) + '"}\n';
    const file = writeLog("oversized-record.log", head + record);

    const first = await readTailChunk(file, head.length);
    expect(first).toMatchObject({ start: head.length, offset: head.length + MAX_CHUNK, size: head.length + record.length });
    const second = await readTailChunk(file, first!.offset);
    expect(second).toMatchObject({ start: first!.offset, offset: head.length + record.length });
    expect(first!.data + second!.data).toBe(record);
  });

  test("a subscriber inside a record finishes that record before the bounded jump skips ahead", async () => {
    const one = '{"frame":1,"data":"' + "a".repeat(MAX_CHUNK + 2048) + '"}\n';
    const two = '{"frame":2,"data":"' + "b".repeat(MAX_CHUNK + 2048) + '"}\n';
    const file = writeLog("back-to-back-records.log", one + two);

    /* Holding the head of record one, the subscriber is handed its tail — and
       nothing past it, so the carried partial line stays whole. */
    const finish = await readTailChunk(file, MAX_CHUNK);
    expect(finish).toMatchObject({ start: MAX_CHUNK, offset: one.length, data: one.slice(MAX_CHUNK) });
    /* On the boundary, the next record is itself longer than the window: it is
       served from its first byte rather than jumped into. */
    const next = await readTailChunk(file, one.length);
    expect(next).toMatchObject({ start: one.length, offset: one.length + MAX_CHUNK, data: two.slice(0, MAX_CHUNK) });
  });

  test("a subscriber on a record boundary behind ordinary records still jumps to the live window", async () => {
    const line = '{"seq":0,"pad":"' + "p".repeat(1000) + '"}\n';
    const backlog = line.repeat(Math.ceil((2 * MAX_CHUNK) / line.length));
    const tail = '{"seq":1}\n';
    const file = writeLog("boundary-jump.log", backlog + tail);

    const chunk = await readTailChunk(file, line.length);
    expect(chunk).toMatchObject({ start: backlog.length + tail.length - MAX_CHUNK, offset: backlog.length + tail.length });
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
    let notifyGrowth: () => void = () => undefined;
    const session = new LogTailStreamSession([{ id: "log", path: file, offset: 4 }], {
      restatMs: 60_000,
      heartbeatMs: 60_000,
      watchFile: (_pathname, onChange) => {
        notifyGrowth = onChange;
        return { close: () => undefined };
      },
      onEvent: (event) => events.push(event),
    });
    try {
      session.start();
      await waitFor(() => events.length >= 1);
      fs.appendFileSync(file, "two\n");
      notifyGrowth();
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

  test("an unread event stream closes when a second chunk meets backpressure", async () => {
    const first = writeLog("backpressure-a.log", "first\n");
    const second = writeLog("backpressure-b.log", "second\n");
    const reader = createLogTailEventStream([
      { id: "a", path: first, offset: 0 },
      { id: "b", path: second, offset: 0 },
    ]).getReader();

    await Bun.sleep(20);
    const initial = await reader.read();
    const terminal = await reader.read();
    await reader.cancel();

    expect(initial.done).toBe(false);
    expect(new TextDecoder().decode(initial.value)).toContain('"id":"a"');
    expect(terminal.done).toBe(true);
  });
});
