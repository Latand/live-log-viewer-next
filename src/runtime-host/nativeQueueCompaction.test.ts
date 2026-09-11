import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RuntimeJournal } from "./journal";
import { RuntimeHost } from "./host";
import { serveRuntimeHost } from "./socket";
import { NativeCodexQueue, NativeQueueProtocolRefusal, type NativeQueuedSubmission } from "@/lib/runtime/nativeCodexQueue";
import { NativeQueueExecutor } from "@/lib/runtime/nativeQueueExecutor";
import { parseRuntimeCommand } from "@/lib/runtime/commands";
import { UnixRuntimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import type { EngineHost } from "@/lib/runtime/engineHost";
import type { NativeQueueCommand, NativeQueueProof, NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";

/* #1664: a native queue entry outlives the `operations` row of the send that
   owns it once journal compaction passes the row's last receipt. These run a
   real journal on disk with a tiny event budget, so compaction happens inside
   the test exactly as it does in production after 20 000 events. */

const conversationId = "conversation_compacted";
const binding = { threadId: "thread-compacted", accountId: "account-a" };
const MAX_EVENTS = 12;

function journalFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nqc-")), "journal.sqlite");
}

function open(filename: string, maxEvents = MAX_EVENTS): RuntimeJournal {
  return new RuntimeJournal(filename, { structuredHosts: true, maxEvents });
}

function nativeSession(journal: RuntimeJournal, turn: { activeTurnId: string | null } = { activeTurnId: "active-a" }): void {
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
    host: "hosted", turn: turn.activeTurnId ? "running" : "idle", activeTurnId: turn.activeTurnId, accountId: binding.accountId,
    capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
}

/** Unrelated traffic that pushes the compaction anchor past every operation row. */
function churn(journal: RuntimeJournal, count = MAX_EVENTS * 3): void {
  for (let index = 0; index < count; index++) {
    journal.append({ scope: `session:churn-${index}`, kind: "session-status", payload: { host: "hosted", turn: "idle" } });
  }
}

/** The residue a journal compacted BEFORE this fix left behind: the entry, and no operation. */
function compactedBeforeHolds(filename: string, operationId: string): void {
  const db = new Database(filename);
  db.query("DELETE FROM operations WHERE operation_id = ?").run(operationId);
  db.query("DELETE FROM entities WHERE kind = 'operation' AND id = ?").run(operationId);
  db.query("DELETE FROM outbox WHERE id = ?").run(`effect:${operationId}`);
  db.close();
}

function rawEntry(journal: RuntimeJournal, entryId: string): string {
  return JSON.stringify(journal.nativeQueueRead(conversationId).find(row => row.entryId === entryId) ?? null);
}

function tailSeq(filename: string): number {
  const db = new Database(filename, { readonly: true });
  const seq = Number(db.query<{ value: string }, []>("SELECT value FROM journal_meta WHERE key = 'seq'").get()!.value);
  db.close();
  return seq;
}

function eventsAfter(filename: string, seq: number): Array<{ kind: string; scope: string; payload: unknown }> {
  const db = new Database(filename, { readonly: true });
  const rows = db.query<{ kind: string; scope: string; payload_json: string }, [number]>("SELECT kind, scope, payload_json FROM events WHERE seq > ? ORDER BY seq").all(seq);
  db.close();
  return rows.map(row => ({ kind: row.kind, scope: row.scope, payload: JSON.parse(row.payload_json) }));
}

function holds(filename: string): string[] {
  const db = new Database(filename, { readonly: true });
  const rows = db.query<{ operation_id: string }, []>("SELECT operation_id FROM native_queue_operation_holds ORDER BY operation_id").all();
  db.close();
  return rows.map(row => row.operation_id);
}

function harness(journal: RuntimeJournal) {
  const writes: string[] = [];
  let items: NativeQueuedSubmission[] = [];
  let next = 0;
  let active: string | null = "active-a";
  let liveBinding = binding;
  let loseNextReply = false;
  let evidence: () => Promise<NativeQueueProof | null> = async () => null;
  const queue = new NativeCodexQueue({ rpc: async (method, params) => {
    if (method === "thread/queue/list") return { data: items, nextCursor: null };
    writes.push(method);
    const lose = loseNextReply;
    loseNextReply = false;
    let result: unknown;
    if (method === "thread/queue/add") {
      const queuedSubmission = { id: `native-${++next}`, clientUserMessageId: params.clientUserMessageId as string, input: params.input as NativeQueuedSubmission["input"] };
      items.push(queuedSubmission);
      result = { queuedSubmission };
    } else if (method === "thread/queue/update") {
      const item = items.find(row => row.id === params.queuedSubmissionId)!;
      item.input = params.input as NativeQueuedSubmission["input"];
      result = { queuedSubmission: item };
    } else if (method === "thread/queue/delete") {
      items = items.filter(row => row.id !== params.queuedSubmissionId);
      result = { deleted: true };
    } else if (method === "thread/queue/start") {
      items = items.filter(row => row.id !== params.queuedSubmissionId);
      result = { turn: { id: "started-turn", items: [], status: "inProgress" } };
    } else throw new NativeQueueProtocolRefusal(-1, `unexpected native write ${method}`);
    if (lose) throw new Error("lost native reply");
    return result;
  } }, binding.threadId);
  const client = {
    command: async (command: NativeQueueCommand) => journal.executeOperation(command),
    operationStatus: async (id: string) => journal.operationResult(id),
    nativeQueueRead: async (id: string) => journal.nativeQueueRead(id),
    nativeQueueTransition: async (id: string, transition: Parameters<RuntimeJournal["nativeQueueTransition"]>[1]) => journal.nativeQueueTransition(id, transition),
    nativeQueueSettleCompacted: async (request: Parameters<RuntimeJournal["nativeQueueSettleCompacted"]>[0]) => journal.nativeQueueSettleCompacted(request),
  } as RuntimeHostClient;
  const host = {
    health: async () => ({ status: active ? "active" : "idle", activeTurnRef: active }),
    nativeQueue: {
      queue,
      prepare: async (_entry: NativeQueueRecord, version: NativeQueueRecord["versions"][number]) => [{ type: "text" as const, text: `${version.text} v${version.revision}` }],
      evidence: async () => evidence(),
      sendWithdrawn: async () => { throw new Error("no withdrawn send in this fixture"); },
    },
  } as unknown as EngineHost;
  const settled: NativeQueueRecord[] = [];
  const executor = new NativeQueueExecutor({ client, resolveHost: () => host, binding: () => liveBinding, settled: entry => { settled.push(entry); } });
  const proofFor = (entryId: string, change: Partial<NativeQueueProof> = {}): NativeQueueProof => {
    const entry = journal.nativeQueueRead(conversationId).find(row => row.entryId === entryId)!;
    const version = entry.versions.find(row => row.revision === (entry.dispatchedRevision ?? entry.revision))!;
    return { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId, revision: version.revision,
      turnId: entry.dispatchedTurnId ?? "canonical-turn", itemId: `item-${entryId}`, input: version.input!, ...change };
  };
  return {
    executor, client, writes, settled, proofFor,
    get items() { return items; },
    loseNextReply() { loseNextReply = true; },
    idle() { active = null; nativeSession(journal, { activeTurnId: null }); },
    switchAccount() { liveBinding = { ...binding, accountId: "account-b" }; },
    /** Canonical history as the host reader would answer it, per entry. */
    canonical(answer: (entry: NativeQueueRecord) => NativeQueueProof | null | Promise<NativeQueueProof | null>) {
      evidence = async () => null;
      (host.nativeQueue as { evidence: (entry: NativeQueueRecord) => Promise<NativeQueueProof | null> }).evidence = async entry => answer(entry);
    },
  };
}

function nativeEffect(journal: RuntimeJournal, operationId: string): NativeQueueCommand & { operationId: string } {
  const effect = journal.effectBatch(100, ["runtime.native-queue"]).find(row => row.id === `effect:${operationId}`);
  if (!effect) throw new Error(`no native effect for ${operationId}`);
  return effect.payload as unknown as NativeQueueCommand & { operationId: string };
}

function mappedSend(id: string, text = `message ${id}`) {
  return parseRuntimeCommand("send", { conversationId, operationId: id, idempotencyKey: `key-${id}`, text, policy: "queue" });
}

function nativeCommand(id: string, extra: Partial<NativeQueueCommand> = {}): NativeQueueCommand & { operationId: string } {
  return parseRuntimeCommand("native-queue", { kind: "native-queue", conversationId, operationId: id, idempotencyKey: `key-${id}`,
    action: "add", text: `native ${id}`, binding, ...extra }) as NativeQueueCommand & { operationId: string };
}

test("an ordinary queued send mapped to native keeps its operation through compaction and restart, then converges on canonical proof", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  journal.executeOperation(mappedSend("op-mapped"));
  await harness(journal).executor.execute(nativeEffect(journal, "op-mapped"));
  expect(journal.operationResult("op-mapped")?.receipt.status).toBe("queued");

  churn(journal);
  journal.close();
  journal = open(filename);
  churn(journal);

  expect(journal.operationResult("op-mapped")?.receipt).toMatchObject({ kind: "send", status: "queued" });
  // The original key still replays its stored receipt; nothing is admitted again.
  const replay = journal.executeOperation(mappedSend("op-mapped"));
  expect(replay).toMatchObject({ operationId: "op-mapped", replayed: true });
  expect(journal.effectBatch(100)).toEqual([]);
  expect(() => journal.retryOperation("op-mapped")).toThrow("native queue");
  expect(() => journal.claimDeliveryAction("op-mapped", "discard")).toThrow("native queue");

  const h = harness(journal);
  h.canonical(entry => h.proofFor(entry.entryId));
  expect(await h.executor.reconcile(conversationId)).toBeFalse();
  expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ entryId: "op-mapped", state: "delivered", mutationOperationId: null });
  expect(journal.operationResult("op-mapped")?.receipt.status).toBe("delivered");
  expect(h.settled.map(entry => entry.entryId)).toEqual(["op-mapped"]);
  expect(h.writes).toEqual([]);

  // Settled, the entry holds nothing, and its operation compacts like any other.
  expect(holds(filename)).toEqual([]);
  churn(journal);
  expect(journal.operationResult("op-mapped")).toBeNull();
  journal.close();
});

test("every unsettled state holds exactly the ids it still answers through, across restart", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  const h = harness(journal);
  // Queued explicit add: its receipt is `applied` long before any delivery.
  const queued = nativeCommand("op-queued");
  journal.executeOperation(queued); await h.executor.execute(queued);
  // Uncertain add: native accepted it but the reply was lost.
  const lost = nativeCommand("op-lost");
  journal.executeOperation(lost); h.loseNextReply(); await h.executor.execute(lost);
  // An edit whose reply was lost: the add is queued, the edit is the unresolved fence.
  const edited = nativeCommand("op-edited");
  journal.executeOperation(edited); await h.executor.execute(edited);
  const edit = nativeCommand("op-edit-leaf", { action: "update", entryId: "op-edited", expectedRevision: 1, text: "edited words" });
  journal.executeOperation(edit); h.loseNextReply(); await h.executor.execute(edit);
  // Dispatching: native started it, delivery not yet seen.
  const started = nativeCommand("op-started");
  journal.executeOperation(started); await h.executor.execute(started);
  h.idle();
  const start = nativeCommand("op-start-leaf", { action: "start", entryId: "op-started", expectedRevision: 1, turnId: null });
  journal.executeOperation(start); await h.executor.execute(start);

  expect(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, entry.state, entry.mutationOperationId])).toEqual([
    ["op-queued", "queued", null],
    ["op-lost", "uncertain", "op-lost"],
    ["op-edited", "uncertain", "op-edit-leaf"],
    ["op-started", "dispatching", null],
  ]);
  expect(holds(filename)).toEqual(["op-edit-leaf", "op-edited", "op-lost", "op-queued", "op-started"]);

  churn(journal);
  journal.close();
  journal = open(filename);
  churn(journal);

  const statuses = Object.fromEntries(["op-queued", "op-lost", "op-edited", "op-edit-leaf", "op-started", "op-start-leaf"]
    .map(id => [id, journal.operationResult(id)?.receipt.status ?? null]));
  expect(statuses).toEqual({
    "op-queued": "applied", "op-lost": "uncertain", "op-edited": "applied", "op-edit-leaf": "uncertain",
    "op-started": "applied",
    // Answered, and no entry answers through it any more.
    "op-start-leaf": null,
  });

  const next = harness(journal);
  // The lost edit is observed in native's own queue and resolves through its own id.
  (next.items as NativeQueuedSubmission[]).push(...h.items);
  next.canonical(entry => entry.entryId === "op-edited" || entry.entryId === "op-queued" ? null : next.proofFor(entry.entryId));
  await next.executor.reconcile(conversationId);
  const after = Object.fromEntries(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, [entry.state, entry.mutationOperationId]]));
  expect(after).toEqual({
    "op-queued": ["queued", null],
    "op-lost": ["delivered", null],
    "op-edited": ["queued", null],
    "op-started": ["delivered", null],
  });
  expect(journal.operationResult("op-edit-leaf")?.receipt.status).toBe("applied");
  expect(journal.operationResult("op-lost")?.receipt.status).toBe("delivered");
  expect(journal.operationResult("op-started")?.receipt.status).toBe("delivered");
  expect(next.writes).toEqual([]);
  expect(holds(filename)).toEqual(["op-edited", "op-queued"]);
  journal.close();
});

test("an edit left unresolved when proof of the earlier version settles the entry keeps replaying under its original key through compaction and restart", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  const h = harness(journal);
  const add = nativeCommand("op-raced");
  journal.executeOperation(add); await h.executor.execute(add);
  const edit = nativeCommand("op-raced-edit", { action: "update", entryId: "op-raced", expectedRevision: 1, text: "raced words" });
  journal.executeOperation(edit);
  journal.nativeQueueTransition(edit.operationId, { phase: "prepared", input: [{ type: "text", text: "raced words v2" }] });
  journal.nativeQueueTransition(edit.operationId, { phase: "uncertain", reason: "native reply lost while the turn started" });
  // Canonical history shows revision 1 delivered; the edit's fate is still unknown.
  journal.nativeQueueTransition(add.operationId, { phase: "proven", proof: { ...h.proofFor("op-raced"), revision: 1,
    input: journal.nativeQueueRead(conversationId)[0]!.versions[0]!.input! } });
  expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "delivered", mutationOperationId: "op-raced-edit", dispatchedRevision: 1 });
  expect(holds(filename)).toEqual(["op-raced-edit"]);
  const before = journal.executeOperation(edit);
  expect(before).toMatchObject({ replayed: true, operationId: "op-raced-edit", receipt: { status: "uncertain" } });

  churn(journal);
  journal.close();
  journal = open(filename);
  churn(journal);

  expect(holds(filename)).toEqual(["op-raced-edit"]);
  expect(journal.operationResult("op-raced")).toBeNull();
  expect(journal.executeOperation(edit)).toEqual({ ...before });
  // The id stays a fence: no fresh key can edit the entry past its unresolved mutation.
  expect(() => journal.executeOperation(nativeCommand("op-raced-edit-2", { action: "update", entryId: "op-raced", expectedRevision: 2, text: "again" }))).toThrow("frozen or unresolved");

  // Once the edit answers, the entry holds nothing and compaction may take the row.
  journal.nativeQueueTransition(edit.operationId, { phase: "observed-queued",
    submission: { id: "native-1", clientUserMessageId: "op-raced", input: [{ type: "text", text: "raced words v2" }] } });
  expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "delivered", mutationOperationId: null });
  expect(holds(filename)).toEqual([]);
  churn(journal);
  expect(journal.operationResult("op-raced-edit")).toBeNull();
  expect(h.writes).toEqual(["thread/queue/add"]);
  journal.close();
});

test("a settled entry's original key cannot admit it again after compaction", async () => {
  const filename = journalFile();
  const journal = open(filename);
  nativeSession(journal);
  const h = harness(journal);
  journal.executeOperation(mappedSend("op-done"));
  await h.executor.execute(nativeEffect(journal, "op-done"));
  h.canonical(entry => h.proofFor(entry.entryId));
  await h.executor.reconcile(conversationId);
  const add = nativeCommand("op-explicit-done");
  journal.executeOperation(add); await h.executor.execute(add);
  await h.executor.reconcile(conversationId);
  churn(journal);
  expect(journal.operationResult("op-done")).toBeNull();
  expect(journal.operationResult("op-explicit-done")).toBeNull();
  const before = [rawEntry(journal, "op-done"), rawEntry(journal, "op-explicit-done")];

  expect(() => journal.executeOperation(mappedSend("op-done"))).toThrow("retained native queue entry");
  expect(() => journal.executeOperation(add)).toThrow("retained native queue entry");
  // Even with native no longer advertised, the id is not a fresh ordinary send.
  nativeSession(journal, { activeTurnId: null });
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: binding.threadId }, hostKind: "codex-app-server",
    host: "hosted", turn: "idle", activeTurnId: null, accountId: binding.accountId, capabilities: { steer: true, structuredAttention: true },
  } });
  expect(() => journal.executeOperation(mappedSend("op-done"))).toThrow("retained native queue entry");

  expect([rawEntry(journal, "op-done"), rawEntry(journal, "op-explicit-done")]).toEqual(before);
  expect(journal.operationResult("op-done")).toBeNull();
  expect(journal.effectBatch(100)).toEqual([]);
  expect(h.writes).toEqual(["thread/queue/add", "thread/queue/add"]);
  journal.close();
});

test("a removed entry whose add was compacted no longer wedges the conversation's reconciliation", async () => {
  const filename = journalFile();
  const journal = open(filename);
  nativeSession(journal);
  const h = harness(journal);
  const removed = nativeCommand("op-removed");
  journal.executeOperation(removed); await h.executor.execute(removed);
  const remove = nativeCommand("op-remove-leaf", { action: "delete", entryId: "op-removed", expectedRevision: 1 });
  journal.executeOperation(remove); await h.executor.execute(remove);
  expect(journal.operationResult("op-removed")?.receipt).toMatchObject({ status: "failed", reason: "delivery-discarded" });
  const waiting = nativeCommand("op-waiting");
  journal.executeOperation(waiting); await h.executor.execute(waiting);
  churn(journal);
  expect(journal.operationResult("op-removed")).toBeNull();
  expect(journal.operationResult("op-waiting")?.receipt.status).toBe("applied");

  h.canonical(entry => h.proofFor(entry.entryId));
  h.settled.length = 0;
  await h.executor.reconcile(conversationId);
  expect(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, entry.state])).toEqual([["op-removed", "removed"], ["op-waiting", "delivered"]]);
  expect(h.settled.map(entry => [entry.entryId, entry.state])).toEqual([["op-removed", "removed"], ["op-waiting", "delivered"]]);
  journal.close();
});

test("historical compacted entry settles on exact canonical proof alone, with no operation, effect or engine write", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  journal.executeOperation(mappedSend("op-historical", "the original words"));
  await harness(journal).executor.execute(nativeEffect(journal, "op-historical"));
  churn(journal);
  journal.close();
  compactedBeforeHolds(filename, "op-historical");
  journal = open(filename);
  expect(journal.operationResult("op-historical")).toBeNull();
  expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "queued", proof: null, mutationOperationId: null, nativeSubmissionId: "native-1" });
  const seqBefore = tailSeq(filename);

  const h = harness(journal);
  h.canonical(entry => h.proofFor(entry.entryId));
  expect(await h.executor.reconcile(conversationId)).toBeFalse();

  const entry = journal.nativeQueueRead(conversationId)[0]!;
  expect(entry).toMatchObject({ entryId: "op-historical", state: "delivered", mutationOperationId: null, dispatchedRevision: 1,
    proof: { clientUserMessageId: "op-historical", threadId: binding.threadId, revision: 1 } });
  expect(journal.operationResult("op-historical")).toBeNull();
  expect(journal.effectBatch(100)).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.settled.map(row => [row.entryId, row.state])).toEqual([["op-historical", "delivered"]]);
  const appended = eventsAfter(filename, seqBefore);
  expect(appended.map(event => [event.kind, event.scope])).toEqual([["native-queue-changed", `session:${conversationId}`]]);
  expect(appended[0]!.payload).toEqual({ conversationId, threadId: binding.threadId, entryId: "op-historical", settledBy: "canonical-proof" });

  // The same proof replays without another write; the entry still owns its id.
  const replay = journal.nativeQueueSettleCompacted({ conversationId, entryId: "op-historical", binding, proof: entry.proof! });
  expect(replay).toMatchObject({ operation: "compacted", replayed: true });
  expect(eventsAfter(filename, seqBefore)).toHaveLength(1);
  expect(() => journal.nativeQueueSettleCompacted({ conversationId, entryId: "op-historical", binding, proof: { ...entry.proof!, itemId: "other-item" } })).toThrow("proof conflict");
  expect(() => journal.executeOperation(mappedSend("op-historical", "the original words"))).toThrow("retained native queue entry");
  expect(() => journal.retryOperation("op-historical")).toThrow("unknown");
  expect(() => journal.retryOperation("op-historical", "fresh-key")).toThrow("unknown");
  expect(() => journal.claimDeliveryAction("op-historical", "retry")).toThrow("unknown");
  journal.close();
});

test("absent, unreadable, foreign, conflicting and partial evidence leave a historical entry exactly as it was", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  const setup = harness(journal);
  journal.executeOperation(mappedSend("op-held", "held words"));
  await setup.executor.execute(nativeEffect(journal, "op-held"));
  // An edit that landed: proof must name revision 2, never the superseded words.
  const edit = nativeCommand("op-held-edit", { action: "update", entryId: "op-held", expectedRevision: 1, text: "held words, edited" });
  journal.executeOperation(edit); await setup.executor.execute(edit);
  churn(journal);
  journal.close();
  compactedBeforeHolds(filename, "op-held");
  journal = open(filename);
  const original = rawEntry(journal, "op-held");
  const h = harness(journal);
  const exact = h.proofFor("op-held");
  expect(exact.revision).toBe(2);

  const cases: Array<[string, (entry: NativeQueueRecord) => NativeQueueProof | null | Promise<NativeQueueProof | null>]> = [
    ["absent", () => null],
    ["foreign thread", () => ({ ...exact, threadId: "another-thread" })],
    ["foreign client identity", () => ({ ...exact, clientUserMessageId: "another-operation" })],
    ["conflicting input", () => ({ ...exact, input: [{ type: "text", text: "held words, edited v2 and more" }] })],
    ["superseded version", entry => ({ ...exact, revision: 1, input: entry.versions[0]!.input! })],
    ["partial item", () => ({ ...exact, itemId: "" })],
    ["partial turn", () => ({ ...exact, turnId: "" })],
  ];
  for (const [name, answer] of cases) {
    h.canonical(answer);
    expect(await h.executor.reconcile(conversationId), name).toBeTrue();
    expect(rawEntry(journal, "op-held"), name).toBe(original);
  }
  h.canonical(() => { throw new Error("history unreadable"); });
  await expect(h.executor.reconcile(conversationId)).rejects.toThrow("unreadable");
  expect(rawEntry(journal, "op-held")).toBe(original);

  // An account switch leaves the entry to its own binding.
  h.canonical(() => exact);
  h.switchAccount();
  expect(await h.executor.reconcile(conversationId)).toBeFalse();
  expect(rawEntry(journal, "op-held")).toBe(original);

  // Direct callers are held to the same identity.
  const direct = (change: Partial<Parameters<RuntimeJournal["nativeQueueSettleCompacted"]>[0]>) =>
    () => journal.nativeQueueSettleCompacted({ conversationId, entryId: "op-held", binding, proof: exact, ...change });
  expect(direct({ conversationId: "conversation_other" })).toThrow("ownership changed");
  expect(direct({ binding: { ...binding, accountId: "account-b" } })).toThrow("ownership changed");
  expect(direct({ binding: { ...binding, threadId: "another-thread" } })).toThrow("ownership changed");
  expect(direct({ entryId: "op-held-edit" })).toThrow("entry is unknown");
  expect(rawEntry(journal, "op-held")).toBe(original);
  expect(journal.effectBatch(100)).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.settled).toEqual([]);

  // The same entry with exact evidence then converges.
  const exactly = harness(journal);
  exactly.canonical(() => exact);
  expect(await exactly.executor.reconcile(conversationId)).toBeFalse();
  expect(journal.nativeQueueRead(conversationId)[0]).toMatchObject({ state: "delivered", dispatchedRevision: 2 });
  journal.close();
});

test("evidence-only settlement never crosses a discard, a refusal, a withdrawal, an unresolved mutation or a live operation", async () => {
  const filename = journalFile();
  let journal = open(filename);
  nativeSession(journal);
  const h = harness(journal);
  const ids = ["op-x-removed", "op-x-refused", "op-x-fenced", "op-x-live"];
  for (const id of ids) {
    const add = nativeCommand(id);
    journal.executeOperation(add);
    if (id === "op-x-refused") await h.executor.execute(add, "native refused this add");
    else await h.executor.execute(add);
  }
  const remove = nativeCommand("op-x-remove-leaf", { action: "delete", entryId: "op-x-removed", expectedRevision: 1 });
  journal.executeOperation(remove); await h.executor.execute(remove);
  const fence = nativeCommand("op-x-fence-leaf", { action: "update", entryId: "op-x-fenced", expectedRevision: 1, text: "fenced edit" });
  journal.executeOperation(fence); h.loseNextReply(); await h.executor.execute(fence);
  churn(journal);
  journal.close();
  for (const id of ["op-x-removed", "op-x-refused", "op-x-fenced"]) compactedBeforeHolds(filename, id);
  journal = open(filename);
  const before = Object.fromEntries(ids.map(id => [id, rawEntry(journal, id)]));
  const settle = (id: string, revision = 1) => () => journal.nativeQueueSettleCompacted({ conversationId, entryId: id, binding,
    proof: { threadId: binding.threadId, clientUserMessageId: id, revision, turnId: "turn", itemId: "item",
      input: journal.nativeQueueRead(conversationId).find(row => row.entryId === id)!.versions.find(version => version.revision === revision)!.input! } });
  expect(settle("op-x-removed")).toThrow("not awaiting canonical proof");
  expect(settle("op-x-refused")).toThrow();
  expect(settle("op-x-fenced", 2)).toThrow("unresolved mutation");
  expect(settle("op-x-live")).toThrow("operation is retained");
  expect(Object.fromEntries(ids.map(id => [id, rawEntry(journal, id)]))).toEqual(before);
  expect(journal.operationResult("op-x-fence-leaf")?.receipt.status).toBe("uncertain");
  journal.close();
});

test("holds stay bounded by the unsettled-entry admission cap, and a pre-hold journal gains them on open", async () => {
  const filename = journalFile();
  // Seeded under a roomy budget so the seed itself is not 2 000 compactions.
  let journal = open(filename, 1_000_000);
  nativeSession(journal);
  const settledCount = 300;
  const unsettledCount = 2000;
  const input = [{ type: "text" as const, text: "scale" }];
  for (let index = 0; index < settledCount + unsettledCount; index++) {
    const id = `op-scale-${String(index).padStart(5, "0")}`;
    journal.executeOperation(nativeCommand(id, { text: "scale" }));
    journal.nativeQueueTransition(id, { phase: "prepared", input });
    journal.nativeQueueTransition(id, { phase: "acknowledged", nativeSubmissionId: `native-${id}` });
    if (index < settledCount) {
      journal.nativeQueueTransition(id, { phase: "proven", proof: { threadId: binding.threadId, clientUserMessageId: id, revision: 1, turnId: "t", itemId: `i-${id}`, input } });
    }
  }
  expect(() => journal.executeOperation(nativeCommand("op-scale-over-cap", { text: "scale" }))).toThrow("admission bound exceeded");
  journal.close();
  journal = open(filename, 64);
  const started = performance.now();
  churn(journal, 256);
  const churnMs = performance.now() - started;
  expect(holds(filename)).toHaveLength(unsettledCount);
  const count = (sql: string) => { const db = new Database(filename, { readonly: true }); const value = db.query<{ n: number }, []>(sql).get()!.n; db.close(); return value; };
  expect(count("SELECT COUNT(*) AS n FROM operations")).toBe(unsettledCount);
  // 256 compacting appends over 2000 held rows: the hold check is an indexed lookup, not an entry scan.
  expect(churnMs).toBeLessThan(10_000);
  journal.close();

  // A journal compacted before holds existed: drop them, reopen, and they are rebuilt from the entries.
  const db = new Database(filename);
  db.exec("DROP TABLE native_queue_operation_holds");
  db.close();
  journal = open(filename, 64);
  expect(holds(filename)).toHaveLength(unsettledCount);
  churn(journal, 64);
  expect(count("SELECT COUNT(*) AS n FROM operations")).toBe(unsettledCount);
  journal.close();
}, 120_000);

test("the compacted-proof settlement crosses the production socket with its own answer shape", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqcs-"));
  const filename = path.join(base, "journal.sqlite");
  let journal = open(filename);
  nativeSession(journal);
  journal.executeOperation(mappedSend("op-socket"));
  await harness(journal).executor.execute(nativeEffect(journal, "op-socket"));
  journal.close();
  compactedBeforeHolds(filename, "op-socket");
  journal = open(filename);
  const proof = harness(journal).proofFor("op-socket");
  const socket = path.join(base, "host.sock");
  const server = serveRuntimeHost(socket, new RuntimeHost(journal, undefined, undefined, true));
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socket);
  try {
    const original = rawEntry(journal, "op-socket");
    const seqBefore = tailSeq(filename);
    const malformed: Array<[string, unknown]> = [
      ["input", { ...proof, input: "text" }],
      ["empty input", { ...proof, input: [] }],
      ["turn id", { ...proof, turnId: 42 }],
      ["item id", { ...proof, itemId: {} }],
      ["turn and item ids", { ...proof, turnId: 42, itemId: {} }],
      ["revision", { ...proof, revision: "1" }],
      ["fractional revision", { ...proof, revision: 1.5 }],
      ["thread id", { ...proof, threadId: null }],
      ["client identity", { ...proof, clientUserMessageId: ["op-socket"] }],
      ["proof", "proof"],
    ];
    for (const [name, candidate] of malformed) {
      await expect(client.nativeQueueSettleCompacted({ conversationId, entryId: "op-socket", binding, proof: candidate as never }), name).rejects.toThrow("compacted proof is invalid");
      // A caller that skips the socket reaches the same rule in the journal.
      expect(() => journal.nativeQueueSettleCompacted({ conversationId, entryId: "op-socket", binding, proof: candidate as never }), name).toThrow("proof is malformed");
      expect(rawEntry(journal, "op-socket"), name).toBe(original);
    }
    await expect(client.nativeQueueSettleCompacted({ conversationId, entryId: "op-socket", binding: { threadId: binding.threadId } as never, proof })).rejects.toThrow("compacted proof is invalid");
    expect(rawEntry(journal, "op-socket")).toBe(original);
    expect(tailSeq(filename)).toBe(seqBefore);

    // The operation path refuses the same identities before writing anything.
    await client.command(nativeCommand("op-socket-live"));
    await harness(journal).executor.execute(nativeCommand("op-socket-live"));
    const live = rawEntry(journal, "op-socket-live");
    const liveProof = harness(journal).proofFor("op-socket-live");
    await expect(client.nativeQueueTransition("op-socket-live", { phase: "proven", proof: { ...liveProof, turnId: 42, itemId: {} } as never })).rejects.toThrow("proof is malformed");
    expect(rawEntry(journal, "op-socket-live")).toBe(live);

    // Fields beyond the proof's own are not persisted.
    const settled = await client.nativeQueueSettleCompacted({ conversationId, entryId: "op-socket", binding, proof: { ...proof, note: "extra" } as never });
    expect(settled.entry.proof).toEqual(proof);
    expect(settled.replayed).toBeFalse();
    expect(settled).toMatchObject({ operation: "compacted", replayed: false, entry: { entryId: "op-socket", state: "delivered", proof } });
    expect(settled).not.toHaveProperty("receipt");
    expect(await client.operationStatus("op-socket")).toBeNull();
    expect((await client.nativeQueueSettleCompacted({ conversationId, entryId: "op-socket", binding, proof })).replayed).toBeTrue();
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    journal.close();
  }
});
