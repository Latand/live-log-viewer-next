import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, MigrationRevisionError, type ConversationObservation } from "@/lib/agent/registry";
import { boardFor, mutateBoard, setBoardFileForTests } from "@/lib/board/store";
import { tailRecordsResult } from "@/lib/scanner/activity";
import type { FileEntry } from "@/lib/types";

import { advanceConversationMigration, createMigrationIntent, drainHeldDeliveries, previewMigration, reconcileMigrationInventory, reconcileMigrations } from "./coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "./contracts";
import { CodexForkOutcomeUnknownError, SuccessorPendingError } from "./provider";

const roots: string[] = [];

function registry(): AgentRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-coordinator-"));
  roots.push(root);
  setBoardFileForTests(path.join(root, "board.json"));
  return new AgentRegistry(path.join(root, "registry.json"));
}

function observation(
  pathname: string,
  accountId: string | null,
  state: "idle" | "busy" | "terminal" | "unknown",
  role: "root" | "worker" = "worker",
  project = "repo",
): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo",
      model: "gpt-5.6-terra",
      effort: "high",
      fast: true,
      permissionMode: "never",
      title: `Title ${pathname}`,
      project,
      role,
      goal: { objective: "Ship", status: "active", tokensUsed: 12, timeUsedSeconds: 4 },
      plan: { steps: [{ text: "Implement", status: "in_progress" }], done: 0, total: 1, current: "Implement", updatedAt: "2026-07-10T12:00:00.000Z" },
    }),
    turn: { state, source: state === "terminal" ? "lifecycle" : "empty", terminalAt: state === "terminal" ? "2026-07-10T12:00:00.000Z" : null },
    observedAt: "2026-07-10T12:00:00.000Z",
  };
}

async function withIncompleteTailRead<T>(pathname: string, run: () => Promise<T>): Promise<T> {
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && typeof args[3] === "number" && args[3] > 0) {
      const error = new Error("inventory tail EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;
  try {
    return await run();
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }
}

async function withInterruptedTailRead<T>(
  pathname: string,
  mode: "eio" | "short",
  run: () => Promise<T>,
): Promise<T> {
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  const originalCloseSync = fs.closeSync;
  const targetFds = new Set<number>();
  fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
    if (path.resolve(String(target)) === pathname) targetFds.add(fd);
    return fd;
  }) as typeof fs.openSync;
  fs.readSync = ((fd: number, ...args: unknown[]) => {
    if (targetFds.has(fd) && typeof args[3] === "number" && args[3] > 0) {
      if (mode === "short") return 0;
      const error = new Error("provider fence tail EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }
    return Reflect.apply(originalReadSync, fs, [fd, ...args]);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    targetFds.delete(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;
  try {
    return await run();
  } finally {
    fs.openSync = originalOpenSync;
    fs.readSync = originalReadSync;
    fs.closeSync = originalCloseSync;
  }
}

function inventoryEntry(pathname: string, overrides: Partial<FileEntry> = {}): FileEntry {
  const stat = fs.statSync(pathname);
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: path.basename(pathname),
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: "recent",
    activityReason: "jsonl_turn_completed",
    derivationComplete: true,
    proc: null,
    pid: null,
    model: "gpt-5.6-sol",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function provider(
  paths: string[],
  counts = { create: 0, verify: 0 },
  continuityPaths: string[][] = [],
  virtualSource = true,
): SuccessorProviderPort {
  return {
    ...(virtualSource ? { virtualSource: true as const } : {}),
    async create(input) {
      counts.create += 1;
      const next = paths.shift() ?? `/successor-${counts.create}.jsonl`;
      const recordedPaths = continuityPaths.shift() ?? [];
      for (const pathname of recordedPaths) input.recordContinuityPath(pathname);
      return {
        operationId: input.operationId,
        nativeId: path.basename(next, ".jsonl"),
        path: next,
        continuityPaths: recordedPaths,
        historyHash: `hash-${counts.create}`,
        host: { kind: "codex-app-server", identity: `host-${counts.create}`, epoch: counts.create, verifiedAt: "2026-07-10T12:01:00.000Z" },
      };
    },
    async verify() { counts.verify += 1; },
  };
}

afterEach(() => {
  setBoardFileForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable account migration coordinator", () => {
  test("inventory builds path ownership from one registry snapshot", async () => {
    const store = registry();
    const firstPath = path.join(path.dirname(store.filename), "first.jsonl");
    const secondPath = path.join(path.dirname(store.filename), "second.jsonl");
    fs.writeFileSync(firstPath, JSON.stringify({ type: "event_msg", timestamp: "2026-07-11T00:00:00.000Z", payload: { type: "task_complete" } }) + "\n");
    fs.writeFileSync(secondPath, JSON.stringify({ type: "event_msg", timestamp: "2026-07-11T00:00:00.000Z", payload: { type: "task_complete" } }) + "\n");
    store.reconcileConversations([observation(firstPath, "default", "idle")]);
    let snapshotCalls = 0;
    const originalSnapshot = store.snapshot.bind(store);
    store.snapshot = (() => { snapshotCalls += 1; return originalSnapshot(); }) as typeof store.snapshot;
    store.conversationForPath = (() => { throw new Error("inventory must use its snapshot index"); }) as typeof store.conversationForPath;
    store.launchProfileForPath = (() => { throw new Error("inventory must use its snapshot index"); }) as typeof store.launchProfileForPath;
    const files = [firstPath, secondPath].map((pathname): FileEntry => ({
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: path.basename(pathname),
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: Date.now() / 1000,
      size: fs.statSync(pathname).size,
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    }));

    await reconcileMigrationInventory(store, files);

    expect(snapshotCalls).toBe(1);
  });

  test("an incomplete inventory tail read preserves a busy migration until same-identity recovery", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "incomplete-inventory-tail.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_complete" } }),
      "",
    ].join("\n"));
    store.reconcileConversations([observation(pathname, "a", "busy")]);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "incomplete-inventory-tail",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    expect(store.conversationForPath(pathname)?.migration?.phase).toBe("waiting-turn");

    const stat = fs.statSync(pathname);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Incomplete inventory tail",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "recent",
      proc: null,
      pid: null,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    const originalCloseSync = fs.closeSync;
    const targetFds = new Set<number>();
    fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
      if (path.resolve(String(target)) === pathname) targetFds.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, ...args: unknown[]) => {
      if (targetFds.has(fd) && typeof args[3] === "number" && args[3] > 0) {
        const error = new Error("inventory tail EIO") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return Reflect.apply(originalReadSync, fs, [fd, ...args]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      targetFds.delete(fd);
      return originalCloseSync(fd);
    }) as typeof fs.closeSync;
    const counts = { create: 0, verify: 0 };
    try {
      await reconcileMigrationInventory(store, [file]);
      expect(store.conversationForPath(pathname)?.turn.state).toBe("busy");
      await advanceConversationMigration(store.conversationForPath(pathname)!.id, store, provider(["/after-inventory-recovery.jsonl"], counts));
      expect(counts.create).toBe(0);
    } finally {
      fs.openSync = originalOpenSync;
      fs.readSync = originalReadSync;
      fs.closeSync = originalCloseSync;
    }

    await reconcileMigrationInventory(store, [file]);
    expect(store.conversationForPath(pathname)?.turn.state).toBe("terminal");
    await advanceConversationMigration(store.conversationForPath(pathname)!.id, store, provider(["/after-inventory-recovery.jsonl"], counts));
    expect(counts.create).toBe(1);
    expect(store.conversationForPath("/after-inventory-recovery.jsonl")?.migration?.phase).toBe("committed");
  });

  for (const priorState of ["idle", "terminal", "busy", "unknown"] as const) {
    test(`an incomplete busy tail is non-releasable after a durable ${priorState} observation`, async () => {
      const store = registry();
      const pathname = path.join(path.dirname(store.filename), `incomplete-current-busy-${priorState}.jsonl`);
      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
        "x".repeat(150_000),
        JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }),
        "",
      ].join("\n"));
      store.reconcileConversations([observation(pathname, "a", priorState)]);
      const conversation = store.conversationForPath(pathname)!;
      const intent = store.upsertMigrationIntent("codex", "b", "manual", `incomplete-current-busy-${priorState}`);
      store.setConversationMigration(conversation.id, {
        intentId: intent.id,
        phase: "waiting-turn",
        targetId: "b",
        revision: intent.revision,
        sourceGenerationId: conversation.generations[0]!.id,
        operationId: `incomplete-current-busy-${priorState}`,
        error: null,
        errorCode: null,
        providerReceipt: null,
        updatedAt: "2026-07-16T12:00:00.000Z",
      });
      const stat = fs.statSync(pathname);
      const file: FileEntry = {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "repo",
        title: `Current busy after ${priorState}`,
        engine: "codex",
        kind: "session",
        fmt: "codex",
        parent: null,
        mtime: stat.mtimeMs / 1000,
        size: stat.size,
        activity: "live",
        proc: "running",
        pid: process.pid,
        model: "gpt-5.6-sol",
        pendingQuestion: null,
        waitingInput: null,
      };
      const counts = { create: 0, verify: 0 };

      await withIncompleteTailRead(pathname, async () => {
        await reconcileMigrationInventory(store, [file]);
        expect(store.conversationForPath(pathname)?.turn.state).toBe(
          priorState === "busy" || priorState === "unknown" ? priorState : "unknown",
        );
        await advanceConversationMigration(conversation.id, store, provider([`/should-wait-${priorState}.jsonl`], counts));
        expect(counts.create).toBe(0);
        expect(store.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
      });

      await reconcileMigrationInventory(store, [file]);
      expect(store.conversationForPath(pathname)?.turn.state).toBe("busy");
      await advanceConversationMigration(conversation.id, store, provider([`/still-waiting-${priorState}.jsonl`], counts));
      expect(counts.create).toBe(0);
      expect(store.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
    });
  }

  test("an incomplete first observation stays unknown until same-identity recovery", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "incomplete-first-observation.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    const stat = fs.statSync(pathname);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Incomplete first observation",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "live",
      proc: "running",
      pid: process.pid,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };

    await withIncompleteTailRead(pathname, async () => {
      await reconcileMigrationInventory(store, [file]);
      expect(store.conversationForPath(pathname)?.turn.state).toBe("unknown");
    });
    await reconcileMigrationInventory(store, [file]);
    expect(store.conversationForPath(pathname)?.turn.state).toBe("busy");
  });

  test("a requested migration revalidates an uncertain turn before creating its successor", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "requested-turn-revalidation.jsonl");
    const started = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-16T12:00:00.000Z",
      payload: { type: "task_started" },
    }).padEnd(256);
    const completed = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-16T12:01:00.000Z",
      payload: { type: "task_complete" },
    }).padEnd(256);
    expect(started).toHaveLength(completed.length);
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      started,
      "",
    ].join("\n"));
    store.reconcileConversations([observation(pathname, "a", "idle")]);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "requested-turn-revalidation",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    const conversation = store.conversationForPath(pathname)!;
    const operationId = conversation.migration!.operationId;
    expect(conversation.migration?.phase).toBe("requested");
    const stat = fs.statSync(pathname);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Requested turn revalidation",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "live",
      activityReason: "jsonl_turn_open",
      proc: "running",
      pid: process.pid,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };
    const counts = { create: 0, verify: 0 };
    const successor = provider(["/requested-turn-successor.jsonl"], counts);

    await withIncompleteTailRead(pathname, async () => {
      await reconcileMigrationInventory(store, [file]);
      expect(store.conversation(conversation.id)).toMatchObject({
        turn: { state: "unknown" },
        migration: { phase: "requested", operationId },
      });
      await advanceConversationMigration(conversation.id, store, successor);
      expect(counts.create).toBe(0);
    });

    await reconcileMigrationInventory(store, [file]);
    expect(store.conversation(conversation.id)).toMatchObject({
      turn: { state: "busy" },
      migration: { phase: "requested", operationId },
    });
    await advanceConversationMigration(conversation.id, store, successor);
    expect(counts.create).toBe(0);

    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      completed,
      "",
    ].join("\n"));
    fs.utimesSync(pathname, stat.atime, new Date(stat.mtimeMs + 1_000));
    const completedStat = fs.statSync(pathname);
    file.size = completedStat.size;
    file.mtime = completedStat.mtimeMs / 1000;
    file.activity = "recent";
    file.activityReason = "jsonl_turn_completed";
    await reconcileMigrationInventory(store, [file]);
    await advanceConversationMigration(conversation.id, store, successor);
    await advanceConversationMigration(conversation.id, store, successor);

    expect(counts.create).toBe(1);
    expect(store.conversation(conversation.id)).toMatchObject({
      migration: { phase: "committed", operationId },
      generations: [{ path: pathname }, { path: "/requested-turn-successor.jsonl" }],
    });
  });

  for (const restoredPhase of ["preparing", "successor-starting"] as const) {
    test(`a restored ${restoredPhase} migration stays fenced through EIO and busy recovery`, async () => {
      const store = registry();
      const pathname = path.join(path.dirname(store.filename), `restored-${restoredPhase}-turn.jsonl`);
      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
        "x".repeat(150_000),
        JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }),
        "",
      ].join("\n"));
      store.reconcileConversations([observation(pathname, "a", "terminal")]);
      store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `restored-${restoredPhase}-turn`,
        expectedRevision: store.engineRouting("codex").revision,
        scope: "all",
      });
      let conversation = store.conversationForPath(pathname)!;
      conversation = store.transitionConversationMigration(
        conversation.id,
        conversation.migration!.revision,
        ["requested"],
        { phase: "preparing" },
      );
      if (restoredPhase === "successor-starting") {
        conversation = store.transitionConversationMigration(
          conversation.id,
          conversation.migration!.revision,
          ["preparing"],
          { phase: "successor-starting" },
        );
      }
      const operationId = conversation.migration!.operationId;
      const stat = fs.statSync(pathname);
      const file: FileEntry = {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "repo",
        title: `Restored ${restoredPhase} turn`,
        engine: "codex",
        kind: "session",
        fmt: "codex",
        parent: null,
        mtime: stat.mtimeMs / 1000,
        size: stat.size,
        activity: "live",
        activityReason: "jsonl_turn_open",
        derivationComplete: true,
        proc: "running",
        pid: process.pid,
        model: "gpt-5.6-sol",
        pendingQuestion: null,
        waitingInput: null,
      };
      const counts = { create: 0, verify: 0 };
      const successor = provider([`/restored-${restoredPhase}-successor.jsonl`], counts);

      await withIncompleteTailRead(pathname, async () => {
        await reconcileMigrationInventory(store, [file]);
        await advanceConversationMigration(conversation.id, store, successor);
        expect(store.conversation(conversation.id)).toMatchObject({
          turn: { state: "unknown" },
          migration: { phase: restoredPhase, operationId },
        });
        expect(counts.create).toBe(0);
      });

      await reconcileMigrationInventory(store, [file]);
      await advanceConversationMigration(conversation.id, store, successor);
      expect(store.conversation(conversation.id)).toMatchObject({
        turn: { state: "busy" },
        migration: { phase: restoredPhase, operationId },
      });
      expect(counts.create).toBe(0);
    });
  }

  for (const fence of [
    { name: "newly busy direct advance", phase: "requested", turn: "busy", route: "direct" },
    { name: "unknown direct retry", phase: "requested", turn: "unknown", route: "retry" },
    { name: "EIO fast reconciliation", phase: "preparing", turn: "terminal", route: "reconcile", interruption: "eio" },
    { name: "short-read restored advance", phase: "successor-starting", turn: "terminal", route: "direct", interruption: "short" },
  ] as const) {
    test(`provider creation fences a ${fence.name} at the current transcript identity`, async () => {
      const store = registry();
      const pathname = path.join(path.dirname(store.filename), `provider-fence-${fence.route}-${fence.phase}-${fence.turn}.jsonl`);
      const lifecycle = fence.turn === "busy"
        ? { type: "task_started" }
        : fence.turn === "terminal" ? { type: "task_complete" } : null;
      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
        "x".repeat(150_000),
        ...(lifecycle ? [JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: lifecycle })] : []),
        "",
      ].join("\n"));
      store.reconcileConversations([observation(pathname, "a", "idle")]);
      store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `provider-fence-${fence.route}-${fence.phase}-${fence.turn}`,
        expectedRevision: store.engineRouting("codex").revision,
        scope: "all",
      });
      let conversation = store.conversationForPath(pathname)!;
      if (fence.route === "retry") {
        conversation = store.transitionConversationMigration(
          conversation.id,
          conversation.migration!.revision,
          ["requested"],
          { phase: "failed-recoverable", error: "retryable provider failure", errorCode: "codex-fork-outcome-unknown" },
        );
        conversation = store.retryConversationMigration(conversation.id, conversation.migration!.revision);
      } else if (fence.phase === "preparing" || fence.phase === "successor-starting") {
        conversation = store.transitionConversationMigration(
          conversation.id,
          conversation.migration!.revision,
          ["requested"],
          { phase: "preparing" },
        );
        if (fence.phase === "successor-starting") {
          conversation = store.transitionConversationMigration(
            conversation.id,
            conversation.migration!.revision,
            ["preparing"],
            { phase: "successor-starting" },
          );
        }
      }
      const expected = {
        phase: conversation.migration!.phase,
        operationId: conversation.migration!.operationId,
        providerReceipt: conversation.migration!.providerReceipt,
      };
      const counts = { create: 0, verify: 0 };
      const successor = provider([`/provider-fence-${fence.route}-successor.jsonl`], counts);
      const advance = async () => {
        if (fence.route === "reconcile") {
          await reconcileMigrations(successor, { async deliver() { return "delivered"; } }, store);
        } else {
          await advanceConversationMigration(conversation.id, store, successor);
        }
      };

      if (fence.interruption) await withInterruptedTailRead(pathname, fence.interruption, advance);
      else await advance();

      expect(counts.create).toBe(0);
      expect(store.conversation(conversation.id)?.migration).toMatchObject(expected);
    });
  }

  for (const restoredPhase of ["requested", "preparing", "successor-starting"] as const) {
    test(`a missing production transcript fences provider creation in ${restoredPhase}`, async () => {
      const store = registry();
      const pathname = path.join(path.dirname(store.filename), `missing-provider-source-${restoredPhase}.jsonl`);
      store.reconcileConversations([observation(pathname, "a", "terminal")]);
      store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `missing-provider-source-${restoredPhase}`,
        expectedRevision: store.engineRouting("codex").revision,
        scope: "all",
      });
      let conversation = store.conversationForPath(pathname)!;
      if (restoredPhase === "preparing" || restoredPhase === "successor-starting") {
        conversation = store.transitionConversationMigration(
          conversation.id,
          conversation.migration!.revision,
          ["requested"],
          { phase: "preparing" },
        );
      }
      if (restoredPhase === "successor-starting") {
        conversation = store.transitionConversationMigration(
          conversation.id,
          conversation.migration!.revision,
          ["preparing"],
          { phase: "successor-starting" },
        );
      }
      const expectedOperationId = conversation.migration!.operationId;
      const counts = { create: 0, verify: 0 };
      const successor = provider([`/missing-provider-source-${restoredPhase}-successor.jsonl`], counts, [], false);

      await advanceConversationMigration(conversation.id, store, successor);

      expect(counts.create).toBe(0);
      expect(store.conversation(conversation.id)?.migration).toMatchObject({
        phase: restoredPhase,
        operationId: expectedOperationId,
        providerReceipt: null,
      });

      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_complete" } }),
        "",
      ].join("\n"));
      await advanceConversationMigration(conversation.id, store, successor);
      await advanceConversationMigration(conversation.id, store, successor);

      expect(counts.create).toBe(1);
      expect(store.conversation(conversation.id)?.migration).toMatchObject({
        phase: "committed",
        operationId: expectedOperationId,
      });
    });
  }

  test("provider creation rechecks transcript identity after phase transitions", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "provider-fence-transition-race.jsonl");
    const terminal = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-16T12:00:00.000Z",
      payload: { type: "task_complete" },
    }).padEnd(256);
    const busy = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-16T12:00:00.000Z",
      payload: { type: "task_started" },
    }).padEnd(256);
    expect(busy).toHaveLength(terminal.length);
    const transcript = (lifecycle: string) => [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      lifecycle,
      "",
    ].join("\n");
    fs.writeFileSync(pathname, transcript(terminal));
    store.reconcileConversations([observation(pathname, "a", "terminal")]);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "provider-fence-transition-race",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    const conversation = store.conversationForPath(pathname)!;
    const expected = {
      phase: conversation.migration!.phase,
      operationId: conversation.migration!.operationId,
      providerReceipt: conversation.migration!.providerReceipt,
    };
    const originalStat = fs.statSync(pathname);
    const originalTransition = store.transitionConversationMigration.bind(store);
    let identityChanged = false;
    store.transitionConversationMigration = ((...args: Parameters<AgentRegistry["transitionConversationMigration"]>) => {
      if (!identityChanged && args[2].includes("requested")) {
        identityChanged = true;
        fs.writeFileSync(pathname, transcript(busy));
        fs.utimesSync(pathname, originalStat.atime, new Date(originalStat.mtimeMs + 1_000));
        store.reconcileConversations([observation(pathname, "a", "busy")]);
      }
      return originalTransition(...args);
    }) as typeof store.transitionConversationMigration;
    const counts = { create: 0, verify: 0 };

    await advanceConversationMigration(
      conversation.id,
      store,
      provider(["/provider-fence-transition-race-successor.jsonl"], counts),
    );

    expect(identityChanged).toBe(true);
    expect(counts.create).toBe(0);
    expect(store.conversation(conversation.id)?.migration).toMatchObject(expected);
  });

  test("65 complete inventory turns stay warm, identity-aware, and caller-owned", async () => {
    const store = registry();
    const fixtureDir = path.join(path.dirname(store.filename), "warm-inventory-turns");
    fs.mkdirSync(fixtureDir, { recursive: true });
    const files: FileEntry[] = [];
    const terminal = JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_complete" } }).padEnd(128);
    const busy = JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }).padEnd(128);
    expect(busy).toHaveLength(terminal.length);
    for (let index = 0; index < 65; index += 1) {
      const pathname = path.join(fixtureDir, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/warm-inventory" } }),
        "x".repeat(150_000),
        terminal,
        "",
      ].join("\n"));
      files.push(inventoryEntry(pathname));
    }
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    const originalCloseSync = fs.closeSync;
    const targetFds = new Set<number>();
    let tailReads = 0;
    fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
      if (path.resolve(String(target)).startsWith(fixtureDir + path.sep)) targetFds.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, ...args: unknown[]) => {
      if (targetFds.has(fd) && typeof args[3] === "number" && args[3] > 0) tailReads += 1;
      return Reflect.apply(originalReadSync, fs, [fd, ...args]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      targetFds.delete(fd);
      return originalCloseSync(fd);
    }) as typeof fs.closeSync;
    try {
      await reconcileMigrationInventory(store, files);
      const cold = tailReads;
      await reconcileMigrationInventory(store, files);
      const warm = tailReads;
      const first = files[0]!;
      fs.writeFileSync(first.path, [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/warm-inventory" } }),
        "x".repeat(150_000),
        busy,
        "",
      ].join("\n"));
      fs.utimesSync(first.path, Date.now() / 1000, first.mtime + 1);
      Object.assign(first, inventoryEntry(first.path, { activity: "live", activityReason: "jsonl_turn_open" }));
      await reconcileMigrationInventory(store, files);
      const last = files.at(-1)!;
      const callerOwned = tailRecordsResult(last.path, last.size, last.mtime * 1000).records;
      callerOwned.reverse();
      const retained = tailRecordsResult(last.path, last.size, last.mtime * 1000).records;
      expect({ cold, warm, changed: tailReads }).toEqual({ cold: 65, warm: 65, changed: 66 });
      expect(store.conversationForPath(first.path)?.turn.state).toBe("busy");
      expect(retained.at(-1)).toMatchObject({ payload: { type: "task_complete" } });
    } finally {
      fs.openSync = originalOpenSync;
      fs.readSync = originalReadSync;
      fs.closeSync = originalCloseSync;
    }
  });

  test("migration metadata shares one bounded prefix across 65 identities and warm cycles", async () => {
    const store = registry();
    const fixtureDir = path.join(path.dirname(store.filename), "migration-head-prefixes");
    fs.mkdirSync(fixtureDir, { recursive: true });
    const files: FileEntry[] = [];
    for (let index = 0; index < 65; index += 1) {
      const pathname = path.join(fixtureDir, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      fs.writeFileSync(pathname, [
        JSON.stringify({ type: "session_meta", payload: { cwd: `/repo/prefix-${String(index).padStart(3, "0")}`, timestamp: "2026-07-16T12:00:00.000Z" } }),
        "x".repeat(150_000),
        JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:01:00.000Z", payload: { type: "task_complete" } }),
        "",
      ].join("\n"));
      files.push(inventoryEntry(pathname));
    }
    const originalOpenSync = fs.openSync;
    const originalReadSync = fs.readSync;
    const originalCloseSync = fs.closeSync;
    const targetFds = new Set<number>();
    let prefixReads = 0;
    fs.openSync = ((target: fs.PathLike, ...args: unknown[]) => {
      const fd = Reflect.apply(originalOpenSync, fs, [target, ...args]) as number;
      if (path.resolve(String(target)).startsWith(fixtureDir + path.sep)) targetFds.add(fd);
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = ((fd: number, ...args: unknown[]) => {
      if (targetFds.has(fd) && args[2] === 65_536 && args[3] === 0) prefixReads += 1;
      return Reflect.apply(originalReadSync, fs, [fd, ...args]);
    }) as typeof fs.readSync;
    fs.closeSync = ((fd: number) => {
      targetFds.delete(fd);
      return originalCloseSync(fd);
    }) as typeof fs.closeSync;
    try {
      await reconcileMigrationInventory(store, files);
      const cold = prefixReads;
      await reconcileMigrationInventory(store, files);
      const warm = prefixReads;
      const first = files[0]!;
      fs.utimesSync(first.path, Date.now() / 1000, first.mtime + 1);
      Object.assign(first, inventoryEntry(first.path));
      await reconcileMigrationInventory(store, files);
      expect({ cold, warm, changed: prefixReads }).toEqual({ cold: 65, warm: 65, changed: 66 });
    } finally {
      fs.openSync = originalOpenSync;
      fs.readSync = originalReadSync;
      fs.closeSync = originalCloseSync;
    }
  });

  test("a complete busy tail outranks an older incomplete mtime fallback", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "busy-after-incomplete-restart.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      "x".repeat(150_000),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    store.reconcileConversations([observation(pathname, "a", "idle")]);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "busy-after-incomplete-restart",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    const conversation = store.conversationForPath(pathname)!;
    const stat = fs.statSync(pathname);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Busy after incomplete restart",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "idle",
      activityReason: "mtime_old",
      derivationComplete: false,
      proc: null,
      pid: null,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };
    const counts = { create: 0, verify: 0 };

    await reconcileMigrationInventory(store, [file]);
    await advanceConversationMigration(conversation.id, store, provider(["/must-remain-fenced.jsonl"], counts));

    expect(store.conversation(conversation.id)).toMatchObject({
      turn: { state: "busy" },
      migration: { phase: "requested" },
    });
    expect(counts.create).toBe(0);
  });

  test("an explicit pane-at-composer verdict releases a complete busy tail", async () => {
    const store = registry();
    const pathname = path.join(path.dirname(store.filename), "pane-at-composer-release.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", model: "gpt-5.6-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-16T12:00:00.000Z", payload: { type: "task_started" } }),
      "",
    ].join("\n"));
    store.reconcileConversations([observation(pathname, "a", "busy")]);
    const stat = fs.statSync(pathname);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Pane at composer release",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "idle",
      activityReason: "pane_at_composer",
      derivationComplete: true,
      proc: "running",
      pid: process.pid,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };

    await reconcileMigrationInventory(store, [file]);

    expect(store.conversationForPath(pathname)?.turn.state).toBe("idle");
    const conversation = store.conversationForPath(pathname)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "pane-at-composer-provider-release",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    const counts = { create: 0, verify: 0 };
    const successor = provider(["/pane-at-composer-successor.jsonl"], counts);
    await advanceConversationMigration(conversation.id, store, successor);
    await advanceConversationMigration(conversation.id, store, successor);
    expect(counts.create).toBe(1);
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("committed");
  });

  test("a standard account switch migrates active conversations and defers inactive history", async () => {
    const store = registry();
    store.reconcileConversations([
      observation("/inactive-history.jsonl", "managed", "idle"),
      observation("/active-turn.jsonl", "managed", "busy"),
    ]);

    const preview = await previewMigration("codex", "default", store);
    expect(preview.counts).toEqual({ total: 2, idle: 0, busy: 1, deferred: 1, alreadyTarget: 0 });

    const result = await createMigrationIntent(
      "codex",
      "default",
      "manual",
      "active-scope-switch",
      preview.previewRevision,
      "active",
      store,
    );

    expect(result.intent.state).toBe("draining");
    expect(store.engineRouting("codex").activeAccountId).toBe("default");
    expect(store.conversationForPath("/active-turn.jsonl")?.migration).toMatchObject({ targetId: "default", phase: "waiting-turn" });
    expect(store.conversationForPath("/inactive-history.jsonl")?.migration).toBeNull();
  });

  test("automatic balance preserves an opt-out until a later manual selection", () => {
    const store = registry();
    store.reconcileConversations([observation("/opted-out-turn.jsonl", "managed", "busy")]);
    const first = store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "manual",
      requestId: "initial-manual-selection",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    store.setMigrationIntentState(first.id, "stopped", first.revision);

    const automatic = store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "auto",
      requestId: "later-automatic-selection",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    expect(automatic.state).toBe("complete");
    expect(store.conversationForPath("/opted-out-turn.jsonl")).toMatchObject({
      migration: { phase: "rolled-back" },
      migrationOptOut: { targetId: "default" },
    });

    store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "manual",
      requestId: "later-manual-selection",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    expect(store.conversationForPath("/opted-out-turn.jsonl")).toMatchObject({
      migration: { targetId: "default", phase: "waiting-turn" },
      migrationOptOut: null,
    });
  });

  test("lazy activation invalidates previews and advances a reactivated intent once", async () => {
    const store = registry();
    store.reconcileConversations([observation("/lazy-fence.jsonl", "a", "idle")]);
    const initialIntent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "route-to-b",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    expect(initialIntent).toMatchObject({ state: "complete", revision: 1 });
    const stalePreview = await previewMigration("codex", "default", store);
    const conversation = store.conversationForPath("/lazy-fence.jsonl")!;

    const activated = store.requestConversationMigrationToActiveAccount(conversation.id);
    const reactivatedIntent = store.snapshot().migrationIntents[initialIntent.id]!;
    expect(activated.migration).toMatchObject({ targetId: "b", revision: 2, phase: "requested" });
    expect(reactivatedIntent).toMatchObject({ state: "draining", revision: 2 });
    expect(() => store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "manual",
      requestId: "stale-preview-to-default",
      expectedRevision: stalePreview.previewRevision,
      scope: "active",
    })).toThrow(MigrationRevisionError);
    expect(() => store.setMigrationIntentState(initialIntent.id, "stopped", initialIntent.revision))
      .toThrow("migration intent revision is stale");

    const routingRevision = store.engineRouting("codex").revision;
    store.requestConversationMigrationToActiveAccount(conversation.id);
    expect(store.engineRouting("codex").revision).toBe(routingRevision);
    expect(store.snapshot().migrationIntents[initialIntent.id]?.revision).toBe(2);
  });

  test("an idle conversation with a live host stays in the eager switch scope", async () => {
    const store = registry();
    store.reconcileConversations([observation("/live-idle.jsonl", "managed", "idle")]);
    store.upsert({
      key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
      artifactPath: "/live-idle.jsonl",
      cwd: "/repo",
      accountId: "managed",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const preview = await previewMigration("codex", "default", store);

    expect(preview.counts).toEqual({ total: 1, idle: 1, busy: 0, deferred: 0, alreadyTarget: 0 });
  });

  test("host readiness changes invalidate migration previews", async () => {
    const store = registry();
    const key = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" };
    store.reconcileConversations([observation("/readiness-fence.jsonl", "managed", "idle")]);
    const deferredPreview = await previewMigration("codex", "default", store);

    store.upsert({
      key,
      artifactPath: "/readiness-fence.jsonl",
      cwd: "/repo",
      accountId: "managed",
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    await expect(createMigrationIntent(
      "codex",
      "default",
      "manual",
      "stale-deferred-preview",
      deferredPreview.previewRevision,
      "active",
      store,
    )).rejects.toBeInstanceOf(MigrationRevisionError);

    const livePreview = await previewMigration("codex", "default", store);
    expect(livePreview.counts).toEqual({ total: 1, idle: 1, busy: 0, deferred: 0, alreadyTarget: 0 });
    const liveRevision = livePreview.previewRevision;
    store.upsert({
      key,
      artifactPath: "/readiness-fence.jsonl",
      cwd: "/repo",
      accountId: "managed",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    expect(store.engineRouting("codex").revision).toBe(liveRevision);

    store.markUnhosted(key);
    await expect(createMigrationIntent(
      "codex",
      "default",
      "manual",
      "stale-live-preview",
      liveRevision,
      "active",
      store,
    )).rejects.toBeInstanceOf(MigrationRevisionError);

    const refreshedPreview = await previewMigration("codex", "default", store);
    expect(refreshedPreview.counts).toEqual({ total: 1, idle: 0, busy: 0, deferred: 1, alreadyTarget: 0 });
    const result = await createMigrationIntent(
      "codex",
      "default",
      "manual",
      "refreshed-preview",
      refreshedPreview.previewRevision,
      "active",
      store,
    );
    expect(result.intent.state).toBe("complete");
  });

  test("delivery placement and Stop invalidate readiness-sensitive previews", async () => {
    const store = registry();
    store.reconcileConversations([observation("/revision-history.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/revision-history.jsonl")!;
    const beforeDelivery = store.engineRouting("codex").revision;
    const queued = store.holdDelivery(conversation.id, "queued", "revision-delivery");
    expect(store.engineRouting("codex").revision).toBe(beforeDelivery + 1);
    const assignedRevision = store.engineRouting("codex").revision;
    store.beginDeliveryAttempt(queued.id, queued.generationId!);
    expect(store.engineRouting("codex").revision).toBe(assignedRevision + 1);
    const uncertainRevision = store.engineRouting("codex").revision;
    store.recordDeliveryOutcome(queued.id, "delivered");
    expect(store.engineRouting("codex").revision).toBe(uncertainRevision + 1);
    expect(() => store.commitMigrationIntent({
      engine: "codex", targetId: "b", origin: "manual", requestId: "revision-stale-delivery",
      expectedRevision: uncertainRevision, scope: "all",
    })).toThrow(MigrationRevisionError);
    const deliveredRevision = store.engineRouting("codex").revision;
    store.recordDeliveryOutcome(queued.id, "delivered");
    expect(store.engineRouting("codex").revision).toBe(deliveredRevision);
    const intent = store.commitMigrationIntent({
      engine: "codex", targetId: "b", origin: "manual", requestId: "revision-stop",
      expectedRevision: store.engineRouting("codex").revision, scope: "all",
    });
    const beforeStop = store.engineRouting("codex").revision;
    store.setMigrationIntentState(intent.id, "stopped", intent.revision);
    expect(store.engineRouting("codex").revision).toBe(beforeStop + 1);
  });

  test("card rollback invalidates an active-scope preview when readiness becomes deferred", () => {
    const store = registry();
    store.reconcileConversations([observation("/rollback-preview.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/rollback-preview.jsonl")!;
    const intent = store.commitMigrationIntent({
      engine: "codex", targetId: "b", origin: "manual", requestId: "rollback-preview",
      expectedRevision: store.engineRouting("codex").revision, scope: "all",
    });
    store.transitionConversationMigration(conversation.id, intent.revision, ["requested"], {
      phase: "failed-recoverable", error: "retry later",
    });
    const previewRevision = store.engineRouting("codex").revision;

    store.rollbackConversationMigration(conversation.id, intent.revision);

    expect(store.engineRouting("codex").revision).toBe(previewRevision + 1);
    expect(store.migrationScope("codex", "c")).toMatchObject({ idle: 0, deferred: 1 });
    expect(() => store.commitMigrationIntent({
      engine: "codex", targetId: "c", origin: "manual", requestId: "stale-rollback-preview",
      expectedRevision: previewRevision, scope: "active",
    })).toThrow(MigrationRevisionError);
    const settledRevision = store.engineRouting("codex").revision;
    store.rollbackConversationMigration(conversation.id, intent.revision);
    expect(store.engineRouting("codex").revision).toBe(settledRevision);
  });

  test("preview reads the controller inventory without rewriting the registry", async () => {
    const store = registry();
    store.reconcileConversations([observation("/owned.jsonl", "managed", "idle")]);
    const before = fs.statSync(store.filename, { bigint: true });

    const preview = await previewMigration("codex", "default", store);

    const after = fs.statSync(store.filename, { bigint: true });
    expect(preview.counts).toEqual({ total: 1, idle: 0, busy: 0, deferred: 1, alreadyTarget: 0 });
    expect(after.ino).toBe(before.ino);
  });

  test("an in-progress successor receipt remains pending for observer settlement", async () => {
    const store = registry();
    store.reconcileConversations([observation("/pending-source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/pending-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "pending-successor-receipt",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create() { throw new SuccessorPendingError(); },
      async verify() {},
    };

    const pending = await advanceConversationMigration(conversation.id, store, provider);

    expect(pending.migration).toMatchObject({ phase: "successor-starting", error: null, errorCode: null });
  });

  test("resume settlement between migration read and fence migrates the resumed generation", async () => {
    const store = registry();
    const sourceId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const resumedId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1327";
    const sourcePath = `/sessions/rollout-${sourceId}.jsonl`;
    const resumedPath = `/sessions/rollout-${resumedId}.jsonl`;
    store.reconcileConversations([observation(sourcePath, "a", "idle")]);
    const conversation = store.conversationForPath(sourcePath)!;
    const resume = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "a",
      conversationId: conversation.id,
      purpose: "resume-successor",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Resumed source" }),
    });
    if (resume.kind !== "created") throw new Error("expected resume create");
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "resume-during-migration-read",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const originalTransition = store.transitionConversationMigration.bind(store);
    let resumedDuringTransition = false;
    store.transitionConversationMigration = ((...args: Parameters<AgentRegistry["transitionConversationMigration"]>) => {
      if (!resumedDuringTransition && args[2].includes("requested")) {
        resumedDuringTransition = true;
        expect(store.settleSpawn(resume.receipt.launchId, {
          key: { engine: "codex", sessionId: resumedId },
          artifactPath: resumedPath,
          cwd: "/repo",
          accountId: "a",
          status: "unhosted",
          host: null,
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        }).kind).toBe("settled");
      }
      return originalTransition(...args);
    }) as typeof store.transitionConversationMigration;
    const copiedSourcePaths: string[] = [];
    const successorProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        copiedSourcePaths.push(input.source.path);
        return {
          operationId: input.operationId,
          nativeId: "resume-race-successor",
          path: "/sessions/resume-race-successor.jsonl",
          continuityPaths: [],
          historyHash: "resumed-history",
          host: { kind: "codex-app-server", identity: "resume-race", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() {},
    };

    const committed = await advanceConversationMigration(conversation.id, store, successorProvider);

    expect(resumedDuringTransition).toBe(true);
    expect(copiedSourcePaths).toEqual([resumedPath]);
    expect(committed.migration).toMatchObject({ phase: "committed", sourceGenerationId: resumedId });
    expect(committed.generations.map((generation) => generation.path)).toEqual([
      sourcePath,
      resumedPath,
      "/sessions/resume-race-successor.jsonl",
    ]);
    expect(committed.generations.at(-2)?.archivedAt).not.toBeNull();
  });

  test("concurrent same-operation advances commit one matching provider receipt", async () => {
    const store = registry();
    store.reconcileConversations([observation("/concurrent-source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/concurrent-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "concurrent-provider-receipt",
      expectedRevision: store.engineRouting("codex").revision,
    });
    let current = store.conversation(conversation.id)!;
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
    store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
    let arrivals = 0;
    let release!: () => void;
    const bothCreating = new Promise<void>((resolve) => { release = resolve; });
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        arrivals += 1;
        const arrival = arrivals;
        if (arrivals === 2) release();
        await bothCreating;
        return {
          operationId: input.operationId,
          nativeId: "concurrent-successor",
          path: "/concurrent-successor.jsonl",
          continuityPaths: [],
          historyHash: "same-history",
          host: { kind: "codex-app-server", identity: "concurrent-successor", epoch: 1, verifiedAt: `2026-07-10T12:01:0${arrival}.000Z` },
        };
      },
      async verify() {},
    };

    await Promise.all([
      advanceConversationMigration(conversation.id, store, provider),
      advanceConversationMigration(conversation.id, store, provider),
    ]);

    const committed = store.conversation(conversation.id)!;
    expect(committed.migration?.phase).toBe("committed");
    expect(committed.generations.map((generation) => generation.path)).toEqual([
      "/concurrent-source.jsonl",
      "/concurrent-successor.jsonl",
    ]);
  });

  test("concurrent Claude successors clean the losing host after one receipt commits", async () => {
    const store = registry();
    store.reconcileConversations([{ ...observation("/claude-source.jsonl", "a", "idle"), engine: "claude" }]);
    const conversation = store.conversationForPath("/claude-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "claude",
      targetId: "b",
      origin: "manual",
      requestId: "concurrent-claude-hosts",
      expectedRevision: store.engineRouting("claude").revision,
    });
    let current = store.conversation(conversation.id)!;
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
    store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
    let calls = 0;
    let releaseSecond!: () => void;
    const secondMayReturn = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const cleaned: string[] = [];
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        calls += 1;
        const call = calls;
        if (call === 2) await secondMayReturn;
        return {
          operationId: input.operationId,
          nativeId: "same-claude-successor",
          path: "/same-claude-successor.jsonl",
          continuityPaths: [],
          historyHash: "same-history",
          host: { kind: "claude-stream", identity: call === 1 ? "%1:101" : "%2:202", epoch: 1, verifiedAt: `2026-07-10T12:01:0${call}.000Z` },
        };
      },
      async verify(receipt) {
        if (receipt.host.identity === "%1:101") setTimeout(releaseSecond, 0);
      },
      async cleanup(receipt) { cleaned.push(receipt.host.identity); },
    };

    await Promise.all([
      advanceConversationMigration(conversation.id, store, provider),
      advanceConversationMigration(conversation.id, store, provider),
    ]);

    expect(store.conversation(conversation.id)).toMatchObject({
      migration: { phase: "committed", providerReceipt: { host: { identity: "%1:101" } } },
      generations: [{ path: "/claude-source.jsonl" }, { path: "/same-claude-successor.jsonl", host: { identity: "%1:101" } }],
    });
    expect(cleaned).toEqual(["%2:202"]);
  });

  test("a Codex source fork resolves to the committed target without another manual root", async () => {
    const project = "issue-86-codex-source-fork";
    const sourcePath = "/codex-predecessor.jsonl";
    const sourceForkPath = "/source-account/fork.jsonl";
    const targetPath = "/target-account/fork.jsonl";
    const store = registry();
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "codex-two-path-successor",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const closed = mutateBoard(project, boardFor(project).revision, [{ kind: "close", path: sourcePath }]);
    expect(closed.ok).toBeTrue();

    await advanceConversationMigration(
      conversation.id,
      store,
      provider([targetPath], { create: 0, verify: 0 }, [[sourceForkPath]]),
    );
    const committed = boardFor(project);
    const afterScan = mutateBoard(project, committed.revision, [{
      kind: "reconcile-roots",
      roots: [sourceForkPath, targetPath],
      removeManual: [],
    }]);

    expect(afterScan.ok).toBeTrue();
    expect(afterScan.board.pathAliases).toEqual({
      [sourcePath]: targetPath,
      [sourceForkPath]: targetPath,
    });
    expect(afterScan.board.prefs.hidden).toEqual([targetPath]);
    expect(afterScan.board.prefs.manual).toEqual([]);
  });

  test("retry preserves every provider fork until the successor commits", async () => {
    const project = "issue-86-failed-fork-retry";
    const sourcePath = "/retry-predecessor.jsonl";
    const firstForkPath = "/source-account/failed-fork.jsonl";
    const secondForkPath = "/source-account/retry-fork.jsonl";
    const targetPath = "/target-account/retry-fork.jsonl";
    const store = registry();
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "failed-fork-retry",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const failingProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        input.recordContinuityPath(firstForkPath);
        throw new Error("target account unavailable");
      },
      async verify() {},
    };

    const failed = await advanceConversationMigration(conversation.id, store, failingProvider);
    expect(failed.migration?.phase).toBe("failed-recoverable");
    expect(failed.continuityPaths).toEqual([firstForkPath]);
    const provisional = mutateBoard(project, boardFor(project).revision, [
      { kind: "restore", path: firstForkPath, placement: "manual" },
    ]);
    expect(provisional.ok).toBeTrue();

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations([observation(firstForkPath, "a", "idle", "worker", project)]);
    expect(Object.values(restarted.snapshot().conversations)).toHaveLength(1);
    expect(restarted.conversationForPath(firstForkPath)?.id).toBe(conversation.id);
    restarted.retryConversationMigration(conversation.id, failed.migration!.revision);
    const committed = await advanceConversationMigration(
      conversation.id,
      restarted,
      provider([targetPath], { create: 0, verify: 0 }, [[secondForkPath]]),
    );

    expect(committed.migration?.phase).toBe("committed");
    expect(committed.continuityPaths).toEqual([firstForkPath, secondForkPath]);
    expect(boardFor(project).pathAliases).toEqual({
      [sourcePath]: targetPath,
      [firstForkPath]: targetPath,
      [secondForkPath]: targetPath,
    });
    expect(boardFor(project).prefs.manual).toEqual([]);
  });

  test("a committed successor keeps its predecessor hidden through root reconciliation", async () => {
    const project = "issue-86-hidden-successor";
    const sourcePath = "/hidden-predecessor.jsonl";
    const successorPath = "/hidden-successor.jsonl";
    const store = registry();
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "hidden-board-successor",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const closed = mutateBoard(project, boardFor(project).revision, [{ kind: "close", path: sourcePath }]);
    expect(closed.ok).toBeTrue();

    await advanceConversationMigration(conversation.id, store, provider([successorPath]));
    const afterCommit = boardFor(project);
    const reconciled = mutateBoard(project, afterCommit.revision, [{
      kind: "reconcile-roots",
      roots: [successorPath],
      removeManual: [],
    }]);

    expect(reconciled.ok).toBeTrue();
    expect(reconciled.board.pathAliases).toEqual({ [sourcePath]: successorPath });
    expect(reconciled.board.prefs.hidden).toEqual([successorPath]);
    expect(reconciled.board.prefs.manual).toEqual([]);
  });

  test("reconciliation repairs board continuity for an already committed successor", async () => {
    const project = "issue-86-committed-repair";
    const sourcePath = "/repair-predecessor.jsonl";
    const successorPath = "/repair-successor.jsonl";
    const store = registry();
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "repair-committed-board",
      expectedRevision: store.engineRouting("codex").revision,
    });
    let current = store.conversation(conversation.id)!;
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["successor-starting"], { phase: "verifying" });
    store.holdDelivery(current.id, "continue after restart", "repair-client");
    store.commitSuccessor(current.id, { id: "repair-successor", path: successorPath, accountId: "b" }, current.migration!.revision);
    const closed = mutateBoard(project, boardFor(project).revision, [{ kind: "close", path: sourcePath }]);
    expect(closed.ok).toBeTrue();

    const restarted = new AgentRegistry(store.filename);
    const delivered: string[] = [];
    await reconcileMigrations(provider([]), {
      async deliver(input) {
        delivered.push(input.clientMessageId);
        return "delivered";
      },
    }, restarted);
    const repaired = boardFor(project);
    const reconciled = mutateBoard(project, repaired.revision, [{
      kind: "reconcile-roots",
      roots: [successorPath],
      removeManual: [],
    }]);

    expect(reconciled.ok).toBeTrue();
    expect(reconciled.board.pathAliases).toEqual({ [sourcePath]: successorPath });
    expect(reconciled.board.prefs.hidden).toEqual([successorPath]);
    expect(reconciled.board.prefs.manual).toEqual([]);
    expect(delivered).toEqual(["repair-client"]);
    expect(restarted.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("restart repair preserves placement after an interleaved client remap", async () => {
    const project = "issue-86-partial-board-convergence";
    const sourcePath = "/partial-source.jsonl";
    const forkPath = "/partial-source-fork.jsonl";
    const targetPath = "/partial-target.jsonl";
    const store = registry();
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "partial-board-convergence",
      expectedRevision: store.engineRouting("codex").revision,
    });
    let current = store.conversation(conversation.id)!;
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
    store.recordConversationContinuityPath(current.id, forkPath);
    const receipt: ProviderReceipt = {
      operationId: current.migration!.operationId,
      nativeId: "partial-target",
      path: targetPath,
      continuityPaths: [forkPath],
      historyHash: "partial-history",
      host: { kind: "codex-app-server", identity: "partial-target", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
    };
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });
    store.commitSuccessor(current.id, { id: receipt.nativeId, path: targetPath, accountId: "b" }, current.migration!.revision);
    const arranged = mutateBoard(project, boardFor(project).revision, [
      { kind: "restore", path: sourcePath, placement: "manual" },
      { kind: "remap-paths", pairs: [{ from: sourcePath, to: targetPath }] },
    ]);
    expect(arranged.ok).toBeTrue();
    expect(arranged.board.prefs.manual).toEqual([targetPath]);

    const restarted = new AgentRegistry(store.filename);
    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, restarted);

    expect(boardFor(project)).toMatchObject({
      pathAliases: { [sourcePath]: targetPath, [forkPath]: targetPath },
      prefs: { manual: [targetPath] },
    });
  });

  test("committed successors replace provisional manual roots with predecessor placement", async () => {
    const project = "issue-86-placement";
    const sources = ["/manual-source.jsonl", "/expanded-source.jsonl", "/auto-source.jsonl"];
    const successors = ["/manual-next.jsonl", "/expanded-next.jsonl", "/auto-next.jsonl"];
    const continuityPaths = ["/manual-fork.jsonl", "/expanded-fork.jsonl", "/auto-fork.jsonl"];
    const store = registry();
    store.reconcileConversations(sources.map((pathname) => observation(pathname, "a", "idle", "worker", project)));
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "preserve-board-placement",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const arranged = mutateBoard(project, boardFor(project).revision, [
      { kind: "restore", path: sources[0]!, placement: "manual" },
      { kind: "restore", path: sources[1]!, placement: "expanded" },
      ...successors.map((pathname) => ({ kind: "restore" as const, path: pathname, placement: "manual" as const })),
      ...continuityPaths.map((pathname) => ({ kind: "restore" as const, path: pathname, placement: "manual" as const })),
    ]);
    expect(arranged.ok).toBeTrue();

    await reconcileMigrations(
      provider([...successors], { create: 0, verify: 0 }, continuityPaths.map((pathname) => [pathname])),
      { async deliver() { return "delivered"; } },
      store,
    );

    const board = boardFor(project);
    expect(board.pathAliases).toEqual(Object.fromEntries([
      ...sources.map((source, index) => [source, successors[index]!] as const),
      ...continuityPaths.map((source, index) => [source, successors[index]!] as const),
    ]));
    expect(board.prefs.manual).toEqual([successors[0]]);
    expect(board.prefs.expanded).toEqual([successors[1]]);
    expect(board.prefs.hidden).toEqual([]);
    expect([...board.prefs.manual, ...board.prefs.expanded, ...board.prefs.hidden]).not.toContain(successors[2]);
    const converged = mutateBoard(project, board.revision, [{
      kind: "reconcile-roots",
      roots: successors,
      removeManual: [],
    }]);
    expect(converged.ok).toBeTrue();
    expect(converged.board.prefs.manual).toEqual([successors[0]]);
    expect(converged.board.prefs.expanded).toEqual([successors[1]]);
    expect([...converged.board.prefs.manual, ...converged.board.prefs.expanded, ...converged.board.prefs.hidden]).not.toContain(successors[2]);
  });

  test("repeat migration carries manual placement across historical continuity aliases", async () => {
    const project = "issue-86-repeat-placement";
    const store = registry();
    store.reconcileConversations([observation("/a.jsonl", "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath("/a.jsonl")!;
    let arranged = mutateBoard(project, boardFor(project).revision, [
      { kind: "restore", path: "/a.jsonl", placement: "manual" },
    ]);
    expect(arranged.ok).toBeTrue();
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "repeat-placement-b",
      expectedRevision: store.engineRouting("codex").revision,
    });
    await advanceConversationMigration(
      conversation.id,
      store,
      provider(["/b.jsonl"], { create: 0, verify: 0 }, [["/fork-b.jsonl"]]),
    );
    expect(boardFor(project).prefs.manual).toEqual(["/b.jsonl"]);

    store.commitMigrationIntent({
      engine: "codex",
      targetId: "c",
      origin: "manual",
      requestId: "repeat-placement-c",
      expectedRevision: store.engineRouting("codex").revision,
    });
    arranged = mutateBoard(project, boardFor(project).revision, [
      { kind: "restore", path: "/fork-c.jsonl", placement: "manual" },
      { kind: "restore", path: "/c.jsonl", placement: "manual" },
    ]);
    expect(arranged.ok).toBeTrue();
    await advanceConversationMigration(
      conversation.id,
      store,
      provider(["/c.jsonl"], { create: 0, verify: 0 }, [["/fork-c.jsonl"]]),
    );

    expect(boardFor(project)).toMatchObject({
      pathAliases: {
        "/a.jsonl": "/c.jsonl",
        "/b.jsonl": "/c.jsonl",
        "/fork-b.jsonl": "/c.jsonl",
        "/fork-c.jsonl": "/c.jsonl",
      },
      prefs: { manual: ["/c.jsonl"] },
    });
  });

  test("a 51-conversation drain keeps a two-card board from growing", async () => {
    const project = "issue-86-mass-drain";
    const sources = Array.from({ length: 51 }, (_, index) => `/drain-source-${index}.jsonl`);
    const forks = Array.from({ length: 51 }, (_, index) => `/source-account/drain-fork-${index}.jsonl`);
    const successors = Array.from({ length: 51 }, (_, index) => `/drain-successor-${index}.jsonl`);
    const visible = ["/visible-one.jsonl", "/visible-two.jsonl"];
    const store = registry();
    store.reconcileConversations(sources.map((pathname) => observation(pathname, "a", "idle", "worker", project)));
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "mass-drain-board-continuity",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const arranged = mutateBoard(project, boardFor(project).revision, [
      ...visible.map((pathname) => ({ kind: "restore" as const, path: pathname, placement: "manual" as const })),
      ...forks.map((pathname) => ({ kind: "restore" as const, path: pathname, placement: "manual" as const })),
      ...successors.map((pathname) => ({ kind: "restore" as const, path: pathname, placement: "manual" as const })),
      ...sources.map((pathname) => ({ kind: "close" as const, path: pathname })),
    ]);
    expect(arranged.ok).toBeTrue();
    expect(arranged.board.prefs.manual).toHaveLength(104);

    await reconcileMigrations(
      provider([...successors], { create: 0, verify: 0 }, forks.map((pathname) => [pathname])),
      { async deliver() { return "delivered"; } },
      store,
    );
    const committed = boardFor(project);
    expect(committed.revision).toBe(arranged.board.revision + 1);
    const afterScan = mutateBoard(project, committed.revision, [{
      kind: "reconcile-roots",
      roots: [...visible, ...forks, ...successors],
      removeManual: [],
    }]);

    expect(afterScan.ok).toBeTrue();
    expect(afterScan.board.prefs.manual).toEqual(visible);
    expect(afterScan.board.prefs.hidden).toEqual(successors);
    expect(Object.keys(afterScan.board.pathAliases ?? {})).toHaveLength(102);
    expect(Object.values(store.snapshot().conversations).every((conversation) => conversation.migration?.boardProject === project)).toBeTrue();
  });

  test("board repair failures keep delivery and intent reconciliation live", async () => {
    const project = "issue-86-board-retry";
    const store = registry();
    store.reconcileConversations([observation("/repair-source.jsonl", "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath("/repair-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "board-retry",
      expectedRevision: store.engineRouting("codex").revision,
    });
    store.holdDelivery(conversation.id, "continue", "board-retry-delivery");
    const delivered: string[] = [];

    await reconcileMigrations(
      provider(["/repair-target.jsonl"]),
      { async deliver(input) { delivered.push(input.clientMessageId); return "delivered"; } },
      store,
      { remapBoardPaths() { throw new Error("board unavailable"); } },
    );

    expect(delivered).toEqual(["board-retry-delivery"]);
    expect(store.snapshot().migrationIntents[store.conversation(conversation.id)!.migration!.intentId]?.state).toBe("complete");
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBeNull();

    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe(project);
    expect(boardFor(project).pathAliases).toEqual({ "/repair-source.jsonl": "/repair-target.jsonl" });
  });

  test("board repair remains pending when storage omits requested aliases", async () => {
    const project = "issue-86-board-verification";
    const store = registry();
    store.reconcileConversations([observation("/verify-source.jsonl", "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath("/verify-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "board-verification",
      expectedRevision: store.engineRouting("codex").revision,
    });

    await advanceConversationMigration(
      conversation.id,
      store,
      provider(["/verify-target.jsonl"]),
      { remapBoardPaths: () => boardFor(project) },
    );

    expect(store.conversation(conversation.id)?.migration?.boardProject).toBeNull();
    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe(project);
  });

  test("a later migration repairs placement stranded by an earlier board outage", async () => {
    const project = "issue-86-deferred-chain";
    const store = registry();
    store.reconcileConversations([observation("/a.jsonl", "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath("/a.jsonl")!;
    const closed = mutateBoard(project, boardFor(project).revision, [{ kind: "close", path: "/a.jsonl" }]);
    expect(closed.ok).toBeTrue();
    const firstIntent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "deferred-chain-b",
      expectedRevision: store.engineRouting("codex").revision,
    });
    await advanceConversationMigration(
      conversation.id,
      store,
      provider(["/b.jsonl"]),
      { remapBoardPaths() { throw new Error("board unavailable"); } },
    );
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBeNull();
    store.setMigrationIntentState(firstIntent.id, "complete");
    store.reconcileConversations([observation("/b.jsonl", "b", "idle", "worker", project)]);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "c",
      origin: "manual",
      requestId: "deferred-chain-c",
      expectedRevision: store.engineRouting("codex").revision,
    });

    await advanceConversationMigration(conversation.id, store, provider(["/c.jsonl"]));

    expect(boardFor(project)).toMatchObject({
      pathAliases: { "/a.jsonl": "/c.jsonl", "/b.jsonl": "/c.jsonl" },
      prefs: { hidden: ["/c.jsonl"], manual: [] },
    });
  });

  test("board repair follows a successor into its current catalog project", async () => {
    const store = registry();
    store.reconcileConversations([observation("/group-source.jsonl", "a", "idle", "worker", "stale-project")]);
    const conversation = store.conversationForPath("/group-source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "group-repair", expectedRevision: store.engineRouting("codex").revision });
    let current = store.conversation(conversation.id)!;
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
    current = store.transitionConversationMigration(current.id, current.migration!.revision, ["successor-starting"], { phase: "verifying" });
    store.commitSuccessor(current.id, { id: "group-target", path: "/group-target.jsonl", accountId: "b" }, current.migration!.revision);
    store.reconcileConversations([observation("/group-target.jsonl", "b", "idle", "worker", "canonical-project")]);

    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);

    expect(boardFor("canonical-project").pathAliases).toEqual({ "/group-source.jsonl": "/group-target.jsonl" });
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe("canonical-project");
  });

  test("first restart repair transfers predecessor placement into the corrected project", async () => {
    for (const placement of ["hidden", "manual", "expanded"] as const) {
      const store = registry();
      const sourcePath = `/restart-${placement}-source.jsonl`;
      const targetPath = `/restart-${placement}-target.jsonl`;
      const oldProject = `restart-${placement}-old`;
      const newProject = `restart-${placement}-new`;
      store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", oldProject)]);
      const conversation = store.conversationForPath(sourcePath)!;
      const arranged = mutateBoard(oldProject, boardFor(oldProject).revision, [placement === "hidden"
        ? { kind: "close", path: sourcePath }
        : { kind: "restore", path: sourcePath, placement }]);
      expect(arranged.ok).toBeTrue();
      store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `restart-${placement}`,
        expectedRevision: store.engineRouting("codex").revision,
      });
      let current = store.conversation(conversation.id)!;
      current = store.transitionConversationMigration(current.id, current.migration!.revision, ["requested"], { phase: "preparing" });
      current = store.transitionConversationMigration(current.id, current.migration!.revision, ["preparing"], { phase: "successor-starting" });
      current = store.transitionConversationMigration(current.id, current.migration!.revision, ["successor-starting"], { phase: "verifying" });
      store.commitSuccessor(current.id, { id: `restart-${placement}-target`, path: targetPath, accountId: "b" }, current.migration!.revision);
      store.reconcileConversations([
        observation(sourcePath, "a", "idle", "worker", newProject),
        observation(targetPath, "b", "idle", "worker", newProject),
      ]);

      await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);

      expect(boardFor(oldProject).prefs[placement]).toEqual([]);
      expect(boardFor(newProject).prefs[placement]).toEqual([targetPath]);
    }
  });

  test("project correction removes provisional continuity cards after a board outage", async () => {
    const store = registry();
    const sourcePath = "/outage-project-source.jsonl";
    const forkPath = "/outage-project-fork.jsonl";
    const targetPath = "/outage-project-target.jsonl";
    store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", "outage-old-project")]);
    const conversation = store.conversationForPath(sourcePath)!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "outage-project-correction",
      expectedRevision: store.engineRouting("codex").revision,
    });
    const provisional = mutateBoard("outage-old-project", boardFor("outage-old-project").revision, [
      { kind: "restore", path: forkPath, placement: "manual" },
    ]);
    expect(provisional.ok).toBeTrue();
    await advanceConversationMigration(
      conversation.id,
      store,
      provider([targetPath], { create: 0, verify: 0 }, [[forkPath]]),
      { remapBoardPaths() { throw new Error("board unavailable"); } },
    );
    store.reconcileConversations([
      observation(targetPath, "b", "idle", "worker", "outage-new-project"),
    ]);

    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);

    expect(boardFor("outage-old-project").prefs.manual).toEqual([]);
    expect(boardFor("outage-new-project")).toMatchObject({
      pathAliases: { [sourcePath]: targetPath, [forkPath]: targetPath },
      prefs: { manual: [], hidden: [], expanded: [] },
    });
  });

  test("project correction transfers previously repaired placement", async () => {
    const store = registry();
    store.reconcileConversations([observation("/project-source.jsonl", "a", "idle", "worker", "stale-project")]);
    const conversation = store.conversationForPath("/project-source.jsonl")!;
    const closed = mutateBoard("stale-project", boardFor("stale-project").revision, [
      { kind: "close", path: "/project-source.jsonl" },
    ]);
    expect(closed.ok).toBeTrue();
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "project-correction",
      expectedRevision: store.engineRouting("codex").revision,
    });
    await advanceConversationMigration(conversation.id, store, provider(["/project-target.jsonl"]));
    expect(boardFor("stale-project").prefs.hidden).toEqual(["/project-target.jsonl"]);
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe("stale-project");
    store.reconcileConversations([
      observation("/stays-in-source.jsonl", "a", "idle", "worker", "stale-project"),
    ]);
    const kept = mutateBoard("stale-project", boardFor("stale-project").revision, [
      { kind: "close", path: "/stays-in-source.jsonl" },
    ]);
    expect(kept.ok).toBeTrue();
    store.reconcileConversations([
      observation("/project-target.jsonl", "b", "idle", "worker", "canonical-project"),
    ]);

    await reconcileMigrations(
      provider([]),
      { async deliver() { return "delivered"; } },
      store,
      { remapBoardPaths() { throw new Error("alias storage unavailable"); } },
    );
    expect(boardFor("canonical-project").prefs.hidden).toEqual(["/project-target.jsonl"]);
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe("stale-project");
    store.reconcileConversations([
      observation("/project-target.jsonl", "b", "idle", "worker", "final-project"),
    ]);

    await reconcileMigrations(provider([]), { async deliver() { return "delivered"; } }, store);

    expect(boardFor("stale-project").prefs.hidden).toEqual(["/stays-in-source.jsonl"]);
    expect(boardFor("canonical-project").prefs.hidden).toEqual([]);
    expect(boardFor("final-project")).toMatchObject({
      pathAliases: { "/project-source.jsonl": "/project-target.jsonl" },
      prefs: { hidden: ["/project-target.jsonl"], manual: [] },
    });
    expect(store.conversation(conversation.id)?.migration?.boardProject).toBe("final-project");
  });

  test("repeat migration carries prior project placement into the regrouped board", async () => {
    for (const placement of ["hidden", "manual", "expanded"] as const) {
      const store = registry();
      const sourcePath = `/${placement}-a.jsonl`;
      const middlePath = `/${placement}-b.jsonl`;
      const targetPath = `/${placement}-c.jsonl`;
      const oldProject = `${placement}-old-project`;
      const newProject = `${placement}-new-project`;
      store.reconcileConversations([observation(sourcePath, "a", "idle", "worker", oldProject)]);
      const conversation = store.conversationForPath(sourcePath)!;
      const arranged = mutateBoard(oldProject, boardFor(oldProject).revision, [placement === "hidden"
        ? { kind: "close", path: sourcePath }
        : { kind: "restore", path: sourcePath, placement }]);
      expect(arranged.ok).toBeTrue();
      const firstIntent = store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `${placement}-to-b`,
        expectedRevision: store.engineRouting("codex").revision,
      });
      await advanceConversationMigration(conversation.id, store, provider([middlePath]));
      store.setMigrationIntentState(firstIntent.id, "complete");
      store.reconcileConversations([observation(middlePath, "b", "idle", "worker", newProject)]);
      store.commitMigrationIntent({
        engine: "codex",
        targetId: "c",
        origin: "manual",
        requestId: `${placement}-to-c`,
        expectedRevision: store.engineRouting("codex").revision,
      });

      await advanceConversationMigration(conversation.id, store, provider([targetPath]));

      expect(boardFor(oldProject).prefs[placement]).toEqual([]);
      expect(boardFor(newProject).prefs[placement]).toEqual([targetPath]);
    }
  });

  test("unowned inventory stays outside previews and committed migration scope", async () => {
    const store = registry();
    store.reconcileConversations([
      observation("/owned.jsonl", "managed", "idle"),
      observation("/scanner-artifact.log", null, "busy"),
    ]);

    const preview = await previewMigration("codex", "default", store);
    expect(preview.counts).toEqual({ total: 1, idle: 0, busy: 0, deferred: 1, alreadyTarget: 0 });
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "manual",
      requestId: "owned-only",
      expectedRevision: preview.previewRevision,
    });

    expect(store.conversationForPath("/owned.jsonl")?.migration).toMatchObject({ targetId: "default" });
    expect(store.conversationForPath("/scanner-artifact.log")?.migration).toBeNull();
  });

  test("reconciliation rolls back an unowned annotation persisted by an older build", async () => {
    const store = registry();
    store.reconcileConversations([observation("/legacy-scanner-artifact.log", null, "busy")]);
    const conversation = store.conversationForPath("/legacy-scanner-artifact.log")!;
    const intent = store.upsertMigrationIntent("codex", "default", "manual", "legacy-unowned");
    store.setConversationMigration(conversation.id, {
      intentId: intent.id,
      phase: "waiting-turn",
      targetId: "default",
      revision: intent.revision,
      sourceGenerationId: conversation.generations[0]!.id,
      operationId: "legacy-unowned-operation",
      error: null,
      errorCode: null,
      providerReceipt: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    const calls = { create: 0, verify: 0 };

    await reconcileMigrations(provider([], calls), { async deliver() { return "delivered"; } }, store);

    expect(calls).toEqual({ create: 0, verify: 0 });
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("rolled-back");
    expect(store.snapshot().migrationIntents[intent.id]?.state).toBe("complete");
  });

  test("commits routing, intent, and every conversation scope including roots atomically", () => {
    const store = registry();
    store.reconcileConversations([
      observation("/idle.jsonl", "a", "idle"),
      observation("/busy.jsonl", "a", "busy"),
      observation("/root.jsonl", "a", "idle", "root"),
    ]);
    const previewRevision = store.engineRouting("codex").revision;
    const intent = store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "request-1", expectedRevision: previewRevision });
    const snapshot = store.snapshot();
    expect(snapshot.engineRouting.codex.activeAccountId).toBe("b");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/idle.jsonl")?.migration?.phase).toBe("requested");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/busy.jsonl")?.migration?.phase).toBe("waiting-turn");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/root.jsonl")?.migration?.phase).toBe("requested");
    expect(store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "request-1", expectedRevision: previewRevision }).id).toBe(intent.id);
    expect(() => store.commitMigrationIntent({ engine: "codex", targetId: "a", origin: "manual", requestId: "request-2", expectedRevision: previewRevision }))
      .toThrow(MigrationRevisionError);
  });

  test("returning to the source before commit drains held input once after restart", async () => {
    const store = registry();
    store.reconcileConversations([observation("/return-source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/return-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "leave-source",
      expectedRevision: store.engineRouting("codex").revision,
    });
    store.holdDelivery(conversation.id, "stay with source", "return-source-message");
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "a",
      origin: "manual",
      requestId: "return-to-source",
      expectedRevision: store.engineRouting("codex").revision,
    });

    const restarted = new AgentRegistry(store.filename);
    expect(restarted.conversation(conversation.id)?.migration).toBeNull();
    expect(restarted.pendingDeliveries(conversation.id)).toMatchObject([{
      clientMessageId: "return-source-message",
      state: "assigned",
      generationId: conversation.generations[0]?.id,
    }]);
    const delivered: string[] = [];
    await reconcileMigrations(provider([]), {
      async deliver({ clientMessageId }) {
        delivered.push(clientMessageId);
        return "delivered";
      },
    }, restarted);

    expect(delivered).toEqual(["return-source-message"]);
    expect(restarted.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("A to B to A preserves one owner, the full profile, and drains held input once", async () => {
    const store = registry();
    store.reconcileConversations([observation("/a.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/a.jsonl")!;
    const firstRevision = store.engineRouting("codex").revision;
    const firstIntent = store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "to-b", expectedRevision: firstRevision });
    const held = store.holdDelivery(conversation.id, "continue", "client-1");
    expect(store.holdDelivery(conversation.id, "continue", "client-1").id).toBe(held.id);
    await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"]));
    const committedOnce = store.conversation(conversation.id)!;
    const successor = committedOnce.generations.at(-1)!;
    expect(store.commitSuccessor(conversation.id, { id: successor.id, path: successor.path, accountId: successor.accountId }, committedOnce.migration!.revision).generations).toHaveLength(2);
    const delivered: string[] = [];
    await drainHeldDeliveries(conversation.id, { async deliver(input) { delivered.push(input.clientMessageId); return "delivered"; } }, store);
    expect(delivered).toEqual(["client-1"]);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
    store.setMigrationIntentState(firstIntent.id, "complete");

    store.reconcileConversations([observation("/b.jsonl", "b", "idle")]);
    const secondRevision = store.engineRouting("codex").revision;
    store.commitMigrationIntent({ engine: "codex", targetId: "a", origin: "manual", requestId: "to-a", expectedRevision: secondRevision });
    const final = await advanceConversationMigration(conversation.id, store, provider(["/a2.jsonl"]));
    expect(final.id).toBe(conversation.id);
    expect(final.generations.map((generation) => generation.path)).toEqual(["/a.jsonl", "/b.jsonl", "/a2.jsonl"]);
    expect(final.generations.at(-1)?.launchProfile).toMatchObject({ cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, permissionMode: "never", title: "Title /a.jsonl" });
    expect(final.generations.at(-1)?.launchProfile.goal?.objective).toBe("Ship");
    expect(final.generations.at(-1)?.launchProfile.plan?.current).toBe("Implement");
  });

  test("retargeting during a drain keeps the durable message queued for the new successor", async () => {
    const store = registry();
    store.reconcileConversations([observation("/delivery-source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/delivery-source.jsonl")!;
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "delivery-to-b",
      expectedRevision: store.engineRouting("codex").revision,
    });
    store.holdDelivery(conversation.id, "continue after retarget", "delivery-retarget");
    await advanceConversationMigration(conversation.id, store, provider(["/delivery-b.jsonl"]));

    await drainHeldDeliveries(conversation.id, {
      async deliver() {
        store.commitMigrationIntent({
          engine: "codex",
          targetId: "c",
          origin: "manual",
          requestId: "delivery-to-c",
          expectedRevision: store.engineRouting("codex").revision,
        });
        return "held";
      },
    }, store);

    expect(store.conversation(conversation.id)?.migration).toMatchObject({ targetId: "c", phase: "waiting-turn" });
    expect(store.pendingDeliveries(conversation.id)).toMatchObject([{
      clientMessageId: "delivery-retarget",
      state: "held",
      generationId: null,
    }]);

    await advanceConversationMigration(conversation.id, store, provider(["/delivery-c.jsonl"]));
    const delivered: string[] = [];
    await drainHeldDeliveries(conversation.id, {
      async deliver({ clientMessageId }) {
        delivered.push(clientMessageId);
        return "delivered";
      },
    }, store);
    expect(delivered).toEqual(["delivery-retarget"]);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("restart adopts a persisted two-path Codex receipt and repairs board continuity", async () => {
    const project = "issue-86-restart-two-path";
    const sourceForkPath = "/source-account/restart-fork.jsonl";
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle", "worker", project)]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "restart", expectedRevision: store.engineRouting("codex").revision });
    const revision = store.conversation(conversation.id)!.migration!.revision;
    store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
    store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
    const receipt: ProviderReceipt = {
      operationId: store.conversation(conversation.id)!.migration!.operationId,
      nativeId: "native-b",
      path: "/b.jsonl",
      continuityPaths: [sourceForkPath],
      historyHash: "hash",
      host: { kind: "codex-app-server", identity: "host", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
    };
    store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });
    const closed = mutateBoard(project, boardFor(project).revision, [{ kind: "close", path: "/source.jsonl" }]);
    expect(closed.ok).toBeTrue();

    const restarted = new AgentRegistry(store.filename);
    const counts = { create: 0, verify: 0 };
    const final = await advanceConversationMigration(conversation.id, restarted, provider([], counts));
    expect(counts).toEqual({ create: 0, verify: 1 });
    expect(final.generations.at(-1)?.path).toBe("/b.jsonl");
    expect(boardFor(project)).toMatchObject({
      pathAliases: { "/source.jsonl": "/b.jsonl", [sourceForkPath]: "/b.jsonl" },
      prefs: { hidden: ["/b.jsonl"], manual: [] },
    });
  });

  test("busy sessions wait for authoritative terminal evidence", async () => {
    const store = registry();
    store.reconcileConversations([observation("/busy.jsonl", "a", "busy")]);
    const conversation = store.conversationForPath("/busy.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "terminal", expectedRevision: store.engineRouting("codex").revision });
    const counts = { create: 0, verify: 0 };
    await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"], counts));
    expect(counts.create).toBe(0);
    store.reconcileConversations([observation("/busy.jsonl", "a", "terminal")]);
    const final = await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"], counts));
    expect(counts.create).toBe(1);
    expect(final.migration?.phase).toBe("committed");
  });

  test("inventory changes fence stale previews and preserve durable profile ownership", () => {
    const store = registry();
    const initial = observation("/owned.jsonl", "a", "idle");
    store.reconcileConversations([initial]);
    const staleRevision = store.engineRouting("codex").revision;
    const refreshed = observation("/owned.jsonl", "b", "busy", "root");
    refreshed.launchProfile.goal = null;
    refreshed.launchProfile.plan = null;
    store.reconcileConversations([refreshed]);

    const current = store.conversationForPath("/owned.jsonl")!;
    expect(current.generations.at(-1)?.launchProfile).toMatchObject({ role: "root" });
    expect(current.generations.at(-1)?.launchProfile.goal?.objective).toBe("Ship");
    expect(current.generations.at(-1)?.launchProfile.plan?.current).toBe("Implement");
    expect(store.engineRouting("codex").revision).toBeGreaterThan(staleRevision);
    expect(() => store.commitMigrationIntent({ engine: "codex", targetId: "c", origin: "manual", requestId: "stale-scope", expectedRevision: staleRevision }))
      .toThrow(MigrationRevisionError);
  });

  test("rollback reassigns held delivery to the healthy source generation", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "rollback", expectedRevision: store.engineRouting("codex").revision });
    store.holdDelivery(conversation.id, "safe retry", "client-rollback");
    const revision = store.conversation(conversation.id)!.migration!.revision;
    store.rollbackConversationMigration(conversation.id, revision);
    const assigned = store.pendingDeliveries(conversation.id)[0]!;
    expect(assigned).toMatchObject({ state: "assigned", generationId: conversation.generations[0]?.id });
    await drainHeldDeliveries(conversation.id, { async deliver() { return "delivered"; } }, store);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("a root session preserves its active goal and drains held delivery through the successor", async () => {
    const store = registry();
    store.reconcileConversations([observation("/root.jsonl", "a", "idle", "root")]);
    const conversation = store.conversationForPath("/root.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "root-lifecycle", expectedRevision: store.engineRouting("codex").revision });
    store.holdDelivery(conversation.id, "continue the active goal", "root-delivery");

    const committed = await advanceConversationMigration(conversation.id, store, provider(["/root-successor.jsonl"]));
    const successor = committed.generations.at(-1)!;
    expect(committed.migration?.phase).toBe("committed");
    expect(successor.launchProfile).toMatchObject({ role: "root", goal: { objective: "Ship", status: "active" } });
    expect(store.pendingDeliveries(conversation.id)[0]).toMatchObject({ state: "assigned", generationId: successor.id });

    const delivered: string[] = [];
    await drainHeldDeliveries(conversation.id, { async deliver(input) { delivered.push(input.clientMessageId); return "delivered"; } }, store);
    expect(delivered).toEqual(["root-delivery"]);
  });

  test("an ambiguous held delivery is claimed once and never replayed automatically", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "uncertain", expectedRevision: store.engineRouting("codex").revision });
    store.holdDelivery(conversation.id, "send once", "client-uncertain");
    await advanceConversationMigration(conversation.id, store, provider(["/target.jsonl"]));
    let attempts = 0;
    const uncertain = { async deliver() { attempts += 1; throw new Error("transport result lost"); } };

    await drainHeldDeliveries(conversation.id, uncertain, store);
    await drainHeldDeliveries(conversation.id, uncertain, store);

    expect(attempts).toBe(1);
    expect(store.pendingDeliveries(conversation.id)[0]).toMatchObject({ state: "delivery-uncertain", attempts: 1 });
    store.rollbackConversationMigration(conversation.id, store.conversation(conversation.id)!.migration!.revision);
    expect(store.pendingDeliveries(conversation.id)[0]?.state).toBe("delivery-uncertain");
  });

  test("a durable delivery port reconciles its uncertain claim to journal completion", async () => {
    const store = registry();
    store.reconcileConversations([observation("/structured.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/structured.jsonl")!;
    store.holdDelivery(conversation.id, "send through the structured host", "structured-held");
    const calls: string[] = [];
    const durable = {
      async deliver() {
        calls.push("deliver");
        return "delivery-uncertain" as const;
      },
      async reconcileUncertain() {
        calls.push("reconcile");
        return "delivered" as const;
      },
    };

    await drainHeldDeliveries(conversation.id, durable, store);
    expect(store.pendingDeliveries(conversation.id)[0]).toMatchObject({
      state: "delivery-uncertain",
      attempts: 1,
    });

    await drainHeldDeliveries(conversation.id, durable, store);

    expect(calls).toEqual(["deliver", "reconcile"]);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("a rapid retarget fences a stale provider result", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "to-b", expectedRevision: store.engineRouting("codex").revision });
    const staleProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        store.commitMigrationIntent({ engine: "codex", targetId: "c", origin: "manual", requestId: "to-c", expectedRevision: store.engineRouting("codex").revision });
        return {
          operationId: input.operationId,
          nativeId: "stale-b",
          path: "/stale-b.jsonl",
          continuityPaths: [],
          historyHash: "stale",
          host: { kind: "codex-app-server", identity: "stale", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() {},
    };
    const latest = await advanceConversationMigration(conversation.id, store, staleProvider);
    expect(latest.migration).toMatchObject({ targetId: "c", phase: "requested" });
    expect(latest.generations).toHaveLength(1);
  });

  test("retry preserves an ambiguous Codex fork operation id", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "ambiguous-fork", expectedRevision: store.engineRouting("codex").revision });
    const operations: string[] = [];
    const ambiguousProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        operations.push(input.operationId);
        if (operations.length === 1) throw new CodexForkOutcomeUnknownError();
        input.recordContinuityPath("/recovered-fork.jsonl");
        return { operationId: input.operationId, nativeId: "recovered", path: "/recovered.jsonl", continuityPaths: ["/recovered-fork.jsonl"], historyHash: "hash", host: { kind: "codex-app-server", identity: "recovered", epoch: 1, verifiedAt: "now" } };
      },
      async verify() {},
    };
    const failed = await advanceConversationMigration(conversation.id, store, ambiguousProvider);
    expect(failed).toMatchObject({ migration: { phase: "failed-recoverable", errorCode: "codex-fork-outcome-unknown" } });
    store.retryConversationMigration(conversation.id, failed.migration!.revision);
    const committed = await advanceConversationMigration(conversation.id, store, ambiguousProvider);
    expect(committed.migration?.phase).toBe("committed");
    expect(operations).toEqual([operations[0]!, operations[0]!]);
  });

  test("reconciliation retries a durable stale-successor cleanup after restart", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "cleanup-retry", expectedRevision: store.engineRouting("codex").revision });
    let cleanupAttempts = 0;
    const cleanupProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) { return { operationId: input.operationId, nativeId: "stale", path: "/stale.jsonl", continuityPaths: [], historyHash: "hash", host: { kind: "claude-stream", identity: "%9:99", epoch: 1, verifiedAt: "now" } }; },
      async verify() { throw new Error("verification failed"); },
      async cleanup() { cleanupAttempts += 1; if (cleanupAttempts === 1) throw new Error("tmux unavailable"); },
    };
    await advanceConversationMigration(conversation.id, store, cleanupProvider);
    expect(Object.keys(store.snapshot().pendingSuccessorCleanups)).toHaveLength(1);
    const restarted = new AgentRegistry(store.filename);
    await reconcileMigrations(cleanupProvider, { async deliver() { return "delivered"; } }, restarted);
    expect(cleanupAttempts).toBe(2);
    expect(Object.keys(restarted.snapshot().pendingSuccessorCleanups)).toHaveLength(0);
  });

  test("retarget, Stop, and Keep persist abandoned successor cleanup across restart", async () => {
    for (const action of ["retarget", "stop", "keep"] as const) {
      const store = registry();
      const sourcePath = `/abandoned-${action}.jsonl`;
      store.reconcileConversations([observation(sourcePath, "a", "idle")]);
      const conversation = store.conversationForPath(sourcePath)!;
      const intent = store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `abandon-${action}`,
        expectedRevision: store.engineRouting("codex").revision,
      });
      const revision = store.conversation(conversation.id)!.migration!.revision;
      store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
      store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
      const receipt: ProviderReceipt = {
        operationId: store.conversation(conversation.id)!.migration!.operationId,
        nativeId: `successor-${action}`,
        path: `/successor-${action}.jsonl`,
        continuityPaths: [],
        historyHash: `hash-${action}`,
        host: { kind: "codex-app-server", identity: `host-${action}`, epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
      };
      store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });

      if (action === "retarget") {
        store.commitMigrationIntent({
          engine: "codex",
          targetId: "c",
          origin: "manual",
          requestId: "retarget-to-c",
          expectedRevision: store.engineRouting("codex").revision,
        });
      } else if (action === "stop") {
        store.setMigrationIntentState(intent.id, "stopped", intent.revision);
      } else {
        store.rollbackConversationMigration(conversation.id, revision);
      }

      const restarted = new AgentRegistry(store.filename);
      expect(Object.values(restarted.snapshot().pendingSuccessorCleanups)).toMatchObject([{ receipt: { nativeId: `successor-${action}` } }]);
      const cleaned: string[] = [];
      const cleanupProvider: SuccessorProviderPort = {
        virtualSource: true,
        async create() { throw new SuccessorPendingError(); },
        async verify() {},
        async cleanup(value) { cleaned.push(value.nativeId); },
      };
      await reconcileMigrations(cleanupProvider, { async deliver() { return "delivered"; } }, restarted);
      await reconcileMigrations(cleanupProvider, { async deliver() { return "delivered"; } }, restarted);
      expect(cleaned).toEqual([`successor-${action}`]);
      expect(Object.keys(restarted.snapshot().pendingSuccessorCleanups)).toHaveLength(0);
      expect(restarted.conversation(conversation.id)?.generations).toHaveLength(1);
    }
  });

  test("retiring a migration target cleans its successor and drains held input once after restart", async () => {
    for (const engine of ["claude", "codex"] as const) {
      const store = registry();
      const sourcePath = `/retired-target-${engine}.jsonl`;
      store.reconcileConversations([{ ...observation(sourcePath, "a", "idle"), engine }]);
      const conversation = store.conversationForPath(sourcePath)!;
      const intent = store.commitMigrationIntent({
        engine,
        targetId: "b",
        origin: "manual",
        requestId: `retire-target-${engine}`,
        expectedRevision: store.engineRouting(engine).revision,
      });
      const revision = store.conversation(conversation.id)!.migration!.revision;
      store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
      store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
      const receipt: ProviderReceipt = {
        operationId: store.conversation(conversation.id)!.migration!.operationId,
        nativeId: `retired-successor-${engine}`,
        path: `/retired-successor-${engine}.jsonl`,
        continuityPaths: [],
        historyHash: `retired-hash-${engine}`,
        host: engine === "codex"
          ? { kind: "codex-app-server", identity: `retired-${engine}`, epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" }
          : { kind: "claude-stream", identity: `retired-${engine}`, epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
      };
      store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });
      store.holdDelivery(conversation.id, `continue-${engine}`, `client-${engine}`);

      store.retireAccount(engine, "b", "default");

      const restarted = new AgentRegistry(store.filename);
      expect(restarted.snapshot().migrationIntents[intent.id]?.state).toBe("stopped");
      expect(restarted.conversation(conversation.id)?.migration).toBeNull();
      expect(Object.values(restarted.snapshot().pendingSuccessorCleanups)).toMatchObject([{ receipt: { nativeId: `retired-successor-${engine}` } }]);
      expect(restarted.pendingDeliveries(conversation.id)).toMatchObject([{ state: "assigned", generationId: conversation.generations[0]!.id }]);

      const cleaned: string[] = [];
      const delivered: string[] = [];
      const cleanupProvider: SuccessorProviderPort = {
        virtualSource: true,
        async create() { throw new SuccessorPendingError(); },
        async verify() {},
        async cleanup(value) { cleaned.push(value.nativeId); },
      };
      const delivery = {
        async deliver({ delivery: item }: { delivery: { text: string } }) {
          delivered.push(item.text);
          return "delivered" as const;
        },
      };
      await reconcileMigrations(cleanupProvider, delivery, restarted);
      await reconcileMigrations(cleanupProvider, delivery, restarted);

      expect(cleaned).toEqual([`retired-successor-${engine}`]);
      expect(delivered).toEqual([`continue-${engine}`]);
      expect(restarted.pendingDeliveries(conversation.id)).toEqual([]);
    }
  });

  test("terminal migration races assign late accepted input to the current generation", async () => {
    for (const terminal of ["stop", "commit"] as const) {
      const store = registry();
      const sourcePath = `/late-${terminal}.jsonl`;
      store.reconcileConversations([observation(sourcePath, "a", "idle")]);
      const conversation = store.conversationForPath(sourcePath)!;
      const intent = store.commitMigrationIntent({
        engine: "codex",
        targetId: "b",
        origin: "manual",
        requestId: `late-${terminal}`,
        expectedRevision: store.engineRouting("codex").revision,
        scope: "all",
      });
      const revision = store.conversation(conversation.id)!.migration!.revision;
      if (terminal === "stop") {
        store.setMigrationIntentState(intent.id, "stopped", intent.revision);
      } else {
        store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
        store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
        store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], {
          phase: "verifying",
          providerReceipt: {
            operationId: store.conversation(conversation.id)!.migration!.operationId,
            nativeId: "late-successor",
            path: "/late-successor.jsonl",
            continuityPaths: [],
            historyHash: "late",
            host: { kind: "codex-app-server", identity: "late", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
          },
        });
        store.commitSuccessor(conversation.id, {
          id: "late-successor",
          path: "/late-successor.jsonl",
          accountId: "b",
        }, revision);
      }

      const queued = store.holdDelivery(conversation.id, `late-${terminal}`, `late-${terminal}`);
      const current = store.conversation(conversation.id)!.generations.at(-1)!;
      expect(queued).toMatchObject({ state: "assigned", generationId: current.id });
      const delivered: string[] = [];
      await drainHeldDeliveries(conversation.id, {
        async deliver({ delivery }) { delivered.push(delivery.text); return "delivered"; },
      }, store);
      expect(delivered).toEqual([`late-${terminal}`]);
    }
  });

  test("a migration that wins before delivery actuation fences the predecessor", () => {
    const store = registry();
    store.reconcileConversations([observation("/delivery-race.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/delivery-race.jsonl")!;
    const queued = store.holdDelivery(conversation.id, "race", "delivery-race");
    expect(queued.state).toBe("assigned");
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "migration-wins",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });

    expect(store.beginDeliveryAttempt(queued.id, queued.generationId!)).toBeNull();
    expect(store.requeueHeldDelivery(queued.id)).toMatchObject({ state: "held", generationId: null });
  });

  test("a delivery attempt that wins first keeps migration waiting until its outcome is durable", async () => {
    const store = registry();
    store.reconcileConversations([observation("/delivery-first.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/delivery-first.jsonl")!;
    const queued = store.holdDelivery(conversation.id, "delivery first", "delivery-first");
    expect(store.beginDeliveryAttempt(queued.id, queued.generationId!)).toMatchObject({ state: "delivery-uncertain" });
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "migration-second",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
    const counts = { create: 0, verify: 0 };

    await advanceConversationMigration(conversation.id, store, provider(["/after-delivery.jsonl"], counts));
    expect(counts.create).toBe(0);
    store.recordDeliveryOutcome(queued.id, "delivered");
    await advanceConversationMigration(conversation.id, store, provider(["/after-delivery.jsonl"], counts));
    expect(counts.create).toBe(1);
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("committed");
  });

  test("journal completion releases a queued send before waiting-turn migration readiness", async () => {
    const store = registry();
    store.reconcileConversations([observation("/queued-before-migration.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/queued-before-migration.jsonl")!;
    const queued = store.holdDelivery(conversation.id, "queued before migration", "queued-before-migration");
    expect(store.beginDeliveryAttempt(queued.id, queued.generationId!)).toMatchObject({ state: "delivery-uncertain" });
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "migrate-after-queued-send",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("waiting-turn");
    const counts = { create: 0, verify: 0 };
    let reconciles = 0;

    await reconcileMigrations(provider(["/after-queued-send.jsonl"], counts), {
      async deliver() {
        throw new Error("uncertain journal delivery was actuated again");
      },
      async reconcileUncertain({ delivery }) {
        reconciles += 1;
        expect(delivery.id).toBe(queued.id);
        return "delivered";
      },
    }, store);

    expect(reconciles).toBe(1);
    expect(counts.create).toBe(1);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
    expect(store.conversation(conversation.id)?.migration?.phase).toBe("committed");
  });

  test("successor commit invalidates migration previews while exact replay stays stable", async () => {
    const store = registry();
    store.reconcileConversations([observation("/preview-source.jsonl", "default", "idle")]);
    const conversation = store.conversationForPath("/preview-source.jsonl")!;
    const preview = await previewMigration("codex", "default", store);
    store.commitMigrationIntent({
      engine: "codex",
      targetId: "b",
      origin: "manual",
      requestId: "preview-successor",
      expectedRevision: preview.previewRevision,
      scope: "all",
    });
    const revision = store.conversation(conversation.id)!.migration!.revision;
    store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
    store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
    store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], {
      phase: "verifying",
      providerReceipt: {
        operationId: store.conversation(conversation.id)!.migration!.operationId,
        nativeId: "preview-successor",
        path: "/preview-successor.jsonl",
        continuityPaths: [],
        historyHash: "preview",
        host: { kind: "codex-app-server", identity: "preview", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
      },
    });
    const beforeCommit = store.engineRouting("codex").revision;
    const successor = { id: "preview-successor", path: "/preview-successor.jsonl", accountId: "b" };
    store.commitSuccessor(conversation.id, successor, revision);
    const afterCommit = store.engineRouting("codex").revision;

    expect(afterCommit).toBe(beforeCommit + 1);
    expect(() => store.commitMigrationIntent({
      engine: "codex",
      targetId: "default",
      origin: "manual",
      requestId: "stale-preview-after-successor",
      expectedRevision: preview.previewRevision,
      scope: "all",
    })).toThrow(MigrationRevisionError);
    store.commitSuccessor(conversation.id, successor, revision);
    expect(store.engineRouting("codex").revision).toBe(afterCommit);
  });

  test("a return-to-source retarget cleans a stale successor after clearing migration state", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "to-b-before-return", expectedRevision: store.engineRouting("codex").revision });
    const cleaned: string[] = [];
    let verified = false;
    const staleProvider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        input.recordContinuityPath("/stale-b.jsonl");
        store.commitMigrationIntent({ engine: "codex", targetId: "a", origin: "manual", requestId: "return-to-a", expectedRevision: store.engineRouting("codex").revision });
        return {
          operationId: input.operationId,
          nativeId: "stale-b",
          path: "/stale-b.jsonl",
          continuityPaths: ["/stale-b.jsonl"],
          historyHash: "stale",
          host: { kind: "codex-app-server", identity: "stale", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() { verified = true; },
      async cleanup(receipt) { cleaned.push(receipt.nativeId); },
    };

    const latest = await advanceConversationMigration(conversation.id, store, staleProvider);

    expect(latest.migration).toBeNull();
    expect(latest.generations).toHaveLength(1);
    expect(verified).toBeFalse();
    expect(cleaned).toEqual(["stale-b"]);
    expect(store.conversationForPath("/stale-b.jsonl")?.id).toBe(conversation.id);
  });

  test("stopping during successor startup fences the stale completion and cleans the discarded successor", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    const intent = store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "stop-during-start", expectedRevision: store.engineRouting("codex").revision });
    const cleaned: string[] = [];
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        store.setMigrationIntentState(intent.id, "stopped");
        input.recordContinuityPath("/discarded-successor.jsonl");
        return {
          operationId: input.operationId,
          nativeId: "discarded-successor",
          path: "/discarded-successor.jsonl",
          continuityPaths: [],
          historyHash: "discarded",
          host: { kind: "codex-app-server", identity: "discarded", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() { throw new Error("verification must not run after stop"); },
      async cleanup(receipt) { cleaned.push(receipt.nativeId); },
    };

    const settled = await advanceConversationMigration(conversation.id, store, provider);

    expect(settled.migration?.phase).toBe("rolled-back");
    expect(settled.generations).toHaveLength(1);
    expect(cleaned).toEqual(["discarded-successor"]);
    expect(store.conversationForPath("/discarded-successor.jsonl")?.id).toBe(conversation.id);
  });

  test("a verification failure releases the successor before returning a recoverable phase", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "verification-cleanup", expectedRevision: store.engineRouting("codex").revision });
    const cleaned: string[] = [];
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        return {
          operationId: input.operationId,
          nativeId: "failed-successor",
          path: "/failed-successor.jsonl",
          continuityPaths: [],
          historyHash: "failed",
          host: { kind: "codex-app-server", identity: "failed", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() { throw new Error("durability check failed"); },
      async cleanup(receipt) { cleaned.push(receipt.nativeId); },
    };

    const failed = await advanceConversationMigration(conversation.id, store, provider);

    expect(failed.migration).toMatchObject({
      phase: "failed-recoverable",
      errorCode: "provider-failed",
      error: "successor provider failed a recoverable preflight",
    });
    expect(JSON.stringify(failed.migration)).not.toContain("durability check failed");
    expect(cleaned).toEqual(["failed-successor"]);
  });
});
