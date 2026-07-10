import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  CONFIRM_ATTENTION_MS,
  SLOW_BOOT_MS,
  type SpawnAttempt,
  classifySpawnResponse,
  classifyTransportLoss,
  displayPhase,
  matchSpawnedFile,
  sendEnabled,
} from "./draftSpawn";

function mkFile(partial: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "codex-sessions",
    name: partial.path,
    project: "proj",
    title: "t",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1_000_000,
    size: 10,
    activity: "live",
    proc: "running",
    pid: 1,
    pendingQuestion: null,
    waitingInput: null,
    model: null,
    ...partial,
  };
}

const baseAttempt: SpawnAttempt = {
  clientAttemptId: "attempt-abc12345",
  at: 2_000_000_000_000, // ms
  target: "sess:1.0",
  path: null,
  conversationId: null,
  launchId: "launch-1",
  prompt: "do the thing",
  hasImages: false,
  engine: "codex",
  src: "",
  phase: "confirming",
};

describe("classifySpawnResponse — server → card outcome", () => {
  test("settled 200 with a known path → booting on that exact path", () => {
    const out = classifySpawnResponse(200, true, {
      ok: true,
      state: "settled",
      launched: true,
      path: "/x/rollout.jsonl",
      conversationId: "conversation_9",
      launchId: "launch-1",
      target: "sess:1.0",
    });
    expect(out).toEqual({
      kind: "launched",
      durable: "booting",
      target: "sess:1.0",
      path: "/x/rollout.jsonl",
      conversationId: "conversation_9",
      launchId: "launch-1",
    });
  });

  test("path-pending 200 (launched, path null) → confirming, carries identity for exact adoption", () => {
    const out = classifySpawnResponse(200, true, {
      ok: true,
      state: "path-pending",
      launched: true,
      path: null,
      conversationId: "conversation_9",
      launchId: "launch-1",
      target: "sess:2.0",
    });
    expect(out).toEqual({
      kind: "launched",
      durable: "confirming",
      target: "sess:2.0",
      path: null,
      conversationId: "conversation_9",
      launchId: "launch-1",
    });
  });

  test("starting replay (202, launched not yet a pane) → confirming, never re-enables send", () => {
    const out = classifySpawnResponse(202, true, { ok: true, state: "starting", launched: false, path: null, launchId: "launch-1" });
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") expect(out.durable).toBe("confirming");
  });

  test("conflict 200 (launched: true) → confirming, worker exists but is not cleanly ours", () => {
    const out = classifySpawnResponse(200, true, { ok: true, state: "conflict", launched: true, path: null, launchId: "launch-1", target: "sess:3.0" });
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") {
      expect(out.durable).toBe("confirming");
      expect(out.path).toBeNull();
    }
  });

  test("400 preflight → failed-preflight, retry safe, surfaces the reason", () => {
    const out = classifySpawnResponse(400, false, { error: "directory does not exist: /nope" });
    expect(out).toEqual({ kind: "failed-preflight", message: "directory does not exist: /nope" });
  });

  test("other 4xx (413 oversize image, 403 cross-origin) → failed-preflight", () => {
    expect(classifySpawnResponse(413, false, { error: "image too large" }).kind).toBe("failed-preflight");
    expect(classifySpawnResponse(403, false, { error: "cross-origin" }).kind).toBe("failed-preflight");
  });

  test("409 with retrySafe (original failed pre-launch) → failed-preflight", () => {
    expect(classifySpawnResponse(409, false, { error: "original spawn failed before launch", retrySafe: true }).kind).toBe("failed-preflight");
  });

  test("409 without retrySafe (conflicting attempt) → ambiguous, keeps the card frozen", () => {
    expect(classifySpawnResponse(409, false, { error: "spawn attempt conflicts with its original request" })).toEqual({ kind: "ambiguous" });
  });

  test("5xx / opaque → ambiguous (a proxy 5xx could land after launch)", () => {
    expect(classifySpawnResponse(500, false, { error: "boom" })).toEqual({ kind: "ambiguous" });
    expect(classifySpawnResponse(502, false, null)).toEqual({ kind: "ambiguous" });
  });

  test("transport loss → ambiguous", () => {
    expect(classifyTransportLoss()).toEqual({ kind: "ambiguous" });
  });
});

describe("matchSpawnedFile — adoption evidence, strongest first", () => {
  test("same-card adoption by exact settled path", () => {
    const files = [mkFile({ path: "/a.jsonl", mtime: 1 }), mkFile({ path: "/b.jsonl", mtime: 1 })];
    const attempt = { ...baseAttempt, path: "/b.jsonl" };
    expect(matchSpawnedFile(attempt, null, files)?.path).toBe("/b.jsonl");
  });

  test("no exact path match yet → null (waits, does not grab a stranger)", () => {
    const files = [mkFile({ path: "/a.jsonl", mtime: 1 })];
    const attempt = { ...baseAttempt, path: "/b.jsonl" };
    expect(matchSpawnedFile(attempt, null, files)).toBeNull();
  });

  test("path-null confirming adopts by exact conversation id", () => {
    const files = [
      mkFile({ path: "/a.jsonl", conversationId: "conversation_other", mtime: 2_000_000_000 }),
      mkFile({ path: "/mine.jsonl", conversationId: "conversation_9", mtime: 2_000_000_000 }),
    ];
    const attempt = { ...baseAttempt, path: null, conversationId: "conversation_9" };
    expect(matchSpawnedFile(attempt, null, files)?.path).toBe("/mine.jsonl");
  });

  test("codex slow-boot heuristic: first fresh root rollout after the launch moment, not already on disk", () => {
    const secondsAt = baseAttempt.at / 1000;
    const known = new Set(["/old.jsonl"]);
    const files = [
      mkFile({ path: "/old.jsonl", mtime: secondsAt + 5 }), // pre-existing → excluded by known-set
      mkFile({ path: "/fresh.jsonl", mtime: secondsAt + 5 }),
    ];
    const attempt = { ...baseAttempt, path: null, conversationId: null };
    expect(matchSpawnedFile(attempt, known, files)?.path).toBe("/fresh.jsonl");
  });

  test("duplicate/concurrent guard: a rollout older than the launch floor is never adopted", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [mkFile({ path: "/stale.jsonl", mtime: secondsAt - 120 })];
    const attempt = { ...baseAttempt, path: null, conversationId: null };
    expect(matchSpawnedFile(attempt, null, files)).toBeNull();
  });

  test("reload recovery: with the known-set gone, the mtime floor alone still matches", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [mkFile({ path: "/fresh.jsonl", mtime: secondsAt + 1 })];
    const attempt = { ...baseAttempt, path: null, conversationId: null };
    expect(matchSpawnedFile(attempt, null, files)?.path).toBe("/fresh.jsonl");
  });

  test("transport-loss claude launch adopts a fresh claude-projects transcript", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [mkFile({ path: "/c.jsonl", engine: "claude", root: "claude-projects", mtime: secondsAt + 1 })];
    const attempt = { ...baseAttempt, engine: "claude" as const, path: null, conversationId: null };
    expect(matchSpawnedFile(attempt, null, files)?.path).toBe("/c.jsonl");
  });

  test("a handoff spawn accepts a fresh rollout linked under its source parent", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [mkFile({ path: "/child.jsonl", parent: "/src.jsonl", mtime: secondsAt + 1 })];
    const attempt = { ...baseAttempt, path: null, conversationId: null, src: "/src.jsonl" };
    expect(matchSpawnedFile(attempt, null, files)?.path).toBe("/child.jsonl");
  });

  test("a handoff spawn ignores an unrelated fresh rollout under a different parent", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [mkFile({ path: "/other.jsonl", parent: "/elsewhere.jsonl", mtime: secondsAt + 1 })];
    const attempt = { ...baseAttempt, path: null, conversationId: null, src: "/src.jsonl" };
    expect(matchSpawnedFile(attempt, null, files)).toBeNull();
  });
});

describe("duplicate-prevention gate", () => {
  test("send is enabled only with no attempt (draft / failed-preflight)", () => {
    expect(sendEnabled(null)).toBe(true);
  });

  test("send stays disabled in every worker-may-exist phase", () => {
    for (const phase of ["booting", "confirming", "attention"] as const) {
      expect(sendEnabled({ ...baseAttempt, phase })).toBe(false);
    }
  });
});

describe("displayPhase", () => {
  test("no attempt: launching while the POST is in flight, else draft", () => {
    expect(displayPhase(null, false, false)).toBe("draft");
    expect(displayPhase(null, true, false)).toBe("launching");
  });

  test("booting gains the slow hint after the timer, without losing its durable phase", () => {
    expect(displayPhase({ phase: "booting" }, false, false)).toBe("booting");
    expect(displayPhase({ phase: "booting" }, false, true)).toBe("booting-slow");
  });

  test("confirming and attention render directly from the durable phase", () => {
    expect(displayPhase({ phase: "confirming" }, false, false)).toBe("confirming");
    expect(displayPhase({ phase: "attention" }, false, true)).toBe("attention");
  });
});

describe("bounded timing", () => {
  test("the confirming→attention bound and the slow-boot bound are both defined", () => {
    expect(SLOW_BOOT_MS).toBeGreaterThan(0);
    expect(CONFIRM_ATTENTION_MS).toBeGreaterThan(0);
  });
});
