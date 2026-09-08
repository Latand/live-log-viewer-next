import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// Clear inherited credentials, runtime endpoints and provider roots BEFORE imports.
// TMPDIR is supplied on private disk by the invoking test environment.
const ambient = { ...process.env };
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-finalization-"));
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: ambient.PATH, NODE_ENV: "test" });
for (const [name, suffix] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", LLV_STATE_DIR: "state", TMPDIR: "tmp", CODEX_HOME: "codex", LLV_CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", LLV_CLAUDE_HOME: "claude" })) {
  const directory = path.join(isolated, suffix);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env[name] = directory;
}
fs.mkdirSync(path.join(isolated, "sockets"), { mode: 0o700 });

const { AgentRegistry } = await import("@/lib/agent/registry");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { RuntimeHost } = await import("@/runtime-host/host");
const { serveRuntimeHost } = await import("@/runtime-host/socket");
const { UnixRuntimeHostClient } = await import("./client");
const { RuntimeJournal } = await import("@/runtime-host/journal");
const { adoptStructuredHostsAtStartup } = await import("./startup");
const { bindStructuredDeliveryQueue } = await import("./structuredDeliveryController");
const { runStructuredHostStartup } = await import("@/lib/viewerInstrumentation");
const { checkpointHotStateRollbackMirrorsForDemotion } = await import("@/lib/viewerInstrumentation");
const { recoverPendingStructuredSpawns, reconcileStructuredSpawnReplay } = await import("./structuredSpawn");
const { captureProcessIdentity } = await import("@/lib/processIdentity");
const { structuredStartupStatus } = await import("./startupStatus");
type RuntimeHostClient = import("./client").RuntimeHostClient;
type RegistryFile = import("@/lib/agent/registry").RegistryFile;

afterAll(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, ambient);
  fs.rmSync(isolated, { recursive: true, force: true });
});

function fixture(failedCount: number, fullHistory = false) {
  const directory = fs.mkdtempSync(path.join(isolated, "fixture-"));
  const filename = path.join(directory, "registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  const begun = seed.beginSpawnRequest({
    engine: "codex", cwd: directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory, title: "Historical failed launch" }),
  });
  seed.failSpawn(begun.receipt.launchId, "historical failure");
  if (fullHistory) {
    const artifactPath = path.join(directory, "history-seed.jsonl");
    const conversation = seed.ensureConversation("codex", artifactPath, null);
    const sessionId = conversation.generations.at(-1)!.id;
    const delivery = seed.holdDelivery(conversation.id, "Historical delivery", "history-seed", "text");
    seed.recordDeliveryOutcome(delivery.id, "failed", "historical failure");
    seed.upsert({
      key: { engine: "codex", sessionId }, artifactPath, cwd: directory, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: directory }), status: "dead", host: null,
      structuredHost: { kind: "codex-app-server", endpoint: "stdio:released", process: null,
        eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0, activeTurnRef: null,
        pendingAttention: [], activeFlags: [] },
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
  }
  const data = JSON.parse(fs.readFileSync(filename, "utf8")) as RegistryFile;
  const receipt = data.receipts[begun.receipt.launchId]!;
  data.receipts = {};
  for (let i = 0; i < failedCount; i++) {
    const launchId = `historical_launch_${i}`;
    data.receipts[launchId] = { ...receipt, launchId, conversationId: `conversation_history_${i}` };
  }
  if (fullHistory) {
    const entry = Object.values(data.entries)[0]!;
    const conversation = Object.values(data.conversations)[0]!;
    data.entries = {};
    data.conversations = {};
    for (let i = 0; i < 8078; i++) {
      const id = `conversation_history_${i}` as const;
      const sessionId = `history_${i}`;
      const artifactPath = path.join(directory, `${sessionId}.jsonl`);
      if (i < 5188) data.entries[`codex:${sessionId}`] = {
        ...entry, key: { engine: "codex", sessionId }, artifactPath,
      };
      data.conversations[id] = {
        ...conversation, id,
        turn: { state: "terminal", source: "assistant", terminalAt: receipt.createdAt, observedAt: receipt.createdAt },
        generations: conversation.generations.map((generation) => ({ ...generation, id: sessionId, path: artifactPath })),
      };
    }
    const held = Object.values(data.heldDeliveries)[0]!;
    data.heldDeliveries = {};
    for (let i = 0; i < 1719; i++) {
      const id = `historical_delivery_${i}`;
      data.heldDeliveries[id] = {
        ...held, id, conversationId: `conversation_history_${i}`, clientMessageId: id,
        command: { ...held.command, operationId: `historical_operation_${i}` },
        state: i < 153 ? "failed" : "delivered",
      };
    }
    for (let i = failedCount; i < 6623; i++) {
      const launchId = `historical_launch_${i}`;
      data.receipts[launchId] = {
        ...receipt, launchId, conversationId: `conversation_history_${i}`,
        state: i < 6458 ? "completed" : i < 6590 ? "conflicted" : i < 6611 ? "starting"
          : i < 6618 ? "host-verified" : i < 6622 ? "pane-bound" : "path-pending",
      };
    }
  }
  fs.writeFileSync(filename, JSON.stringify(data));
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (id, options) => options?.currentRetryLeaf ? journal.currentRetryResult(id) : journal.operationResult(id),
    producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
  } satisfies Partial<RuntimeHostClient> as RuntimeHostClient;
  return { directory, registry, journal, client };
}

test("historical failed launches do not retain startup admission across one full runtime snapshot per receipt", async () => {
  const f = fixture(672);
  // Runtime history and failed receipt cardinalities match the incident's scale.
  // Transport latency is bounded and lower than the measured live snapshot read.
  for (let i = 0; i < 862; i++) f.journal.append({
    scope: { type: "session", id: `conversation_runtime_history_${i}` },
    kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: `history:${i}` },
    payload: { conversationId: `conversation_runtime_history_${i}`, host: "dead", turn: "idle", cwd: f.directory },
  });
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  let snapshots = 0;
  let spawnRecovery = false;
  let signalRecovery!: () => void;
  const recoveryEntered = new Promise<void>((resolve) => { signalRecovery = resolve; });
  const timeline: string[] = [];
  const client: RuntimeHostClient = {
    ...f.client,
    snapshot: async () => {
      snapshots += 1;
      if (spawnRecovery) signalRecovery();
      await Bun.sleep(60);
      return f.journal.snapshot();
    },
    effectBatch: async (kinds, after) => {
      if (kinds?.length === 1 && kinds[0] === "runtime.spawn") {
        spawnRecovery = true;
        timeline.push("spawn-recovery");
      } else timeline.push("delivery-signals-or-drain");
      return f.client.effectBatch(kinds, after);
    },
  };
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
    registry: f.registry, client, refreshTranscriptState: async () => {},
    adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
  }), () => {}, { waitUntilReady: true });
  try {
    await recoveryEntered;
    expect(structuredStartupStatus()?.state).toBe("pending");
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    const held = db.query("SELECT owner_pid, owner_start_identity FROM state_leases WHERE collection = 'pipelines'").get() as { owner_pid: number; owner_start_identity: string };
    db.close();
    expect(held.owner_pid).toBe(process.pid);
    expect(held.owner_start_identity).toBeTruthy();
    timeline.push("lease-owned-during-recovery");
    const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupPipelineContender.ts"), f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(contender.stdout).text();
    const stderr = new Response(contender.stderr).text();
    await startup;
    timeline.push("startup-settled");
    expect(await contender.exited).toBe(0);
    expect(await stderr).toBe("");
    const result = JSON.parse(await stdout);
    console.log(JSON.stringify({ timeline, snapshots, creation: result }));
    expect(result).toEqual({ created: true, error: null, persisted: 1 });
    expect(snapshots).toBeLessThanOrEqual(4);
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
    const after = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    expect(after.query("SELECT count(*) AS n FROM state_leases WHERE collection = 'pipelines'").get()).toEqual({ n: 0 });
    after.close();
  } finally {
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
  }
}, 90_000);


test("a failed historical snapshot remains unknown and a later pass retries it", async () => {
  const f = fixture(3);
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  let reads = 0;
  const unavailable: RuntimeHostClient = {
    ...f.client,
    snapshot: async () => { reads += 1; throw new Error("fixture snapshot unavailable"); },
  };
  try {
    await recoverPendingStructuredSpawns(f.registry, unavailable);
    expect(reads).toBe(2); // Shared historical read plus the registering-session hint.
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
    await recoverPendingStructuredSpawns(f.registry, unavailable);
    expect(reads).toBe(4); // No rejected snapshot survives its pass.
    expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
  } finally { f.journal.close(); }
});

test("startup exposes the retaining fallback await without releasing admission before it settles", async () => {
  const f = fixture(1, true);
  let entered!: () => void;
  const publicationEntered = new Promise<void>((resolve) => { entered = resolve; });
  let settle!: () => void;
  const publicationSettlement = new Promise<void>((resolve) => { settle = resolve; });
  const host = new RuntimeHost(f.journal);
  const server = serveRuntimeHost(path.join(isolated, "sockets", "progress.sock"), {
    handle: async (request, options) => {
      if (request.method === "append") {
        entered();
        await publicationSettlement;
      }
      return host.handle(request, options);
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(path.join(isolated, "sockets", "progress.sock"));
  // No transcript/adopter/controller substitution: historical rows are dead;
  // only the private socket peer withholds a publication response.
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
    registry: f.registry, client,
  }), () => {}, { waitUntilReady: true });
  const leases = () => {
    const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
    try { return db.query("SELECT owner_pid FROM state_leases WHERE collection = 'pipelines'").all(); }
    finally { db.close(); }
  };
  try {
    await publicationEntered;
    expect(structuredStartupStatus()).toMatchObject({
      state: "pending", phase: "publishing historical host fallbacks",
      pid: process.pid, phaseStartedAt: expect.any(String),
    });
    expect(leases()).toEqual([{ owner_pid: process.pid }]);
    await Bun.sleep(25);
    expect(leases()).toEqual([{ owner_pid: process.pid }]);
    settle();
    await startup;
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(leases()).toEqual([]);
  } finally {
    settle();
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 60_000);

test("rollback checkpoint yields to the full startup admission owner", async () => {
  const f = fixture(1, true);
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => { entered = resolve; });
  let released!: () => void;
  const response = new Promise<void>((resolve) => { released = resolve; });
  let first = true;
  const client: RuntimeHostClient = { ...f.client, append: async (event) => {
    if (first) { first = false; entered(); await response; }
    return f.client.append(event);
  } };
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({ registry: f.registry, client }), () => {}, { waitUntilReady: true });
  await publishing;
  let replySettled = false;
  const timer = setTimeout(() => { replySettled = true; released(); }, 50);
  try {
    await checkpointHotStateRollbackMirrorsForDemotion();
    expect(replySettled).toBe(true);
    await startup;
  } finally {
    clearTimeout(timer);
    released();
    await startup;
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    f.journal.close();
  }
}, 60_000);

test("retirement joins historical publications before releasing admission and never publishes ready", async () => {
  const f = fixture(2, true);
  const abort = new AbortController();
  const check = () => abort.signal.throwIfAborted();
  let entered!: () => void;
  const publishing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const client: RuntimeHostClient = { ...f.client, append: async (event) => {
    requests += 1;
    const result = await f.client.append(event);
    entered();
    await response;
    return result;
  } };
  let settled = false;
  const startup = runStructuredHostStartup(() => adoptStructuredHostsAtStartup({ registry: f.registry, client, assertActive: check }), () => {}, { waitUntilReady: true, signal: abort.signal })
    .then(() => { throw new Error("retired startup reported ready"); }, () => { settled = true; });
  await publishing;
  const before = structuredClone(f.registry.readOnlySnapshot().receipts);
  abort.abort(new Error("fixture retirement"));
  await Bun.sleep(20);
  expect(settled).toBe(false);
  const started = requests;
  release();
  await startup;
  await checkpointHotStateRollbackMirrorsForDemotion();
  await Bun.sleep(50);
  expect(requests).toBe(started);
  expect(requests).toBeLessThanOrEqual(16);
  expect(structuredStartupStatus()?.state).toBe("failed");
  expect(f.registry.readOnlySnapshot().receipts).toEqual(before);
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  f.journal.close();
}, 30_000);

test("pending launches ignore a historical snapshot supplier", async () => {
  const f = fixture(0);
  const begun = f.registry.beginSpawnRequest({
    engine: "codex", cwd: f.directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.directory, title: "Pending launch" }),
  });
  let freshReads = 0;
  try {
    const result = await reconcileStructuredSpawnReplay(begun.receipt.launchId, f.registry, {
      ...f.client, snapshot: async () => { freshReads += 1; return f.journal.snapshot(); },
    }, { failedReceiptSnapshot: async () => { throw new Error("historical evidence must not be consulted"); } });
    expect(freshReads).toBe(1);
    expect(result.state).toBe("starting");
  } finally { f.journal.close(); }
});

test("historical reconciliation recovers late transcript evidence and preserves a current writer claim", async () => {
  const f = fixture(0);
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(f.directory, `${sessionId}.jsonl`);
  const key = { engine: "codex" as const, sessionId };
  const begun = f.registry.beginSpawnRequest({
    engine: "codex", cwd: f.directory, transport: "structured", accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: f.directory, title: "Late delivery" }),
  });
  f.registry.stageStructuredSpawn(begun.receipt.launchId, {
    key, artifactPath, cwd: f.directory, accountId: null, status: "unhosted", host: null,
    structuredHost: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  f.registry.failStructuredSpawn(begun.receipt.launchId, "unknown delivery before restart");
  fs.writeFileSync(artifactPath, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Synthetic late delivery" } }) + "\n");
  const stored = f.registry.readOnlySnapshot().entries[`codex:${sessionId}`]!;
  f.registry.upsert({ ...stored, structuredHost: {
    kind: "codex-app-server", endpoint: "fixture:late", process: null,
    eventCursor: 0, protocolVersion: "fixture", writerClaimEpoch: 0,
    activeTurnRef: null, pendingAttention: [], activeFlags: [],
  } });
  // The shared runtime evidence describes the old unhosted projection while
  // the durable registry below has a newer writer; recovery must merge that claim.
  f.journal.append({
    scope: { type: "session", id: begun.receipt.conversationId }, kind: "session-status",
    payload: { conversationId: begun.receipt.conversationId, sessionKey: key,
      hostKind: "codex-app-server", host: "unhosted", cwd: f.directory, artifactPath },
  });
  const claimed = f.registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true });
  expect(claimed?.claimOwner).toBeTruthy();
  try {
    await recoverPendingStructuredSpawns(f.registry, f.client);
    const receipt = f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]!;
    expect(receipt.state).toBe("completed");
    expect(receipt.conversationId).toBe(begun.receipt.conversationId);
    expect(f.registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.claimOwner).toBe(claimed!.claimOwner);
    await recoverPendingStructuredSpawns(f.registry, f.client);
    expect(f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]).toEqual(receipt);
  } finally { f.journal.close(); }
});

test.each([["codex", false], ["codex", true], ["claude", false], ["claude", true]] as const)("late unkeyed %s resume preserves its writer (account mismatch=%s)", async (engine, accountMismatch) => {
  const f = fixture(0);
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(f.directory, `${sessionId}.jsonl`);
  const key = { engine, sessionId };
  const profile = emptyLaunchProfile({ cwd: f.directory, title: "Unkeyed resume recovery" });
  const conversation = f.registry.ensureConversation(engine, artifactPath, null);
  f.registry.upsert({ key, artifactPath, cwd: f.directory, accountId: null, launchProfile: profile,
    status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null,
    structuredHost: { kind: engine === "codex" ? "codex-app-server" : "claude-broker", endpoint: "stdio:released",
      process: null, eventCursor: 0, protocolVersion: null, writerClaimEpoch: 0,
      activeTurnRef: null, pendingAttention: [], activeFlags: [] },
  });
  const begun = f.registry.beginSpawnRequest({ engine, cwd: f.directory, transport: "structured", accountId: null,
    conversationId: conversation.id, purpose: "resume-successor", expectedArtifactPath: artifactPath, launchProfile: profile,
  });
  expect(begun.receipt.key).toBeNull();
  f.registry.failStructuredSpawn(begun.receipt.launchId, "resume lost admission to startup adoption");
  const currentEntry = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
  if (accountMismatch) f.registry.upsert({ ...currentEntry, accountId: "current-writer-account" });
  const externalWriter = Bun.spawn([process.execPath, "-e", "for await (const chunk of process.stdin) { void chunk; }"], {
    env: { ...process.env }, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  const owner = captureProcessIdentity(externalWriter.pid);
  const claimed = f.registry.claimStructuredHost(key, owner, { allowUnhosted: true })!;
  f.registry.setStructuredHostClaimed(key, { ...claimed.structuredHost!, endpoint: "fixture:current-writer",
    process: owner,
  }, "idle", claimed.claimOwner!, claimed.claimEpoch);
  const before = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
  fs.writeFileSync(artifactPath, JSON.stringify(engine === "codex"
    ? { type: "event_msg", payload: { type: "user_message", message: "Synthetic prior turn" } }
    : { type: "user", message: { role: "user", content: "Synthetic prior turn" } }) + "\n");
  f.journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status",
    payload: { conversationId: conversation.id, sessionKey: key, hostKind: before.structuredHost!.kind,
      host: "hosted", turn: "idle", cwd: f.directory, artifactPath },
  });
  try {
    await recoverPendingStructuredSpawns(f.registry, f.client);
    const after = f.registry.readOnlySnapshot().entries[`${engine}:${sessionId}`]!;
    expect(after.accountId).toBe(before.accountId);
    expect(after.claimOwner).toBe(before.claimOwner);
    expect(after.claimEpoch).toBe(before.claimEpoch);
    expect(after.structuredHost).toEqual(before.structuredHost);
    expect(f.registry.readOnlySnapshot().receipts[begun.receipt.launchId]!.state).toBe(accountMismatch ? "failed" : "completed");
  } finally {
    externalWriter.stdin.end();
    await externalWriter.exited;
    f.journal.close();
  }
});


test("the full retained history completes within the promoted serving budget", async () => {
  const f = fixture(672, true);
  const initial = f.registry.readOnlySnapshot();
  expect(Object.keys(initial.receipts)).toHaveLength(6623);
  expect(Object.keys(initial.conversations)).toHaveLength(8078);
  expect(Object.keys(initial.entries)).toHaveLength(5188);
  const failed = Object.values(initial.receipts).filter((receipt) => receipt.state === "failed");
  // Seed only the runtime's retained session window. Startup must publish the
  // remaining historical registry rows through the real socket and journal.
  for (let i = 0; i < 862; i++) f.journal.append({
    scope: { type: "session", id: `conversation_history_${i}` }, kind: "session-status",
    producer: { kind: "structured-delivery-controller", eventKey: `history:${i}` },
    payload: {
      conversationId: `conversation_history_${i}`, sessionKey: { engine: "codex", sessionId: `history_${i}` },
      hostKind: "codex-app-server", host: "dead", turn: "unknown", provenance: "structured",
      accountId: null, parentConversationId: null, cwd: f.directory,
      artifactPath: path.join(f.directory, `history_${i}.jsonl`), activeTurnId: null,
    },
  });
  const counts: Record<string, number> = {};
  const host = new RuntimeHost(f.journal);
  // A short private endpoint also fits Unix sockaddr limits on CI.
  const socketPath = path.join(isolated, "sockets", "history.sock");
  const server = serveRuntimeHost(socketPath, { handle: async (request, options) => {
    counts[request.method] = (counts[request.method] ?? 0) + 1;
    // Three seconds exceeds the measured 2.6s full snapshot HTTP read. Other
    // calls pay 5ms before actual socket/journal work; live status reads were <1ms.
    await Bun.sleep(request.method === "snapshot" ? 3000 : 5);
    return host.handle(request, options);
  } });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);
  const started = performance.now();
  try {
    await runStructuredHostStartup(() => adoptStructuredHostsAtStartup({
      registry: f.registry, client, refreshTranscriptState: async () => {},
      adopt: async () => [], adoptClaude: async () => [], orchestratorSeats: () => [],
    }), () => {}, { waitUntilReady: true });
    const elapsedMs = performance.now() - started;
    console.log(JSON.stringify({ history: { receipts: 6623, conversations: 8078, entries: 5188 }, counts, elapsedMs }));
    // Keep the optimization below the old deadline despite the new headroom.
    expect(elapsedMs).toBeLessThan(120_000);
    expect(counts.snapshot).toBe(4);
    expect(counts.append).toBeGreaterThan(4300);
    expect(counts["operation-status"]).toBe(1518);
    expect(structuredStartupStatus()?.state).toBe("ready");
    expect(Object.values(f.registry.readOnlySnapshot().receipts).filter((receipt) => receipt.state === "failed").slice(0, 672)).toEqual(failed);
    const contender = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/startupPipelineContender.ts"), f.directory], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const output = new Response(contender.stdout).text();
    const errors = new Response(contender.stderr).text();
    expect(await contender.exited).toBe(0);
    expect(await errors).toBe("");
    expect(JSON.parse(await output)).toMatchObject({ created: true, error: null });
  } finally {
    await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.journal.close();
  }
}, 130_000);
