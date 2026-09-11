import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

/* #1664 against the real journal, the real agent registry and (when a Codex
   binary is supplied) the real app-server. Isolated state only: nothing here
   may address the operator's registry, journal or engine homes. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-nq-compaction-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
const ambientEnvironment = Object.fromEntries(Object.keys(isolatedEnvironment).map(name => [name, process.env[name]]));
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { NativeQueueExecutor } = await import("./nativeQueueExecutor");
const { NativeCodexQueue } = await import("./nativeCodexQueue");
const { CodexAppServerHost } = await import("./codexAppServerHost");
const { FileRuntimeEventStore } = await import("./eventStore");
const { parseRuntimeCommand } = await import("./commands");
type AgentRegistryType = import("@/lib/agent/registry").AgentRegistry;
type RuntimeJournalType = import("@/runtime-host/journal").RuntimeJournal;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type EngineHost = import("./engineHost").EngineHost;
type NativeQueueCommand = import("./nativeQueueContracts").NativeQueueCommand;
type NativeQueueRecord = import("./nativeQueueContracts").NativeQueueRecord;
type NativeQueueProof = import("./nativeQueueContracts").NativeQueueProof;
type NativeQueuedSubmission = import("./nativeCodexQueue").NativeQueuedSubmission;
type ViewerConversationId = `conversation_${string}`;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const UNVERIFIED = "delivery was accepted and the runtime host could not give it a terminal answer";

function journalClient(journal: () => RuntimeJournalType): RuntimeHostClient {
  return {
    operationStatus: async (id: string) => journal().operationResult(id),
    nativeQueueRead: async (id: string) => journal().nativeQueueRead(id),
    nativeQueueTransition: async (id: string, transition: Parameters<RuntimeJournalType["nativeQueueTransition"]>[1]) => journal().nativeQueueTransition(id, transition),
    nativeQueueSettleCompacted: async (request: Parameters<RuntimeJournalType["nativeQueueSettleCompacted"]>[0]) => journal().nativeQueueSettleCompacted(request),
  } as RuntimeHostClient;
}

/** The two registry ports exactly as the structured delivery controller wires them. */
function registryPorts(registry: AgentRegistryType) {
  return {
    settled: (entry: NativeQueueRecord) => {
      registry.recordDeliveryOutcomeForOperation(entry.conversationId as ViewerConversationId, entry.entryId,
        entry.state === "removed" ? "failed" : "delivered", entry.state === "removed" ? "delivery-discarded" : null);
    },
    binding: (conversationId: string) => {
      const conversation = registry.readOnlySnapshot().conversations[conversationId];
      const generation = conversation?.generations.at(-1);
      if (!conversation || conversation.engine !== "codex" || !generation) return null;
      return { threadId: generation.id, accountId: generation.accountId };
    },
  };
}

function registryConversation(registry: AgentRegistryType, transcriptPath: string, accountId: string) {
  registry.reconcileConversations([{
    engine: "codex", path: transcriptPath, accountId, launchProfile: emptyLaunchProfile({ cwd: path.dirname(transcriptPath) }),
    turn: { state: "idle", source: "assistant", terminalAt: null }, observedAt: "2026-09-11T00:00:00.000Z",
  }]);
  const conversation = Object.values(registry.snapshot().conversations).find(row => row.generations.at(-1)?.path === transcriptPath)!;
  return { conversationId: conversation.id as ViewerConversationId, generation: conversation.generations.at(-1)! };
}

function publishNative(journal: RuntimeJournalType, conversationId: string, threadId: string, accountId: string, activeTurnId: string | null) {
  journal.append({ scope: `session:${conversationId}`, kind: "session-status", payload: {
    conversationId, sessionKey: { engine: "codex", sessionId: threadId }, hostKind: "codex-app-server", host: "hosted",
    turn: activeTurnId ? "running" : "idle", activeTurnId, accountId, capabilities: { steer: true, structuredAttention: true, nativeQueue: true },
  } });
}

/** A composer send exactly as the structured send path admits it: reservation, claimed attempt, journal operation. */
function composerSend(registry: AgentRegistryType, journal: RuntimeJournalType, conversationId: ViewerConversationId, generationId: string, key: string, text: string) {
  const operationId = `op-${key}`;
  const reservation = registry.holdDelivery(conversationId, text, key, "text", [], null, { operationId, kind: "send", policy: "queue" });
  if (!registry.beginDeliveryAttempt(reservation.id, generationId)) throw new Error("fixture attempt was not claimed");
  expect(journal.executeOperation(parseRuntimeCommand("send", { conversationId, operationId, idempotencyKey: key, text, policy: "queue" })).receipt.status).toBe("queued");
  const effect = journal.effectBatch(100, ["runtime.native-queue"]).find(row => row.id === `effect:${operationId}`)!;
  return { operationId, deliveryId: reservation.id, command: effect.payload as unknown as NativeQueueCommand & { operationId: string } };
}

/** The residue a journal compacted before #1664 left: the entry and its reservation, no operation. */
function compactedBeforeHolds(filename: string, operationIds: string[]) {
  const db = new Database(filename);
  for (const id of operationIds) {
    db.query("DELETE FROM operations WHERE operation_id = ?").run(id);
    db.query("DELETE FROM entities WHERE kind = 'operation' AND id = ?").run(id);
    db.query("DELETE FROM outbox WHERE id = ?").run(`effect:${id}`);
  }
  db.close();
}

function ownerOf(registry: AgentRegistryType, operationId: string) {
  const snapshot = registry.readOnlySnapshot();
  const owner = snapshot.deliveryOperationOwners[operationId]!;
  const delivery = snapshot.heldDeliveries[owner.deliveryId];
  return { state: delivery?.state ?? null, error: delivery?.error ?? null, terminalState: owner.terminalState, terminalDisposition: owner.terminalDisposition };
}

test("registry: canonical proof settles an unverified historical reservation delivered; a discarded one stays discarded", async () => {
  const directory = fs.mkdtempSync(path.join(isolated, "registry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const { conversationId, generation } = registryConversation(registry, path.join(directory, "historical.jsonl"), "account-a");
  const ports = registryPorts(registry);
  const binding = ports.binding(conversationId)!;
  const filename = path.join(directory, "runtime.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, maxEvents: 12 });
  publishNative(journal, conversationId, binding.threadId, "account-a", "active-a");
  const writes: string[] = [];
  const queue = new NativeCodexQueue({ rpc: async (method, params) => {
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    writes.push(method);
    if (method !== "thread/queue/add") throw new Error(`unexpected ${method}`);
    return { queuedSubmission: { id: `native-${writes.length}`, clientUserMessageId: params.clientUserMessageId, input: params.input } };
  } }, binding.threadId);
  let answer: (entry: NativeQueueRecord) => NativeQueueProof | null = () => null;
  const host = { health: async () => ({ status: "active", activeTurnRef: "active-a" }), nativeQueue: {
    queue, prepare: async (_entry: NativeQueueRecord, version: NativeQueueRecord["versions"][number]) => [{ type: "text" as const, text: version.text }],
    evidence: async (entry: NativeQueueRecord) => answer(entry), sendWithdrawn: async () => { throw new Error("unused"); },
  } } as unknown as EngineHost;
  const executor = () => new NativeQueueExecutor({ client: journalClient(() => journal), resolveHost: () => host, ...ports });

  const unverified = composerSend(registry, journal, conversationId, generation.id, "unverified-key", "the audit request");
  const discarded = composerSend(registry, journal, conversationId, generation.id, "discarded-key", "the retracted request");
  const absent = composerSend(registry, journal, conversationId, generation.id, "absent-key", "never reached history");
  for (const send of [unverified, discarded, absent]) await executor().execute(send.command);
  expect(writes).toEqual(["thread/queue/add", "thread/queue/add", "thread/queue/add"]);
  // Production's receipt deadline settles the first and third unverified; the operator discarded the second.
  registry.terminalizeHeldDelivery(unverified.deliveryId, UNVERIFIED);
  registry.terminalizeHeldDelivery(absent.deliveryId, UNVERIFIED);
  registry.recordDeliveryOutcomeForOperation(conversationId, discarded.operationId, "failed", "delivery-discarded");
  expect(ownerOf(registry, unverified.operationId)).toMatchObject({ state: "failed", terminalDisposition: "unverified" });
  expect(ownerOf(registry, discarded.operationId)).toMatchObject({ state: "failed", error: "delivery-discarded" });
  journal.close();
  compactedBeforeHolds(filename, [unverified.operationId, discarded.operationId, absent.operationId]);
  journal = new RuntimeJournal(filename, { structuredHosts: true, maxEvents: 12 });
  const absentBefore = JSON.stringify(journal.nativeQueueRead(conversationId).find(entry => entry.entryId === absent.operationId));

  answer = entry => entry.entryId === absent.operationId ? null : { threadId: binding.threadId, clientUserMessageId: entry.clientUserMessageId,
    revision: entry.revision, turnId: "canonical-turn", itemId: `item-${entry.entryId}`, input: entry.versions.at(-1)!.input! };
  expect(await executor().reconcile(conversationId)).toBeTrue();

  const states = Object.fromEntries(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, entry.state]));
  expect(states).toEqual({ [absent.operationId]: "queued", [unverified.operationId]: "delivered", [discarded.operationId]: "delivered" });
  expect(JSON.stringify(journal.nativeQueueRead(conversationId).find(entry => entry.entryId === absent.operationId))).toBe(absentBefore);
  expect(ownerOf(registry, unverified.operationId)).toEqual({ state: "delivered", error: null, terminalState: "delivered", terminalDisposition: "delivered" });
  // The journal records what history shows; the operator's discard is not overwritten.
  expect(ownerOf(registry, discarded.operationId)).toMatchObject({ state: "failed", error: "delivery-discarded", terminalState: "failed" });
  expect(ownerOf(registry, absent.operationId)).toMatchObject({ state: "failed", terminalDisposition: "unverified" });
  for (const id of [unverified.operationId, discarded.operationId, absent.operationId]) expect(journal.operationResult(id)).toBeNull();
  expect(journal.effectBatch(100)).toEqual([]);
  expect(writes).toHaveLength(3);
  // The registry's own recovery cannot re-arm what compaction left: the id is the retained entry's.
  expect(() => journal.executeOperation(parseRuntimeCommand("send", { conversationId, operationId: absent.operationId, idempotencyKey: "absent-key", text: "never reached history", policy: "queue" })))
    .toThrow("retained native queue entry");
  journal.close();
});

const binary = process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;

test.skipIf(!binary)("real Codex: a compacted historical entry converges from canonical history with no engine write; an undispatched one stays queued", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nqch-"));
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = path.join(base, key.toLowerCase()); fs.mkdirSync(env[key]!);
  }
  const cwd = path.join(base, "workspace"); fs.mkdirSync(cwd);
  const responses: ServerResponse[] = [];
  const backend = createServer((request, response) => {
    request.resume(); response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response"}}\n\n');
    responses.push(response);
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  fs.writeFileSync(path.join(env.CODEX_HOME!, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.fixture]
name = "Runtime integration fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let hideCanonicalClient: string | null = null;
  // Only authentication/catalog projection is synthetic; queue, history and dispatch are the installed CLI's.
  const spawnProcess = (_command: string, args: string[]) => {
    const child = spawn(binary!, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const input = new PassThrough(); const output = new PassThrough();
    const methods = new Map<number, string>();
    const inbound = createInterface({ input });
    inbound.on("line", line => {
      const message = JSON.parse(line); if (typeof message.id === "number") methods.set(message.id, message.method);
      if (message.method) requests.push({ method: message.method, params: message.params ?? {} });
      child.stdin.write(line + "\n");
    });
    input.on("finish", () => child.stdin.end());
    const outbound = createInterface({ input: child.stdout });
    outbound.on("line", line => {
      const message = JSON.parse(line); const method = methods.get(message.id);
      if (method === "account/read") message.result = { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: false };
      if (method === "model/list") message.result = { data: [{ id: "fixture-model", model: "fixture-model", isDefault: true, inputModalities: ["text", "image"], supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
      if (method === "thread/items/list" && hideCanonicalClient && Array.isArray(message.result?.data)) {
        message.result.data = message.result.data.filter((entry: { item?: { clientId?: string } }) => entry.item?.clientId !== hideCanonicalClient);
      }
      if (method === "thread/turns/list" && hideCanonicalClient && Array.isArray(message.result?.data)) {
        for (const turn of message.result.data) if (Array.isArray(turn.items)) turn.items = turn.items.filter((item: { clientId?: string }) => item.clientId !== hideCanonicalClient);
      }
      output.write(JSON.stringify(message) + "\n");
    });
    child.once("close", () => { inbound.close(); outbound.close(); output.end(); });
    return new Proxy(child, { get(target, property) {
      if (property === "stdin") return input;
      if (property === "stdout") return output;
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as ChildProcessWithoutNullStreams;
  };
  const options = { cwd, binary, codexHome: env.CODEX_HOME, env, model: "fixture-model", requestTimeoutMs: 1000,
    eventStore: new FileRuntimeEventStore(path.join(base, "events")), resolveImagePath: () => { throw new Error("no images here"); }, spawnProcess };
  const filename = path.join(base, "journal.sqlite");
  let journal = new RuntimeJournal(filename, { structuredHosts: true, maxEvents: 12 });
  let host: import("./codexAppServerHost").CodexAppServerHost | undefined;
  const registry = new AgentRegistry(path.join(base, "agent-registry.json"));
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { if (Date.now() >= deadline) throw new Error("native fixture deadline"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    host = await CodexAppServerHost.start(options);
    expect(host.nativeQueue).toBeDefined();
    const threadId = host.identity.threadId;
    const { conversationId, generation } = registryConversation(registry, host.identity.path!, "fixture-account");
    const ports = registryPorts(registry);
    expect(ports.binding(conversationId)).toEqual({ threadId, accountId: "fixture-account" });
    const executor = new NativeQueueExecutor({ client: journalClient(() => journal), resolveHost: () => host!, ...ports });
    const publish = async () => { publishNative(journal, conversationId, threadId, "fixture-account", (await host!.health()).activeTurnRef); };

    // Idle: native dispatches the first queued send itself; the second waits behind the running turn.
    await publish();
    const dispatched = composerSend(registry, journal, conversationId, generation.id, "dispatched-key", "historical audit request Привіт 🌍");
    await executor.execute(dispatched.command);
    await until(() => responses.length === 1);
    await publish();
    const waiting = composerSend(registry, journal, conversationId, generation.id, "waiting-key", "still waiting behind the turn");
    await executor.execute(waiting.command);
    expect((await host.nativeQueue!.queue.refresh()).items?.map((item: NativeQueuedSubmission) => item.clientUserMessageId)).toEqual([waiting.operationId]);
    registry.terminalizeHeldDelivery(dispatched.deliveryId, UNVERIFIED);
    registry.terminalizeHeldDelivery(waiting.deliveryId, UNVERIFIED);

    // The production residue: both entries retained, both operation rows compacted away before holds existed.
    journal.close();
    compactedBeforeHolds(filename, [dispatched.operationId, waiting.operationId]);
    journal = new RuntimeJournal(filename, { structuredHosts: true, maxEvents: 12 });
    for (const id of [dispatched.operationId, waiting.operationId]) expect(journal.operationResult(id)).toBeNull();
    const before = Object.fromEntries(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, JSON.stringify(entry)]));
    const mark = requests.length;
    const writesSince = () => requests.slice(mark).map(r => r.method)
      .filter(method => /^thread\/queue\/(add|update|delete|reorder|start)$/.test(method) || method === "turn/start" || method === "turn/steer");

    // Absent canonical evidence changes nothing.
    hideCanonicalClient = dispatched.operationId;
    expect(await executor.reconcile(conversationId)).toBeTrue();
    expect(Object.fromEntries(journal.nativeQueueRead(conversationId).map(entry => [entry.entryId, JSON.stringify(entry)]))).toEqual(before);
    hideCanonicalClient = null;

    await until(async () => {
      await executor.reconcile(conversationId);
      return journal.nativeQueueRead(conversationId).find(entry => entry.entryId === dispatched.operationId)?.state === "delivered";
    });
    const settled = journal.nativeQueueRead(conversationId).find(entry => entry.entryId === dispatched.operationId)!;
    expect(settled.proof).toMatchObject({ threadId, clientUserMessageId: dispatched.operationId, revision: 1 });
    expect(settled.proof!.input).toEqual(settled.versions[0]!.input!);
    expect(JSON.stringify(journal.nativeQueueRead(conversationId).find(entry => entry.entryId === waiting.operationId))).toBe(before[waiting.operationId]);
    expect(ownerOf(registry, dispatched.operationId)).toMatchObject({ state: "delivered", terminalDisposition: "delivered" });
    expect(ownerOf(registry, waiting.operationId)).toMatchObject({ state: "failed", terminalDisposition: "unverified" });
    expect(journal.operationResult(dispatched.operationId)).toBeNull();
    expect(journal.effectBatch(100)).toEqual([]);
    expect(writesSince()).toEqual([]);
    expect(requests.filter(r => r.method === "thread/queue/add")).toHaveLength(2);
    expect((await host.nativeQueue!.queue.refresh()).items?.map((item: NativeQueuedSubmission) => item.clientUserMessageId)).toEqual([waiting.operationId]);
  } finally {
    await host?.release(); journal.close();
    for (const response of responses) response.end();
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
  }
}, 30_000);
