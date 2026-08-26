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
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { createFakeDeliveryLedger, FakeEngineHost } = await import("./fixtures/fakeEngineHost");
const {
  bindStructuredDeliveryQueue,
  hasStructuredDeliveryHost,
  publishStructuredDeliveryHost,
  structuredDeliveryPublicationState,
} = await import("./structuredDeliveryController");
const { adoptStructuredHostsAtStartup } = await import("./startup");
type RuntimeHostClient = import("./client").RuntimeHostClient;

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
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function structuredHost() {
  return Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
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
