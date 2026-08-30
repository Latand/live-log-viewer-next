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
const { RuntimeHostUnavailableError } = await import("./client");
const {
  bindStructuredDeliveryQueue,
  completeStructuredDeliveryQueueStartup,
  hasStructuredDeliveryHost,
  publishStructuredDeliveryHost,
  releaseStructuredDeliveryHost,
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
  const conversation = registry.conversationForPath(artifactPath);
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

/** Holds the first `producerCursor` call of a bind open. That parks the
    registration of a carried-over host between its seat and its commit, which
    is the window every lifecycle assertion below is about (#1191). */
function producerCursorGate(client: RuntimeHostClient, journal: InstanceType<typeof RuntimeJournal>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let gated = true;
  return {
    started,
    open: () => open(),
    client: {
      ...client,
      producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
        if (gated) {
          gated = false;
          entered();
          await gate;
        }
        return journal.producerCursor(producerKind, eventKeyPrefix);
      },
    } as RuntimeHostClient,
  };
}

/** A structured host that counts the releases it receives, so "exactly once"
    is an assertion instead of an inference. */
function releaseCountingHost() {
  const releases = { count: 0 };
  return {
    releases,
    host: Object.assign(structuredHost(), { release: async () => { releases.count += 1; } }),
  };
}

async function settles(assertion: () => boolean, what = "rebind condition"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
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

test("a startup completion chained behind a retired generation registers through its successor (#1282)", async () => {
  const { registry, directory, journal, client, close } = fixture("startup-completion-handover");
  const gate = producerCursorGate(client, journal);
  await bindStructuredDeliveryQueue([], { registry, client: gate.client, deferStartupWork: true });
  const first = seedConversation(registry, directory, "completion-handover-first");
  const second = seedConversation(registry, directory, "completion-handover-second");
  const parked = structuredHost();
  const behind = structuredHost();

  /* Two startup completions, the second chained behind the first, with the
     first parked mid-registration. The rebind lands in between, so the chained
     one resumes inside a generation that no longer owns the publication. */
  const firstCompletion = completeStructuredDeliveryQueueStartup([{ key: first.key, host: parked }]);
  await gate.started;
  const secondCompletion = completeStructuredDeliveryQueueStartup([{ key: second.key, host: behind }]);
  await bindStructuredDeliveryQueue([], { registry, client });
  gate.open();
  await firstCompletion;
  await secondCompletion;

  /* Answering "done" while registering nothing is what leaves a launched host
     with no owner able to write a turn into it. */
  expect(hasStructuredDeliveryHost(first.key)).toBe(true);
  expect(hasStructuredDeliveryHost(second.key)).toBe(true);

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

test("a carried-over host released mid-registration is released once and stays gone (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-release");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { key } = seedConversation(registry, directory, "handover-release-session");
  const { host, releases } = releaseCountingHost();
  await publishStructuredDeliveryHost({ key, host });

  const gate = producerCursorGate(client, journal);
  const rebind = bindStructuredDeliveryQueue([], { registry, client: gate.client });
  /* Racing the rebind keeps this deterministic either way: a build that never
     re-registers the carried-over host finishes the bind instead of entering
     the gate, and fails the assertions below rather than hanging. */
  await Promise.race([gate.started, rebind]);

  /* The successor owns the publication and this host's registration is parked
     inside it. One lifecycle means the release lands on the host itself here,
     not on a seat the registration behind it can undo. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(await releaseStructuredDeliveryHost(key)).toBe(true);
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);

  gate.open();
  await rebind;

  /* The registration that resumed cannot bring the host back, and nothing
     releases it a second time. */
  expect(hasStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);
  expect(await releaseStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);

  await close();
});

test("a carried-over host terminated mid-registration is released once and stays gone (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-terminate");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-terminate-session");
  const { host, releases } = releaseCountingHost();
  await publishStructuredDeliveryHost({ key, host });

  const gate = producerCursorGate(client, journal);
  const rebind = bindStructuredDeliveryQueue([], { registry, client: gate.client });
  await Promise.race([gate.started, rebind]);
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  /* A kill effect drains through the controller's termination path while the
     registration is still parked. */
  journal.executeOperation({
    kind: "kill",
    operationId: "operation-handover-terminate",
    idempotencyKey: "handover-terminate",
    conversationId,
    sessionKey: key,
  });
  await kickStructuredDeliveryQueue();
  await settles(() => {
    const status = journal.operationResult("operation-handover-terminate")?.receipt.status;
    return status === "delivered" || status === "failed" || status === "rejected";
  }, "the kill receipt");
  expect(journal.operationResult("operation-handover-terminate")?.receipt.status).toBe("delivered");
  expect(releases.count).toBe(1);
  expect(hasStructuredDeliveryHost(key)).toBe(false);

  gate.open();
  await rebind;

  expect(hasStructuredDeliveryHost(key)).toBe(false);
  expect(releases.count).toBe(1);

  await close();
});

test("a carried-over host whose registration fails is retried and delivers exactly once (#1191)", async () => {
  const { registry, journal, directory, client, close } = fixture("handover-retry");
  await bindStructuredDeliveryQueue([], { registry, client });
  const { conversationId, key } = seedConversation(registry, directory, "handover-retry-session");
  let subscriptions = 0;
  const host = Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), {
    onStateChange: () => { subscriptions += 1; return () => {}; },
  });
  await publishStructuredDeliveryHost({ key, host });
  expect(subscriptions).toBe(1);

  let cursorFailures = 0;
  const failingClient = {
    ...client,
    producerCursor: async (producerKind: string, eventKeyPrefix: string) => {
      if (cursorFailures === 0) {
        cursorFailures += 1;
        throw new RuntimeHostUnavailableError("runtime host request timed out");
      }
      return journal.producerCursor(producerKind, eventKeyPrefix);
    },
  } as RuntimeHostClient;

  await bindStructuredDeliveryQueue([], { registry, client: failingClient });
  expect(cursorFailures).toBe(1);

  /* The failed registration left a host that resolves but that nothing is
     watching: without its own state subscription, a delivery admitted here has
     nothing to wake the queue when the host turns idle again. */
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  journal.executeOperation({
    kind: "send",
    operationId: "operation-handover-retry",
    idempotencyKey: "handover-retry",
    conversationId,
    text: "admitted while the registration was failing",
    policy: "queue",
  });
  await kickStructuredDeliveryQueue();
  await settles(
    () => journal.operationResult("operation-handover-retry")?.receipt.status === "delivered",
    "the delivery admitted while the registration was failing",
  );

  /* The retry behind the seat makes the registration good. */
  await settles(() => subscriptions === 2, "the retried registration");
  expect(hasStructuredDeliveryHost(key)).toBe(true);
  expect(host.ledger.writes.map((entry) => entry.id)).toEqual(["operation-handover-retry"]);

  await close();
});
