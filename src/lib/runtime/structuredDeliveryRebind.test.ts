import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite drives the process-scoped delivery controller
   and a startup adoption pass, neither of which may touch the operator's live
   registry, runtime journal, or config directory. */
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-rebind-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
/* Restored in afterAll: a bun run that carries several test files shares one
   process, so an isolated TMPDIR this file then deletes would strand every
   later file's mkdtemp. */
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { createFakeDeliveryLedger, FakeEngineHost } = await import("./fixtures/fakeEngineHost");
const {
  bindStructuredDeliveryQueue,
  hasStructuredDeliveryHost,
  publishStructuredDeliveryHost,
  structuredDeliveryPublicationState,
} = await import("./structuredDeliveryController");
const { kickStructuredDeliveryQueue } = await import("./structuredDeliverySignal");
const { adoptStructuredHostsAtStartup } = await import("./startup");
type AgentRegistry = InstanceType<typeof AgentRegistry>;
type RuntimeHostClient = import("./client").RuntimeHostClient;
type SessionKey = import("@/lib/agent/sessionKey").SessionKey;

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

function runtimeClient(journal: InstanceType<typeof RuntimeJournal>): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after: number) => journal.replay(after),
    waitEvents: async (after: number) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    producerCursor: async (producerKind: string, eventKeyPrefix: string) =>
      journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function structuredHost() {
  return Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
}

/** Seeds the conversation and structured-host entry a delivery needs to resolve
    a published host, and answers the conversation id with the session key the
    delivery queue will look the host up under. */
function seedConversation(
  registry: AgentRegistry,
  directory: string,
  name: string,
): { conversationId: string; key: SessionKey } {
  const artifactPath = path.join(directory, `${name}.jsonl`);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "rebind-fixture-account",
    launchProfile,
    turn: { state: "idle", source: "assistant", terminalAt: null },
    observedAt: "2026-08-26T10:00:00.000Z",
  }]);
  const conversation = Object.values(registry.snapshot().conversations)[0];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("seeded conversation is missing");
  const key: SessionKey = { engine: "codex", sessionId: generation.id };
  registry.upsert({
    key,
    artifactPath,
    cwd: directory,
    accountId: "rebind-fixture-account",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:rebind-fixture-host",
      process: null,
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  return { conversationId: conversation.id, key };
}

async function settles(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error("rebind condition did not settle");
}

function fixture(name: string) {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  return {
    directory,
    registry,
    journal,
    client: runtimeClient(journal),
    close: async () => {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a process that never bound the delivery queue reports an unbound publication (#1191)", () => {
  /* Read from a fresh process: the publication lives on `process`, so any bind
     this suite (or a sibling file sharing the run) already performed would
     answer for it here. */
  const probe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      "const controller = await import(\"./src/lib/runtime/structuredDeliveryController.ts\");"
        + " console.log(controller.structuredDeliveryPublicationState());",
    ],
    cwd: repoRoot,
    env: { ...process.env, ...isolatedEnvironment },
  });

  expect(probe.stdout.toString().trim()).toBe("unbound");
});

test("a spawn issued while the queue rebinds is published once the bind completes (#1191)", async () => {
  const { registry, journal, client, close } = fixture("rebind-window");
  await bindStructuredDeliveryQueue([], { registry, client });
  expect(structuredDeliveryPublicationState()).toBe("ready");

  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotEntered!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => { snapshotEntered = resolve; });
  const slowClient = {
    ...client,
    snapshot: async () => {
      snapshotEntered();
      await snapshotGate;
      return journal.snapshot();
    },
  } as RuntimeHostClient;

  const rebind = bindStructuredDeliveryQueue([], { registry, client: slowClient });
  await snapshotStarted;

  /* The spawn lands in the middle of the rebinding pass: the replacement is
     published, the predecessor is retired, and no caller ever sees a gap. */
  const key = { engine: "codex" as const, sessionId: "rebind-window-session" };
  const unregister = await publishStructuredDeliveryHost({ key, host: structuredHost() });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  releaseSnapshot();
  await rebind;

  await unregister();
  await close();
});

test("a startup pass with no runtime client leaves the live publication in place (#1191)", async () => {
  const { registry, client, close } = fixture("clientless-startup");
  await bindStructuredDeliveryQueue([], { registry, client });
  const key = { engine: "claude" as const, sessionId: "clientless-startup-session" };
  const unregister = await publishStructuredDeliveryHost({ key, host: structuredHost() });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  await adoptStructuredHostsAtStartup({
    registry,
    client: null,
    refreshTranscriptState: async () => {},
    adopt: async () => [],
    adoptClaude: async () => [],
  });

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(structuredDeliveryPublicationState()).toBe("ready");
  const second = { engine: "claude" as const, sessionId: "clientless-startup-successor" };
  const unregisterSecond = await publishStructuredDeliveryHost({ key: second, host: structuredHost() });

  await unregisterSecond();
  await unregister();
  await close();
});

test("retiring the publication leaves the controller rebinding, not unbound (#1191)", async () => {
  const { registry, client, close } = fixture("publication-state");
  await bindStructuredDeliveryQueue([], { registry, client });
  expect(structuredDeliveryPublicationState()).toBe("ready");

  await bindStructuredDeliveryQueue([], { registry, client: null });
  expect(structuredDeliveryPublicationState()).toBe("rebinding");

  await close();
});

test("a publication paused inside the predecessor lands on the controller that replaced it (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("in-flight-swap");
  await bindStructuredDeliveryQueue([], { registry, client });

  const { conversationId, key } = seedConversation(registry, directory, "in-flight-swap-session");
  let releaseOwnership!: () => void;
  const ownershipGate = new Promise<void>((resolve) => { releaseOwnership = resolve; });
  let ownershipEntered!: () => void;
  const ownershipStarted = new Promise<void>((resolve) => { ownershipEntered = resolve; });
  let gated = true;
  const ownsOperation = async () => {
    if (!gated) return true;
    gated = false;
    ownershipEntered();
    await ownershipGate;
    return true;
  };

  const host = structuredHost();
  const publication = publishStructuredDeliveryHost({ key, host }, ownsOperation);
  await ownershipStarted;

  /* The whole rebind lands while that publication is parked inside the
     predecessor's registration: the successor is installed and the predecessor
     retired, so a continuation that committed into its captured maps would
     report a host the live controller does not have. */
  await bindStructuredDeliveryQueue([], { registry, client });
  releaseOwnership();
  const unregister = await publication;

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-in-flight-swap",
    idempotencyKey: "in-flight-swap",
    conversationId,
    text: "the first delivery after the swap",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-in-flight-swap")?.receipt.status === "delivered");
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-in-flight-swap"]);

  await unregister();
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  await close();
});

test("a rebind keeps serving the hosts the predecessor already had (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-carry");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-carry-session");
  const host = structuredHost();
  await publishStructuredDeliveryHost({ key, host });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  /* Startup binds with an empty adoption set and completes it later, so a
     successor that starts hostless serves nothing until that completion lands.
     The predecessor's hosts are handed over instead. */
  await bindStructuredDeliveryQueue([], { registry, client });

  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-carry",
    idempotencyKey: "handover-carry",
    conversationId,
    text: "the first delivery after the hand-over",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-handover-carry")?.receipt.status === "delivered");
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-carry"]);

  await close();
});

test("a delivery admitted while the successor is still registering lands exactly once (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-window");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-window-session");
  const host = structuredHost();
  await publishStructuredDeliveryHost({ key, host });

  let releaseCursor!: () => void;
  const cursorGate = new Promise<void>((resolve) => { releaseCursor = resolve; });
  let cursorEntered!: () => void;
  const cursorStarted = new Promise<void>((resolve) => { cursorEntered = resolve; });
  let gated = true;
  const gatedClient = {
    ...client,
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
      if (gated) {
        gated = false;
        cursorEntered();
        await cursorGate;
      }
      return journal.producerCursor(producerKind, eventKeyPrefix);
    },
  } as RuntimeHostClient;

  const rebind = bindStructuredDeliveryQueue([], { registry, client: gatedClient });
  /* Racing the rebind keeps this deterministic either way: a build that never
     re-registers the carried-over host finishes the bind instead of entering
     the gate, and fails the assertion below rather than hanging. */
  await Promise.race([cursorStarted, rebind]);

  /* The successor owns the publication and its registration of this host is
     still in flight. The host must already resolve, or the delivery admitted
     here settles `failed` with "structured host recovery did not start". */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-window",
    idempotencyKey: "handover-window",
    conversationId,
    text: "admitted mid-registration",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(() => journal.operationResult("operation-handover-window")?.receipt.status === "delivered");

  releaseCursor();
  await rebind;

  /* Completing the registration neither loses the host nor re-delivers. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-window"]);

  await close();
});
