import { describe, expect, test } from "bun:test";

import type { FileEntry, PendingQuestion, WaitingInput } from "@/lib/types";

import { attentionId, buildAttentionQueue, nextAttention, STALLED_ATTENTION_TTL } from "./attention";

const NOW = 1_800_000_000;

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function question(toolUseId: string, askedAt: number): PendingQuestion {
  return {
    kind: "question",
    toolUseId,
    transcriptPath: "/t",
    pid: 1,
    paneTarget: null,
    askedAt: new Date(askedAt * 1000).toISOString(),
  };
}

function waiting(since: number): WaitingInput {
  return { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null };
}

describe("attentionId", () => {
  test("precedence: question > rate limit > waiting > stalled > null", () => {
    const both = entry({
      path: "/q",
      activity: "stalled",
      pendingQuestion: question("toolu_1", NOW - 10),
      rateLimit: { source: "pane", accountId: null, window: null, resetAt: NOW + 60 },
      waitingInput: waiting(NOW - 20),
    });
    expect(attentionId(both, NOW)).toBe("toolu_1");
    const limited = entry({
      path: "/limited",
      activity: "stalled",
      rateLimit: { source: "pane", accountId: null, window: null, resetAt: NOW + 60 },
      waitingInput: waiting(NOW - 20),
    });
    expect(attentionId(limited, NOW)).toBe(`/limited:rate-limited:${NOW + 60}`);
    const wait = entry({ path: "/w", activity: "stalled", waitingInput: waiting(NOW - 20) });
    expect(attentionId(wait, NOW)).toBe(`/w:waiting:${NOW - 20}`);
    const stalled = entry({ path: "/s", activity: "stalled", proc: "running", mtime: NOW - 300 });
    expect(attentionId(stalled, NOW)).toBe(`/s:stalled:${NOW - 300}`);
    expect(attentionId(entry({ path: "/idle" }), NOW)).toBeNull();
    expect(attentionId(entry({ path: "/live", activity: "live" }), NOW)).toBeNull();
  });

  test("a rate-limited live conversation enters hard-blocked attention", () => {
    const limited = entry({
      path: "/limited",
      activity: "live",
      proc: "running",
      rateLimit: { source: "pane", accountId: "main", window: "session", resetAt: NOW + 900 },
    });

    expect(attentionId(limited, NOW)).toBe(`/limited:rate-limited:${NOW + 900}`);
    expect(buildAttentionQueue([limited], NOW)).toMatchObject([
      { file: { path: "/limited" }, tier: "blocked", since: limited.mtime },
    ]);
  });

  /* The toast seen-set and push-sent.json entries carry ids in the historical
     inline format; the shared helper must reproduce it byte for byte. */
  test("id strings are byte-identical to the historical inline derivation", () => {
    const q = entry({ path: "/a", pendingQuestion: question("toolu_abc", NOW) });
    expect(attentionId(q, NOW)).toBe(q.pendingQuestion!.toolUseId);
    const w = entry({ path: "/b", waitingInput: waiting(NOW - 33.7) });
    expect(attentionId(w, NOW)).toBe(`${w.path}:waiting:${Math.floor(w.waitingInput!.since)}`);
    const s = entry({ path: "/c", activity: "stalled", proc: "running", mtime: NOW - 400.9 });
    expect(attentionId(s, NOW)).toBe(`${s.path}:stalled:${Math.floor(s.mtime)}`);
  });

  test("stalled TTL boundary: in at 2h, out just past it", () => {
    const inside = entry({ path: "/in", activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL });
    expect(attentionId(inside, NOW)).toBe(`/in:stalled:${NOW - STALLED_ATTENTION_TTL}`);
    const outside = entry({ path: "/out", activity: "stalled", proc: "running", mtime: NOW - STALLED_ATTENTION_TTL - 1 });
    expect(attentionId(outside, NOW)).toBeNull();
  });

  test("a stalled session without a live process never counts as attention", () => {
    const abandoned = entry({ path: "/dead", activity: "stalled", proc: null });
    expect(attentionId(abandoned, NOW)).toBeNull();
    const exited = entry({ path: "/done", activity: "stalled", proc: "done" });
    expect(attentionId(exited, NOW)).toBeNull();
    const killed = entry({ path: "/killed", activity: "stalled", proc: "killed" });
    expect(attentionId(killed, NOW)).toBeNull();
  });

  test("a returned subagent never counts as stalled attention", () => {
    const returned = entry({ path: "/sub", activity: "stalled", kind: "subagent", proc: "done" });
    expect(attentionId(returned, NOW)).toBeNull();
    const running = entry({ path: "/sub2", activity: "stalled", kind: "subagent", proc: "running" });
    expect(attentionId(running, NOW)).toBe(`/sub2:stalled:${running.mtime}`);
  });
});

describe("buildAttentionQueue", () => {
  test("blocked segment precedes stalled regardless of since", () => {
    const files = [
      entry({ path: "/old-stall", activity: "stalled", proc: "running", mtime: NOW - 7000 }),
      entry({ path: "/fresh-q", pendingQuestion: question("toolu_q", NOW - 5) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.tier)).toEqual(["blocked", "stalled"]);
    expect(queue[0]!.file.path).toBe("/fresh-q");
  });

  test("FIFO inside a segment: oldest wait first", () => {
    const files = [
      entry({ path: "/newer", waitingInput: waiting(NOW - 10) }),
      entry({ path: "/oldest", pendingQuestion: question("toolu_o", NOW - 900) }),
      entry({ path: "/mid", waitingInput: waiting(NOW - 100) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.file.path)).toEqual(["/oldest", "/mid", "/newer"]);
  });

  test("id breaks ties on equal since", () => {
    const files = [
      entry({ path: "/b", waitingInput: waiting(NOW - 50) }),
      entry({ path: "/a", waitingInput: waiting(NOW - 50) }),
    ];
    const queue = buildAttentionQueue(files, NOW);
    expect(queue.map((item) => item.id)).toEqual([`/a:waiting:${NOW - 50}`, `/b:waiting:${NOW - 50}`]);
  });

  test("project filter narrows, omitting it keeps all projects", () => {
    const files = [
      entry({ path: "/p1", project: "alpha", waitingInput: waiting(NOW - 10) }),
      entry({ path: "/p2", project: "beta", waitingInput: waiting(NOW - 20) }),
    ];
    expect(buildAttentionQueue(files, NOW).length).toBe(2);
    const alpha = buildAttentionQueue(files, NOW, "alpha");
    expect(alpha.map((item) => item.file.path)).toEqual(["/p1"]);
    expect(alpha[0]!.project).toBe("alpha");
  });

  test("since sources: askedAt for questions, since for waiting, mtime for stalled", () => {
    const files = [
      entry({ path: "/q", pendingQuestion: question("toolu_s", NOW - 111) }),
      entry({ path: "/w", waitingInput: waiting(NOW - 222) }),
      entry({ path: "/s", activity: "stalled", proc: "running", mtime: NOW - 333 }),
    ];
    const bySince = new Map(buildAttentionQueue(files, NOW).map((item) => [item.file.path, item.since]));
    expect(bySince.get("/q")).toBe(NOW - 111);
    expect(bySince.get("/w")).toBe(NOW - 222);
    expect(bySince.get("/s")).toBe(NOW - 333);
  });
});

describe("nextAttention", () => {
  const queue = buildAttentionQueue(
    [
      entry({ path: "/1", waitingInput: waiting(NOW - 300) }),
      entry({ path: "/2", waitingInput: waiting(NOW - 200) }),
      entry({ path: "/3", waitingInput: waiting(NOW - 100) }),
    ],
    NOW,
  );
  const ids = queue.map((item) => item.id);

  test("cycles forward and wraps", () => {
    expect(nextAttention(queue, null, 1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, ids[0]!, 1)?.id).toBe(ids[1]);
    expect(nextAttention(queue, ids[2]!, 1)?.id).toBe(ids[0]);
  });

  test("cycles backward and wraps", () => {
    expect(nextAttention(queue, ids[0]!, -1)?.id).toBe(ids[2]);
    expect(nextAttention(queue, ids[1]!, -1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, null, -1)?.id).toBe(ids[2]);
  });

  test("vanished current id falls back to the next-oldest remaining item", () => {
    expect(nextAttention(queue, "gone:id", 1)?.id).toBe(ids[0]);
    expect(nextAttention(queue, "gone:id", -1)?.id).toBe(ids[2]);
  });

  test("empty queue yields null", () => {
    expect(nextAttention([], null, 1)).toBeNull();
    expect(nextAttention([], "toolu_x", -1)).toBeNull();
  });
});
