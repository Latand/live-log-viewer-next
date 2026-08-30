import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import { StructuredCompactError } from "./engineHost";
import type { RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();

  load(threadId: string): RuntimeEvent[] {
    return structuredClone(this.events.get(threadId) ?? []);
  }

  append(threadId: string, event: RuntimeEvent): void {
    const events = this.events.get(threadId) ?? [];
    events.push(structuredClone(event));
    this.events.set(threadId, events);
  }
}

/** A minimal app-server double: only the handshake this control needs, plus
    `thread/compact/start` and the item lifecycle that proves compaction. */
class CompactAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5151;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly signals: NodeJS.Signals[] = [];
  compactError: string | null = null;
  holdCompact = false;
  private heldCompactIds: number[] = [];
  private turn = 0;

  constructor(readonly threadId = "compact-thread") {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  releaseCompact(error: string | null = null): void {
    const id = this.heldCompactIds.shift();
    if (id === undefined) throw new Error("no held compact request");
    if (error) this.respondError(id, error);
    else this.respond(id, {});
  }

  private accept(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (typeof method !== "string") return;
    this.requests.push({ method, params: (message.params ?? {}) as Record<string, unknown> });
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.146.0 (Linux)" });
    if (method === "account/read") {
      return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    }
    if (method === "model/list") {
      return this.respond(message.id, { data: [{ id: "gpt-5.3-codex-spark", isDefault: true, inputModalities: ["text"] }] });
    }
    if (method === "config/read") return this.respond(message.id, { config: { mcp_servers: {} } });
    if (method === "thread/start") {
      return this.respond(message.id, { thread: { id: this.threadId, path: `/sessions/${this.threadId}.jsonl`, turns: [] } });
    }
    if (method === "thread/read") {
      return this.respond(message.id, { thread: { id: this.threadId, path: `/sessions/${this.threadId}.jsonl`, turns: [] } });
    }
    if (method === "thread/turns/list") {
      return this.respond(message.id, { data: [], nextCursor: null });
    }
    if (method === "thread/items/list") {
      return this.respond(message.id, { data: [], nextCursor: null });
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      return;
    }
    if (method === "thread/compact/start") {
      if (this.compactError) return this.respondError(message.id, this.compactError);
      if (this.holdCompact) {
        this.heldCompactIds.push(message.id);
        return;
      }
      return this.respond(message.id, {});
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message } })}\n`);
  }
}

function spawnDouble(server: CompactAppServer) {
  return () => server as unknown as ChildProcessWithoutNullStreams;
}

async function startHost(server: CompactAppServer, options: Record<string, unknown> = {}) {
  return CodexAppServerHost.start({
    cwd: "/repo",
    requestTimeoutMs: 500,
    eventStore: new MemoryEventStore(),
    spawnProcess: spawnDouble(server),
    pidAlive: () => true,
    processIdentity: () => "5151:owned",
    ...options,
  });
}

test("compact issues thread/compact/start for the owned thread and never a prompt", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  const request = server.requests.find((candidate) => candidate.method === "thread/compact/start");
  expect(request).toBeDefined();
  expect(request!.params).toEqual({ threadId: server.threadId });
  /* Nothing about this control may enter the turn/message path. */
  expect(server.requests.some((candidate) => candidate.method === "turn/start" || candidate.method === "turn/steer")).toBe(false);

  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });

  expect(await compaction).toEqual({ compactionId: "compaction-one" });
  await host.release();
});

test("a compaction that has only started is not yet evidence", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);
  let settled = false;

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  void compaction.then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(10);

  /* Unrelated item traffic is not evidence that the thread was compacted. */
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "message-one", type: "agentMessage", text: "still working" },
  });
  /* The item carries no outcome — `{ id, type }` is its whole shape — so the
     lifecycle phase is the only signal. A started compaction is still running,
     and reporting success here would release queued sends into a compacting
     thread. */
  server.notify("item/started", {
    threadId: server.threadId,
    item: { id: "compaction-two", type: "contextCompaction" },
  });
  await Bun.sleep(10);
  expect(settled).toBe(false);

  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-two", type: "contextCompaction" },
  });
  expect(await compaction).toEqual({ compactionId: "compaction-two" });
  await host.release();
});

test("the compaction item the wire actually carries is accepted as evidence", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  /* `ContextCompactionThreadItem` is exactly `{ id, type }` in the app-server
     schema — no status, no turn, nothing else. The evidence path must settle on
     that payload and not on a richer one this repo invented. */
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-real", type: "contextCompaction" },
  });

  expect(await compaction).toEqual({ compactionId: "compaction-real" });
  await host.release();
});

test("the deprecated thread/compacted notification is accepted as corroborating evidence", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  /* Every compaction item observed locally came from auto-compaction inside a
     turn; nothing proves the app-server emits that lifecycle for a manual
     compact against an idle thread. If it only sends this notification, reading
     the item alone would leave the control timing out as unverified forever. */
  server.notify("thread/compacted", { threadId: server.threadId, turnId: "turn-1" });

  expect(await compaction).toEqual({ compactionId: null });
  await host.release();
});

test("a compacted notification for another thread is not evidence", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server, { compactEvidenceTimeoutMs: 60 });
  let settled = false;

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  void compaction.then(() => { settled = true; }, () => { settled = true; });
  await Bun.sleep(10);
  server.notify("thread/compacted", { threadId: "someone-elses-thread", turnId: "turn-1" });
  await Bun.sleep(10);

  expect(settled).toBe(false);
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });
  expect(await compaction).toEqual({ compactionId: "compaction-one" });
  await host.release();
});

test("a graceful release settles an in-flight compaction instead of leaving it to time out", async () => {
  const server = new CompactAppServer();
  /* The evidence budget is minutes in production; the point is that release
     must not wait for it. */
  const host = await startHost(server, { compactEvidenceTimeoutMs: 60_000 });

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  /* `close` skips `fail()` while the host is releasing, so this is the one
     teardown no other rejection path covers. Kill routes through here. */
  await host.release();

  const error = await compaction.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("unverified");
});

test("a concurrent compaction on the same thread is refused rather than issued twice", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const first = host.compact({ operationId: "op-one", threadId: server.threadId });
  await Bun.sleep(10);
  const second = await host.compact({ operationId: "op-two", threadId: server.threadId })
    .then(() => null, (reason: unknown) => reason);

  expect(second).toBeInstanceOf(StructuredCompactError);
  expect((second as StructuredCompactError).phase).toBe("refused");
  /* One thread compacts once at a time: a second request must not reach the
     engine, or both waiters would settle on whichever item arrived first. */
  expect(server.requests.filter((candidate) => candidate.method === "thread/compact/start")).toHaveLength(1);

  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });
  expect(await first).toEqual({ compactionId: "compaction-one" });
  await host.release();
});

test("a compaction that starts and never finishes terminalizes unverified", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server, { compactEvidenceTimeoutMs: 40 });

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  server.notify("item/started", {
    threadId: server.threadId,
    item: { id: "compaction-two", type: "contextCompaction" },
  });

  const error = await compaction.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("unverified");
  await host.release();
});

test("a failed compaction terminalizes without killing the reusable app-server host", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-failed-compact", threadId: server.threadId });
  await Bun.sleep(10);
  server.notify("turn/started", {
    threadId: server.threadId,
    turn: { id: "compact-turn" },
  });
  server.notify("item/started", {
    threadId: server.threadId,
    turnId: "compact-turn",
    item: { id: "compaction-failed", type: "contextCompaction" },
  });
  server.notify("thread/status/changed", {
    threadId: server.threadId,
    status: { type: "systemError" },
  });
  server.notify("error", {
    threadId: server.threadId,
    turnId: "compact-turn",
    error: { message: "remote compaction failed oauth_token=must-stay-private" },
    willRetry: false,
  });
  server.notify("turn/completed", {
    threadId: server.threadId,
    turn: {
      id: "compact-turn",
      status: "failed",
      error: { message: "remote compaction failed oauth_token=must-stay-private" },
    },
  });

  const error = await compaction.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("refused");
  expect((error as Error).message).toContain("remote compaction failed");
  expect((error as Error).message).not.toContain("must-stay-private");
  expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
  expect(server.signals).toEqual([]);

  const delivery = host.send({ id: "after-failed-compact", text: "continue" });
  await Bun.sleep(10);
  server.notify("item/completed", {
    threadId: server.threadId,
    turnId: "turn-1",
    item: { type: "userMessage", clientId: "after-failed-compact", content: [{ type: "input_text", text: "continue" }] },
  });
  expect(await delivery).toEqual({ outcome: "turn-started", turnId: "turn-1" });
  expect(server.signals).toEqual([]);
  await host.release();
});

test("an interrupted compaction terminalizes unverified and leaves the host reusable", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-interrupted-compact", threadId: server.threadId });
  await Bun.sleep(10);
  server.notify("turn/started", {
    threadId: server.threadId,
    turn: { id: "compact-turn" },
  });
  server.notify("item/started", {
    threadId: server.threadId,
    turnId: "compact-turn",
    item: { id: "compaction-interrupted", type: "contextCompaction" },
  });
  server.notify("turn/completed", {
    threadId: server.threadId,
    turn: { id: "compact-turn", status: "interrupted" },
  });

  const error = await compaction.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("unverified");
  expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
  expect(server.signals).toEqual([]);

  /* Late evidence cannot re-settle the completed operation or poison the next
     turn after its pending row has been removed. */
  server.notify("item/completed", {
    threadId: server.threadId,
    turnId: "compact-turn",
    item: { id: "compaction-interrupted", type: "contextCompaction" },
  });
  const delivery = host.send({ id: "after-interrupted-compact", text: "continue" });
  await Bun.sleep(10);
  server.notify("item/completed", {
    threadId: server.threadId,
    turnId: "turn-1",
    item: { type: "userMessage", clientId: "after-interrupted-compact", content: [{ type: "input_text", text: "continue" }] },
  });
  expect(await delivery).toEqual({ outcome: "turn-started", turnId: "turn-1" });
  expect(server.signals).toEqual([]);
  await host.release();
});

test("evidence that arrives before a failing start response still counts", async () => {
  const server = new CompactAppServer();
  server.holdCompact = true;
  const host = await startHost(server);

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });
  await Bun.sleep(10);
  /* The request leg fails only after the app-server already reported the
     compaction. A verified fact must not be overwritten by a late error. */
  server.releaseCompact("the compact request stream was reset");

  expect(await compaction).toEqual({ compactionId: "compaction-one" });
  await host.release();
});

test("a slow compact start does not fence the host on the default request budget", async () => {
  const server = new CompactAppServer();
  server.holdCompact = true;
  /* The host's ordinary mutating-RPC budget; the compact request must be
     budgeted like the compaction it starts, not like an ordinary call. */
  const host = await startHost(server, { requestTimeoutMs: 30, compactEvidenceTimeoutMs: 5_000 });

  const compaction = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(120);

  expect((await host.health()).status).not.toBe("dead");
  server.releaseCompact();
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });
  expect(await compaction).toEqual({ compactionId: "compaction-one" });
  await host.release();
});

test("a refused compact request reports a known-failed outcome", async () => {
  const server = new CompactAppServer();
  server.compactError = "compaction is unavailable for this thread";
  const host = await startHost(server);

  const error = await host.compact({ operationId: "op-compact", threadId: server.threadId })
    .then(() => null, (reason: unknown) => reason);

  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("refused");
  expect((error as Error).message).toContain("compaction is unavailable");
  await host.release();
});

test("evidence that never arrives terminalizes as an unverified outcome", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server, { compactEvidenceTimeoutMs: 30 });

  const error = await host.compact({ operationId: "op-compact", threadId: server.threadId })
    .then(() => null, (reason: unknown) => reason);

  expect(error).toBeInstanceOf(StructuredCompactError);
  expect((error as StructuredCompactError).phase).toBe("unverified");
  await host.release();
});

test("compact refuses a foreign thread and an active turn", async () => {
  const server = new CompactAppServer();
  const host = await startHost(server);

  const foreign = await host.compact({ operationId: "op-foreign", threadId: "someone-elses-thread" })
    .then(() => null, (reason: unknown) => reason);
  expect(foreign).toBeInstanceOf(StructuredCompactError);
  expect((foreign as Error).message).toContain("thread");
  expect((foreign as StructuredCompactError).phase).toBe("refused");

  /* The send is left in flight on purpose: this is the state a compact control
     must refuse rather than steer. */
  void host.send({ id: "message-one", text: "start a turn" }).catch(() => undefined);
  await Bun.sleep(20);
  expect((await host.health()).activeTurnRef).toBe("turn-1");

  const busy = await host.compact({ operationId: "op-busy", threadId: server.threadId })
    .then(() => null, (reason: unknown) => reason);
  expect(busy).toBeInstanceOf(StructuredCompactError);
  expect((busy as StructuredCompactError).phase).toBe("refused");
  expect(server.requests.filter((candidate) => candidate.method === "thread/compact/start")).toHaveLength(0);
  await host.release();
});

test("a repeated compact for one operation awaits the same in-flight control", async () => {
  const server = new CompactAppServer();
  server.holdCompact = true;
  const host = await startHost(server);

  const first = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);
  const second = host.compact({ operationId: "op-compact", threadId: server.threadId });
  await Bun.sleep(10);

  expect(server.requests.filter((candidate) => candidate.method === "thread/compact/start")).toHaveLength(1);
  server.releaseCompact();
  server.notify("item/completed", {
    threadId: server.threadId,
    item: { id: "compaction-one", type: "contextCompaction" },
  });

  expect(await first).toEqual({ compactionId: "compaction-one" });
  expect(await second).toEqual({ compactionId: "compaction-one" });
  await host.release();
});
