import { describe, expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import {
  CONFIRM_ATTENTION_MS,
  SLOW_BOOT_MS,
  type SpawnAttempt,
  applySpawnOutcome,
  classifySpawnResponse,
  classifyTransportLoss,
  createSpawnAttempt,
  displayPhase,
  hasRecoverableRequest,
  matchSpawnedFile,
  sendEnabled,
  spawnRequestBody,
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
  request: {
    engine: "codex",
    model: "gpt-5.6",
    cwd: "/repo",
    effort: "high",
    fast: false,
    accountId: "terra",
    prompt: "do the thing",
    images: [],
    src: "",
  },
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

  test("starting replay (202, launch reserved before pane) → confirming with send disabled", () => {
    const out = classifySpawnResponse(202, true, { ok: true, state: "starting", launched: false, path: null, launchId: "launch-1" });
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") expect(out.durable).toBe("confirming");
  });

  test("conflict 200 (launched: true) → confirming with uncertain worker ownership", () => {
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
    expect(matchSpawnedFile(attempt, files)?.path).toBe("/b.jsonl");
  });

  test("no exact path match yet → null (waits, does not grab a stranger)", () => {
    const files = [mkFile({ path: "/a.jsonl", mtime: 1 })];
    const attempt = { ...baseAttempt, path: "/b.jsonl" };
    expect(matchSpawnedFile(attempt, files)).toBeNull();
  });

  test("path-null confirming adopts by exact conversation id", () => {
    const files = [
      mkFile({ path: "/a.jsonl", conversationId: "conversation_other", mtime: 2_000_000_000 }),
      mkFile({ path: "/mine.jsonl", conversationId: "conversation_9", mtime: 2_000_000_000 }),
    ];
    const attempt = { ...baseAttempt, path: null, conversationId: "conversation_9" };
    expect(matchSpawnedFile(attempt, files)?.path).toBe("/mine.jsonl");
  });

  test("simultaneous same-cwd drafts do not adopt each other's fresh transcript", () => {
    const secondsAt = baseAttempt.at / 1000;
    const files = [
      mkFile({ path: "/other-draft.jsonl", mtime: secondsAt + 5, conversationId: "conversation_other" }),
    ];
    const attempt = { ...baseAttempt, path: null, conversationId: null };
    expect(matchSpawnedFile(attempt, files)).toBeNull();
  });

  test("a receipt path remains authoritative when another draft has the same cwd", () => {
    const files = [
      mkFile({ path: "/other-draft.jsonl", conversationId: "conversation_other" }),
      mkFile({ path: "/mine.jsonl", conversationId: "conversation_mine" }),
    ];
    expect(matchSpawnedFile({ ...baseAttempt, conversationId: "conversation_mine" }, files)?.path).toBe("/mine.jsonl");
  });
});

describe("durable request recovery", () => {
  test("reload during POST retains attempt id, launch timestamp, and exact attachment payload", () => {
    const attempt = createSpawnAttempt("attempt_reload_1", 2_000_000_000_123, {
      ...baseAttempt.request!,
      prompt: "inspect these",
      images: [{ base64: "aGVsbG8=", mime: "image/png" }],
    });
    expect(hasRecoverableRequest(attempt)).toBe(true);
    expect(spawnRequestBody(attempt)).toEqual({
      engine: "codex",
      model: "gpt-5.6",
      cwd: "/repo",
      effort: "high",
      fast: false,
      accountId: "terra",
      prompt: "inspect these",
      images: [{ base64: "aGVsbG8=", mime: "image/png" }],
      clientAttemptId: "attempt_reload_1",
    });
    expect(attempt.at).toBe(2_000_000_000_123);
  });

  test("transport loss re-POST uses the same id and exact original request", () => {
    const attempt = createSpawnAttempt("attempt_transport_1", 2_000_000_000_123, baseAttempt.request!);
    const before = spawnRequestBody(attempt);
    expect(classifyTransportLoss().kind).toBe("ambiguous");
    const replay = spawnRequestBody(attempt);
    expect(replay).toEqual(before);
    expect(replay.clientAttemptId).toBe("attempt_transport_1");
  });

  test("receipt replay enriches the persisted attempt without changing its recovery data", () => {
    const attempt = createSpawnAttempt("attempt_receipt_1", 2_000_000_000_123, baseAttempt.request!);
    const outcome = classifySpawnResponse(200, true, {
      ok: true,
      state: "settled",
      path: "/mine.jsonl",
      conversationId: "conversation_mine",
      launchId: "launch-mine",
      target: "agents:1.0",
    });
    if (outcome.kind !== "launched") throw new Error("expected receipt response");
    const settled = applySpawnOutcome(attempt, outcome);
    expect(settled).toMatchObject({ at: attempt.at, clientAttemptId: attempt.clientAttemptId, request: attempt.request, path: "/mine.jsonl", conversationId: "conversation_mine" });
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
