import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { RuntimeJournal } from "@/runtime-host/journal";
import { NativeCodexQueue, NativeQueueProtocolRefusal, type NativeQueuedSubmission } from "./nativeCodexQueue";
import { NativeQueueExecutor } from "./nativeQueueExecutor";
import type { EngineHost } from "./engineHost";
import type { RuntimeHostClient } from "./client";
import type { NativeQueueCommand, NativeQueueProof, NativeQueueRecord } from "./nativeQueueContracts";
import { parseRuntimeCommand } from "./commands";
import { handleNativeQueue } from "./nativeQueueHttp";

const conversationId = "conversation_native";
const binding = { threadId: "thread-native", accountId: "account-a" };
function makeJournal(filename = ":memory:") {
  const journal = new RuntimeJournal(filename, { structuredHosts: true });
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
    host: "hosted", turn: "running", activeTurnId: "active-a", accountId: binding.accountId,
    capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
  return journal;
}
function command(id: string, extra: Partial<NativeQueueCommand> = {}): NativeQueueCommand & { operationId: string } {
  return parseRuntimeCommand("native-queue", { kind: "native-queue", conversationId, operationId: id,
    idempotencyKey: id, action: "add", text: "queued text", binding, ...extra }) as NativeQueueCommand & { operationId: string };
}
function fixture(journal = makeJournal()) {
  let active: string | null = "active-a";
  let liveBinding = binding;
  let next = 0;
  const calls: string[] = [];
  let items: NativeQueuedSubmission[] = [];
  let loseAdd = false;
  let raceDelete = false;
  let refuseDelete = false;
  let proof: NativeQueueProof | null = null;
  const queue = new NativeCodexQueue({ rpc: async (method, params) => {
    calls.push(method);
    if (method === "thread/queue/list") return { data: items, nextCursor: null };
    if (method === "thread/queue/add") {
      const queuedSubmission = { id: `native-${++next}`, clientUserMessageId: params.clientUserMessageId as string, input: params.input as NativeQueuedSubmission["input"] };
      items.push(queuedSubmission);
      if (loseAdd) throw new Error("lost add reply");
      return { queuedSubmission };
    }
    if (method === "thread/queue/update") {
      const item = items.find(i => i.id === params.queuedSubmissionId)!;
      item.input = params.input as NativeQueuedSubmission["input"];
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/delete") {
      if (refuseDelete) return { deleted: false };
      items = items.filter(i => i.id !== params.queuedSubmissionId);
      if (raceDelete) active = "active-b";
      return { deleted: true };
    }
    if (method === "thread/queue/reorder") return {};
    if (method === "thread/queue/start") return { turn: { id: "started", items: [], status: "inProgress" } };
    throw new Error("unexpected method");
  } }, binding.threadId);
  const client = {
    command: async (c: NativeQueueCommand) => journal.executeOperation(c),
    operationStatus: async (id: string) => journal.operationResult(id),
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
    nativeQueueTransition: async (id: string, t: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, t),
  } as RuntimeHostClient;
  const host = {
    health: async () => ({ status: active ? "active" : "idle", activeTurnRef: active }),
    nativeQueue: {
      queue,
      prepare: async (_entry: NativeQueueRecord, v: NativeQueueRecord["versions"][number]) => [{ type: "text" as const, text: `${v.text} version=${v.revision}` }],
      evidence: async () => proof,
      sendWithdrawn: async (_entry: NativeQueueRecord, expected: string | null) => {
        if (active !== expected) throw new NativeQueueProtocolRefusal(-1, "stale-turn");
        calls.push(expected ? "turn/steer" : "turn/start");
        return { turnId: expected ?? "started" };
      },
    },
  } as unknown as EngineHost;
  const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => liveBinding });
  return { journal, client, executor, calls, queue, get items() { return items; },
    loseAdd: () => { loseAdd = true; }, race: () => { raceDelete = true; }, refuseDelete: () => { refuseDelete = true; },
    switchAccount: () => { liveBinding = { ...binding, accountId: "account-b" }; },
    prove: () => {
      const entry = journal.nativeQueueRead(conversationId)[0]!;
      proof = { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: entry.revision,
        turnId: "canonical-turn", itemId: "canonical-item", input: entry.versions.at(-1)!.input! };
    } };
}

test("native add keeps Viewer/client/native IDs distinct; duplicate Viewer admission never adds twice", async () => {
  const f = fixture();
  const c = command("op-add");
  f.journal.executeOperation(c);
  await f.executor.execute(c);
  expect(f.journal.executeOperation(c).replayed).toBeTrue();
  await f.executor.execute(c);
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  expect(entry).toMatchObject({ entryId: "op-add", clientUserMessageId: "op-add", nativeSubmissionId: "native-1", state: "queued", proof: null });
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  expect(f.journal.operationResult("op-add")?.receipt.status).toBe("applied");
  f.journal.close();
});

test("lost add reply survives restart and account change without a second native mutation", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nq-")), "journal.sqlite");
  const f = fixture(makeJournal(filename));
  const c = command("op-lost"); f.loseAdd();
  f.journal.executeOperation(c); await f.executor.execute(c);
  expect(f.items).toHaveLength(1);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("uncertain");
  f.journal.close();
  const next = fixture(new RuntimeJournal(filename, { structuredHosts: true })); next.switchAccount();
  await next.executor.execute(c); await next.executor.reconcile(conversationId);
  expect(next.calls).toEqual([]);
  expect(next.journal.nativeQueueRead(conversationId)[0]?.mutationOperationId).toBe(c.operationId);
  expect(() => next.journal.retryOperation(c.operationId)).toThrow("does not support retry");
  next.journal.close();
});

test("edited native entry retains both payload versions; only canonical changed payload proves delivery", async () => {
  const f = fixture(); const add = command("op-version");
  f.journal.executeOperation(add); await f.executor.execute(add);
  const edit = command("op-edit", { action: "update", entryId: add.operationId, expectedRevision: 1, text: "changed", runtime: { model: "requested-model" } });
  f.journal.executeOperation(edit); await f.executor.execute(edit);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.versions.map(v => v.text)).toEqual(["queued text", "changed"]);
  await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  f.prove(); await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "delivered", dispatchedRevision: 2 });
  expect(f.journal.operationResult(add.operationId)?.receipt).toMatchObject({ text: "changed", nativeQueue: { entryId: add.operationId, dispatchedRevision: 2 } });
  expect(() => f.journal.executeOperation(command("edit-after-dispatch", { action: "update", entryId: add.operationId, expectedRevision: 2 }))).toThrow("frozen or unresolved");
  f.journal.close();
});

test("queued Send now withdraws before steer, and a turn boundary sends zero duplicate instructions", async () => {
  for (const race of [false, true]) {
    const f = fixture(); const add = command("op-send-now"); f.journal.executeOperation(add); await f.executor.execute(add);
    if (race) f.race();
    const send = command("op-control", { action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: "active-a" });
    f.journal.executeOperation(send); await f.executor.execute(send);
    expect(f.calls).toEqual(race ? ["thread/queue/add", "thread/queue/delete"] : ["thread/queue/add", "thread/queue/delete", "turn/steer"]);
    expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe(race ? "withdrawn" : "dispatching");
    expect(f.journal.nativeQueueRead(conversationId)[0]?.versions[0]?.text).toBe("queued text");
    f.journal.close();
  }
});

test("queue disappearance or deleted=false never authorizes steering or delivery", async () => {
  const f = fixture(); const add = command("op-missing"); f.journal.executeOperation(add); await f.executor.execute(add); f.refuseDelete();
  const send = command("op-no-withdrawal", { action: "send-now", entryId: add.operationId, expectedRevision: 1, turnId: "active-a" });
  f.journal.executeOperation(send); await f.executor.execute(send);
  expect(f.calls).toEqual(["thread/queue/add", "thread/queue/delete"]);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "uncertain", proof: null });
  f.journal.close();
});

test("queue HTTP admits immediately on the populated fixture without waiting for native dispatch", async () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) f.journal.append({ scope: `session:board-${i}`, kind: "session-status", payload: { host: "hosted", turn: "idle" } });
  let kicks = 0;
  const start = performance.now();
  const response = await handleNativeQueue(new NextRequest("http://localhost/api/runtime/queue", { method: "POST", headers: { host: "localhost" }, body: JSON.stringify(command("op-http")) }), { client: () => f.client, enabled: () => true, kick: () => { kicks++; }, admitImages: () => ({ images: [], error: null }), storeImages: () => [] });
  expect(response.status).toBe(202); expect(kicks).toBe(1); expect(f.calls).toEqual([]);
  expect(performance.now() - start).toBeLessThan(250);
  const body = await response.json(); expect(body.receipt.status).toBe("queued");
  f.journal.close();
});

test("the queue read answers the journal's entries beside Codex's own snapshot", async () => {
  /* What the panel reads. Both halves are needed and neither substitutes for the
     other: the journal knows about a mutation the queue has not acknowledged,
     and only the queue knows the order. */
  const f = fixture();
  const add = command("op-read");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  const response = await handleNativeQueue(
    new NextRequest(`http://localhost/api/runtime/queue?conversationId=${conversationId}`, { headers: { host: "localhost" } }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: null }), storeImages: () => [],
      /* The production reader refreshes and falls back to the cached read; a
         cached read alone has never completed a list pass and answers null. */
      nativeSnapshot: async () => f.queue.refresh(),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries.map((entry: { entryId: string }) => entry.entryId)).toEqual(["op-read"]);
  expect(body.native.items.map((item: { clientUserMessageId: string }) => item.clientUserMessageId))
    .toEqual([body.entries[0].clientUserMessageId]);
  f.journal.close();
});

test("a queue read that cannot see Codex still answers the journal, marked stale", async () => {
  /* A failed native read must not empty the panel: what the Viewer admitted is
     still true, and the snapshot says its order is the last one seen. */
  const f = fixture();
  const add = command("op-stale");
  f.journal.executeOperation(add);
  await f.executor.execute(add);
  const response = await handleNativeQueue(
    new NextRequest(`http://localhost/api/runtime/queue?conversationId=${conversationId}`, { headers: { host: "localhost" } }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: null }), storeImages: () => [],
      nativeSnapshot: async () => ({ threadId: binding.threadId, items: null, stale: true }),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.entries).toHaveLength(1);
  expect(body.native).toMatchObject({ stale: true, items: null });
  f.journal.close();
});

test("a queue read refuses an identity that is not a conversation", async () => {
  const f = fixture();
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue?conversationId=../etc", { headers: { host: "localhost" } }),
    { client: () => f.client, enabled: () => true, kick: () => {}, admitImages: () => ({ images: [], error: null }), storeImages: () => [] },
  );
  expect(response.status).toBe(400);
  f.journal.close();
});

test("a queued message carries attachment bytes the same way an ordinary send does", async () => {
  /* #1629: the composer stages attachments as bytes. The queue route admits and
     content-addresses them here, so the command itself carries refs — the same
     road `/api/runtime/send` takes, and the reason the command's own size ceiling
     bounds the command rather than the attachment. */
  const f = fixture();
  const stored: unknown[] = [];
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue", {
      method: "POST", headers: { host: "localhost" },
      body: JSON.stringify({
        kind: "native-queue", conversationId, operationId: "op-image", idempotencyKey: "op-image",
        action: "add", text: "look at this", binding,
        images: [{ base64: png, mime: "image/png" }],
      }),
    }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: (images) => ({ images: images as never[], error: null }),
      storeImages: (uploads) => {
        stored.push(...uploads);
        return [{ sha256: "a".repeat(64), mime: "image/png", bytes: 16 }];
      },
    },
  );
  expect(response.status).toBe(202);
  expect(stored).toHaveLength(1);
  const admitted = f.journal.nativeQueueRead(conversationId).find(entry => entry.entryId === "op-image");
  expect(admitted?.versions[0]?.images).toEqual([{ sha256: "a".repeat(64), mime: "image/png", bytes: 16 }]);
  f.journal.close();
});

test("a refused attachment refuses the whole queue admission, with the reason", async () => {
  const f = fixture();
  const response = await handleNativeQueue(
    new NextRequest("http://localhost/api/runtime/queue", {
      method: "POST", headers: { host: "localhost" },
      body: JSON.stringify({
        kind: "native-queue", conversationId, operationId: "op-bad-image", idempotencyKey: "op-bad-image",
        action: "add", text: "look at this", binding, images: [{ base64: "!!!", mime: "image/png" }],
      }),
    }),
    {
      client: () => f.client, enabled: () => true, kick: () => {},
      admitImages: () => ({ images: [], error: { error: "runtime image base64 is invalid", status: 400 } }),
      storeImages: () => [],
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("base64 is invalid");
  expect(f.journal.nativeQueueRead(conversationId)).toEqual([]);
  f.journal.close();
});

test("native parser preserves null fence and nullable tier fields, rejects missing fences and duplicate reorder IDs", () => {
  expect(command("op-settings", { runtime: { serviceTier: null, serviceTierForTurn: "priority" } }).runtime).toEqual({ serviceTier: null, serviceTierForTurn: "priority" });
  expect(() => command("op-no-fence", { action: "send-now", entryId: "root", expectedRevision: 1 })).toThrow("fence");
  expect(() => command("op-order", { action: "reorder", queuedSubmissionIds: ["same", "same"] })).toThrow("queuedSubmissionIds");
});

test("ordinary explicit Codex queue send transfers dispatch to native and retains its original receipt", async () => {
  const f = fixture();
  const send = parseRuntimeCommand("send", { conversationId, operationId: "ordinary-queue", idempotencyKey: "ordinary-key", text: "native owned", policy: "queue" });
  const admitted = f.journal.executeOperation(send);
  expect(admitted.receipt).toMatchObject({ kind: "send", status: "queued" });
  const effect = f.journal.effectBatch(100).find(e => e.kind === "runtime.native-queue")!;
  expect(effect).toBeTruthy();
  expect(f.journal.effectBatch(100).some(e => e.kind === "runtime.send")).toBeFalse();
  await f.executor.execute(effect.payload as unknown as NativeQueueCommand & { operationId: string });
  expect(f.journal.operationResult(admitted.operationId)?.receipt.status).toBe("queued");
  expect(f.journal.effectBatch(100)).toHaveLength(0);
  expect(() => f.journal.retryOperation(admitted.operationId)).toThrow("native queue");
  f.prove(); await f.executor.reconcile(conversationId);
  expect(f.journal.operationResult(admitted.operationId)?.receipt.status).toBe("delivered");
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("two executors competing for the same admitted native add perform one write", async () => {
  const f = fixture(); const add = command("op-concurrent"); f.journal.executeOperation(add);
  await Promise.all([f.executor.execute(add), f.executor.execute(add)]);
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  f.journal.close();
});

test("native canonical proof must retain original client, version, content and thread", async () => {
  const f = fixture(); const add = command("op-proof"); f.journal.executeOperation(add); await f.executor.execute(add);
  const entry = f.journal.nativeQueueRead(conversationId)[0]!;
  const proof: NativeQueueProof = { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: 1,
    turnId: "turn", itemId: "item", input: entry.versions[0]!.input! };
  for (const changed of [{ ...proof, threadId: "wrong" }, { ...proof, clientUserMessageId: "wrong" }, { ...proof, revision: 2 }, { ...proof, input: [{ type: "text" as const, text: "wrong" }] }]) {
    expect(() => f.journal.nativeQueueTransition(add.operationId, { phase: "proven", proof: changed })).toThrow("canonical proof mismatch");
    expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("queued");
  }
  f.journal.close();
});

test("an account change before dispatch refuses the new write and keeps payload versions", async () => {
  const f = fixture(); const add = command("op-account"); f.journal.executeOperation(add); f.switchAccount();
  await f.executor.execute(add);
  expect(f.calls).toEqual([]);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "refused", versions: [{ text: "queued text" }] });
  f.journal.close();
});

test("positive native deletion cancels the original entry receipt while retaining payload history", async () => {
  const f = fixture(); const add = command("op-remove"); f.journal.executeOperation(add); await f.executor.execute(add);
  const remove = command("op-delete", { action: "delete", entryId: add.operationId, expectedRevision: 1 });
  f.journal.executeOperation(remove); await f.executor.execute(remove); await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "removed", proof: null, versions: [{ text: "queued text" }] });
  expect(f.journal.operationResult(add.operationId)?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
  f.journal.close();
});

test("a unique live queue observation recovers a lost add acknowledgement without claiming delivery or retrying", async () => {
  const f = fixture(); f.loseAdd(); const add = command("op-observed");
  f.journal.executeOperation(add); await f.executor.execute(add);
  expect(f.journal.nativeQueueRead(conversationId)[0]?.state).toBe("uncertain");
  await f.executor.reconcile(conversationId);
  expect(f.journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "queued", nativeSubmissionId: "native-1", mutationOperationId: null, proof: null });
  expect(f.journal.operationResult(add.operationId)?.receipt.status).toBe("applied");
  expect(f.calls.filter(c => c.endsWith("/add"))).toHaveLength(1);
  f.journal.close();
});

test("explicit null and string turn fences survive admission without being rebound to the active turn", () => {
  const journal = makeJournal();
  for (const kind of ["send", "steer", "interrupt"] as const) {
    const c = parseRuntimeCommand(kind, { conversationId, operationId: `${kind}-null`, idempotencyKey: `${kind}-null`, text: "fenced", turnId: null });
    expect(journal.executeOperation(c).receipt).toMatchObject({ status: "rejected", reason: "stale-turn" });
  }
  expect(journal.effectBatch(100)).toHaveLength(0);
  const matching = parseRuntimeCommand("steer", { conversationId, idempotencyKey: "matching", text: "fenced", turnId: "active-a" });
  expect(journal.executeOperation(matching).receipt.status).toBe("pending");
  expect(journal.effectBatch(100)[0]?.payload.turnId).toBe("active-a");
  journal.close();
});

test("native queue profile requests and image versions survive reopening without per-entry dispatch overrides", async () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nqp-")), "journal.sqlite");
  const f = fixture(makeJournal(filename));
  const images = [{ sha256: "a".repeat(64), mime: "image/png" as const, bytes: 8 }];
  const first = command("profile-one", { images, runtime: { model: "model-one", effort: "high", serviceTierForTurn: "priority" } });
  const second = command("profile-two", { runtime: { model: "model-two", effort: "low", serviceTier: null } });
  f.journal.executeOperation(first); await f.executor.execute(first);
  f.journal.executeOperation(second); await f.executor.execute(second);
  f.journal.close();
  const reopened = new RuntimeJournal(filename, { structuredHosts: true });
  const entries = reopened.nativeQueueRead(conversationId);
  expect(entries.map(e => e.profilePolicy)).toEqual(["thread-at-dispatch", "thread-at-dispatch"]);
  expect(entries.map(e => e.versions[0]?.requestedRuntime)).toEqual([first.runtime, second.runtime]);
  expect(entries[0]?.versions[0]?.images).toEqual(images);
  reopened.close();
});


test("unknown native queue capability cannot admit a second scheduler through ordinary queue policy", () => {
  const journal = makeJournal();
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    capabilities: { steer: true, structuredAttention: true, nativeQueue: false },
    diagnostics: { executable: "codex", version: "0.154.0", nativeQueue: false, queueCapability: "unknown", authRecovery: "unknown" },
  } });
  const c = parseRuntimeCommand("send", { conversationId, idempotencyKey: "unknown-capability", text: "queued", policy: "queue" });
  expect(journal.executeOperation(c).receipt).toMatchObject({ status: "rejected", reason: "native-queue-capability-unknown" });
  expect(journal.effectBatch(100)).toEqual([]);
  expect(journal.nativeQueueRead(conversationId)).toEqual([]);
  journal.close();
});
