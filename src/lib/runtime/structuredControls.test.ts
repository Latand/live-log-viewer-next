import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, beforeEach, expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { accountProjectOverrides } from "@/lib/accounts/accountOverrides";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { procBackend } from "@/lib/proc";
import { projectForCwd } from "@/lib/scanner/describe";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { dispatchStructuredControl } from "./structuredControls";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-controls-"));

/* Every account switch below asks the account↔project binding record, which
   lives in the state dir. Pointed at a scratch dir for this whole file, and
   re-pointed before each test, so nothing here reads — or is decided by — the
   operator's live state. */
const STATE = path.join(sandbox, "state");
const RECORD = path.join(STATE, "account-project-bindings.json");
const ORIGINAL_STATE_DIR = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = STATE;

beforeEach(() => {
  process.env.LLV_STATE_DIR = STATE;
  fs.rmSync(RECORD, { force: true });
  fs.rmSync(path.join(STATE, "account-project-overrides.json"), { force: true });
});

afterAll(() => {
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function structuredConversation(
  options: {
    engine?: "claude" | "codex";
    parentConversationId?: `conversation_${string}`;
    registry?: AgentRegistry;
  } = {},
): { registry: AgentRegistry; path: string; conversationId: string } {
  const engine = options.engine ?? "codex";
  const id = crypto.randomUUID();
  const pathname = path.join(sandbox, `${id}.jsonl`);
  const registry = options.registry
    ?? new AgentRegistry(path.join(sandbox, `${id}.registry.json`), undefined, undefined, { sqliteMode: "off" });
  const begun = beginLegacySpawnFixture(registry, {
    engine,
    cwd: sandbox,
    transport: "structured",
    accountId: `${engine}-subscription`,
    ...(options.parentConversationId ? { parentConversationId: options.parentConversationId } : {}),
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine, sessionId: id },
    artifactPath: pathname,
    cwd: sandbox,
    accountId: `${engine}-subscription`,
    status: "live",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: "turn-live",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  return { registry, path: pathname, conversationId: begun.receipt.conversationId };
}

test("structured ownership fences the dialog-key control before legacy routing", async () => {
  const fixture = structuredConversation();
  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "dialog-key" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({ status: 409, body: { error: "structured host does not support the dialog-key control" } });
});

test("structured compact enters the durable command channel for the owned codex thread", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "compact-one", receipt: { operationId: "compact-one", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "compact" }, {
    registry: fixture.registry,
    client,
    operationId: () => "compact-one",
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { operationId: "compact-one", receipt: { status: "pending" } } });
  expect(commands).toEqual([{
    kind: "compact",
    operationId: "compact-one",
    idempotencyKey: "compact-one",
    conversationId: fixture.conversationId,
    sessionKey: {
      engine: "codex",
      sessionId: fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!.generations.at(-1)!.id,
    },
  }]);
});

test("a caller-supplied compact operation id keeps a retry on one durable operation", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "compact-caller", receipt: { operationId: "compact-caller", status: "pending" }, replayed: true };
    },
  } as unknown as RuntimeHostClient;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dispatchStructuredControl({
      path: fixture.path,
      conversationId: "",
      action: "compact",
      operationId: "compact-caller",
    }, { registry: fixture.registry, client, enabled: () => true });
  }

  expect(commands).toEqual([
    { kind: "compact", operationId: "compact-caller", idempotencyKey: "compact-caller", conversationId: fixture.conversationId, sessionKey: { engine: "codex", sessionId: fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!.generations.at(-1)!.id } },
    { kind: "compact", operationId: "compact-caller", idempotencyKey: "compact-caller", conversationId: fixture.conversationId, sessionKey: { engine: "codex", sessionId: fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!.generations.at(-1)!.id } },
  ]);
});

test("a compact transport failure answers from the durable receipt instead of reissuing", async () => {
  const fixture = structuredConversation();
  let commands = 0;
  const client = {
    command: async () => {
      commands += 1;
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    operationStatus: async (operationId: string) => ({
      operationId,
      receipt: { operationId, status: "delivered" },
      replayed: true,
    }),
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "compact",
    operationId: "compact-durable",
  }, { registry: fixture.registry, client, enabled: () => true });

  expect(commands).toBe(1);
  expect(result).toMatchObject({
    status: 200,
    body: { operationId: "compact-durable", receipt: { status: "delivered" } },
  });
});

test("a structured claude conversation enters the same durable command channel (#1214)", async () => {
  const fixture = structuredConversation({ engine: "claude" });
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "compact-claude", receipt: { operationId: "compact-claude", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "compact" }, {
    registry: fixture.registry,
    client,
    operationId: () => "compact-claude",
    enabled: () => true,
  });

  /* The dispatcher no longer refuses the Claude path. The command it sends is
     the same control every engine gets — a generation fence and nothing else;
     the `/compact` text is the host's own, and never travels from here. */
  expect(result).toMatchObject({ status: 202, body: { operationId: "compact-claude", receipt: { status: "pending" } } });
  expect(commands).toEqual([{
    kind: "compact",
    operationId: "compact-claude",
    idempotencyKey: "compact-claude",
    conversationId: fixture.conversationId,
    sessionKey: {
      engine: "claude",
      sessionId: fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!.generations.at(-1)!.id,
    },
  }]);
  expect(commands[0]).not.toHaveProperty("text");
});

test("structured reconfigure validates and enters the runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "reconfigure-one", receipt: { operationId: "reconfigure-one", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-sol", effort: "high", fast: true, accountId: "codex-work" },
  }, {
    registry: fixture.registry,
    client,
    operationId: () => "reconfigure-one",
    accountExists: () => true,
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { operationId: "reconfigure-one", receipt: { status: "queued" } } });
  expect(commands).toEqual([{
    kind: "reconfigure",
    operationId: "reconfigure-one",
    idempotencyKey: "reconfigure-one",
    conversationId: fixture.conversationId,
    sessionKey: {
      engine: "codex",
      sessionId: fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!.generations.at(-1)!.id,
    },
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
    accountId: "codex-work",
    previousProfile: { model: null, effort: null, fast: null },
  }]);

  const invalid = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "claude-opus-4-6", effort: "unknown", fast: true },
  }, { registry: fixture.registry, client, enabled: () => true });
  expect(invalid).toEqual({ status: 400, body: { error: "model is not supported by codex" } });
  expect(commands).toHaveLength(1);
});

test("an applying structured restart keeps a newer reconfigure on the durable command channel", async () => {
  const fixture = structuredConversation();
  fixture.registry.claimConversationReconfigure(fixture.conversationId as `conversation_${string}`, {
    operationId: "reconfigure-restarting",
    revision: 10,
    profile: { model: "gpt-5.6-sol", effort: "max", fast: false },
  });
  terminateStructuredFixture(fixture);
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "reconfigure-newer", receipt: { operationId: "reconfigure-newer", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: fixture.conversationId,
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-terra", effort: "ultra", fast: true },
  }, {
    registry: fixture.registry,
    client,
    operationId: () => "reconfigure-newer",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({
    status: 202,
    body: { structured: true, operationId: "reconfigure-newer", receipt: { status: "queued" } },
  });
  expect(commands).toEqual([expect.objectContaining({
    kind: "reconfigure",
    operationId: "reconfigure-newer",
    conversationId: fixture.conversationId,
  })]);
});

test("a failed structured restart keeps reconfigure routing during host recovery", async () => {
  const fixture = structuredConversation();
  fixture.registry.claimConversationReconfigure(fixture.conversationId as `conversation_${string}`, {
    operationId: "reconfigure-failed",
    revision: 11,
    profile: { model: "gpt-5.6-sol", effort: "max", fast: false },
  });
  terminateStructuredFixture(fixture);
  fixture.registry.settleConversationReconfigure(
    fixture.conversationId as `conversation_${string}`,
    "reconfigure-failed",
    11,
    "failed",
    "replacement failed",
  );
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "reconfigure-after-failure", receipt: { operationId: "reconfigure-after-failure", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: fixture.conversationId,
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-terra", effort: "max", fast: true },
  }, {
    registry: fixture.registry,
    client,
    operationId: () => "reconfigure-after-failure",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({
    status: 202,
    body: { structured: true, operationId: "reconfigure-after-failure", receipt: { status: "queued" } },
  });
  expect(commands).toHaveLength(1);
});

test("resume converges on and republishes an already live structured successor", async () => {
  const fixture = structuredConversation();
  const republished: unknown[] = [];
  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
    republish: async (key) => {
      republished.push(key);
      return true;
    },
  });

  expect(republished).toEqual([{ engine: "codex", sessionId: expect.any(String) }]);
  expect(result).toEqual({
    status: 200,
    body: {
      ok: true,
      structured: true,
      target: fixture.conversationId,
      outcome: "resumed",
      spawned: false,
    },
  });
});

test("stale-live Codex resume recovers the production conversation identity", async () => {
  const fixture = structuredConversation();
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const entry = fixture.registry.snapshot().entries[`${key.engine}:${key.sessionId}`]!;
  const staleProcess = { pid: 1_275_500, startIdentity: "production-start-identity" };
  fixture.registry.setStructuredHostClaimed(key, {
    ...entry.structuredHost!,
    process: staleProcess,
    activeTurnRef: "019f7ac9-2509-\x37f53-a3af-e9400967a43f",
  }, "live", entry.claimOwner!, entry.claimEpoch, true);
  const recoveries: unknown[] = [];

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: fixture.conversationId,
    action: "resume",
  }, {
    registry: fixture.registry,
    enabled: () => true,
    hostProcessAlive: (identity) => {
      expect(identity).toEqual(staleProcess);
      return false;
    },
    recover: async (request) => {
      recoveries.push(request);
      return {
        target: null,
        path: fixture.path,
        conversationId: fixture.conversationId as `conversation_${string}`,
        spawned: true,
      };
    },
  });

  expect(recoveries).toEqual([{
    path: fixture.path,
    conversationId: fixture.conversationId,
  }]);
  expect(result).toEqual({
    status: 200,
    body: {
      ok: true,
      structured: true,
      target: fixture.conversationId,
      outcome: "resumed",
      spawned: true,
    },
  });
});

test("stale-live Claude resume recovers after a PID start-identity mismatch", async () => {
  const fixture = structuredConversation({ engine: "claude" });
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const entry = fixture.registry.snapshot().entries[`${key.engine}:${key.sessionId}`]!;
  fixture.registry.setStructuredHostClaimed(key, {
    ...entry.structuredHost!,
    process: { pid: process.pid, startIdentity: "reused-pid-start-identity" },
    activeTurnRef: "stale-claude-turn",
  }, "live", entry.claimOwner!, entry.claimEpoch, true);
  const recoveries: unknown[] = [];

  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: fixture.conversationId,
    action: "resume",
  }, {
    registry: fixture.registry,
    enabled: () => true,
    recover: async (request) => {
      recoveries.push(request);
      return {
        target: null,
        path: fixture.path,
        conversationId: fixture.conversationId as `conversation_${string}`,
        spawned: true,
      };
    },
  });

  expect(recoveries).toEqual([{
    path: fixture.path,
    conversationId: fixture.conversationId,
  }]);
  expect(result).toMatchObject({
    status: 200,
    body: {
      ok: true,
      target: fixture.conversationId,
      outcome: "resumed",
      spawned: true,
    },
  });
});

test("dead structured resume falls through to canonical recovery", async () => {
  const fixture = structuredConversation();
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const entry = fixture.registry.snapshot().entries[`${key.engine}:${key.sessionId}`]!;
  fixture.registry.setStructuredHostClaimed(key, {
    ...entry.structuredHost!,
    endpoint: "stdio:released",
    process: null,
    activeTurnRef: null,
  }, "dead", entry.claimOwner!, entry.claimEpoch, true);

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "resume" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toBeNull();

  // controls the structured host does not implement stay fenced (only resume recovers)
  const dialogKey = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "dialog-key" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });
  expect(dialogKey).toEqual({ status: 409, body: { error: "structured host does not support the dialog-key control" } });
});

test("structured interrupt uses the runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "interrupt-one", receipt: { operationId: "interrupt-one", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;
  let kicks = 0;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "interrupt" }, {
    registry: fixture.registry,
    client,
    operationId: () => "interrupt-one",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "interrupt",
    operationId: "interrupt-one",
    idempotencyKey: "interrupt-one",
    conversationId: fixture.conversationId,
    turnId: "turn-live",
  }]);
  expect(kicks).toBe(1);
});

test("structured kill enters the durable runtime command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "kill-one", receipt: { operationId: "kill-one", status: "pending" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;
  let kicks = 0;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-one",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "kill",
    operationId: "kill-one",
    idempotencyKey: "kill-one",
    conversationId: fixture.conversationId,
    sessionKey: { engine: "codex", sessionId: expect.any(String) },
  }]);
  expect(kicks).toBe(1);
});

function terminateStructuredFixture(fixture: { registry: AgentRegistry; conversationId: string }): void {
  const conversation = fixture.registry.conversation(fixture.conversationId as `conversation_${string}`)!;
  const generation = conversation.generations.at(-1)!;
  fixture.registry.terminateStructuredHost({ engine: conversation.engine, sessionId: generation.id });
}

test("structured kill addressed by conversationId enters the durable command channel", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "kill-by-id", receipt: { operationId: "kill-by-id", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-by-id",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, target: fixture.conversationId } });
  expect(commands).toEqual([{
    kind: "kill",
    operationId: "kill-by-id",
    idempotencyKey: "kill-by-id",
    conversationId: fixture.conversationId,
    sessionKey: { engine: "codex", sessionId: expect.any(String) },
  }]);
});

test("a delivered kill receipt resolves as a terminal success, not a failure", async () => {
  const fixture = structuredConversation();
  const client = {
    command: async () => ({
      operationId: "kill-delivered",
      receipt: { operationId: "kill-delivered", status: "delivered" },
      replayed: true,
    }),
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-delivered",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, receipt: { status: "delivered" } },
  });
});

test("a kill transport timeout after journal admission reports the durable receipt", async () => {
  const fixture = structuredConversation();
  const probes: string[] = [];
  let kicks = 0;
  const client = {
    command: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    operationStatus: async (operationId: string) => {
      probes.push(operationId);
      return {
        operationId,
        receipt: { operationId, status: "delivered", conversationId: fixture.conversationId },
        replayed: true,
      };
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-timeout",
    kick: () => { kicks += 1; },
    enabled: () => true,
  });

  expect(probes).toEqual(["kill-timeout"]);
  expect(kicks).toBe(1);
  expect(result).toMatchObject({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, operationId: "kill-timeout", receipt: { status: "delivered" } },
  });
});

test("a kill transport timeout with no durable record stays a retryable failure", async () => {
  const fixture = structuredConversation();
  const client = {
    command: async () => {
      throw new RuntimeHostUnavailableError("runtime host request timed out");
    },
    operationStatus: async () => null,
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client,
    operationId: () => "kill-lost",
    kick: () => {},
    enabled: () => true,
  });

  expect(result).toEqual({ status: 503, body: { error: "runtime host request timed out" } });
});

test("a dead structured session replays its terminal kill outcome for path callers", async () => {
  const fixture = structuredConversation();
  terminateStructuredFixture(fixture);

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "kill" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, outcome: "delivered" },
  });
});

test("a dead structured session replays its terminal kill outcome for conversation-id callers", async () => {
  const fixture = structuredConversation();
  terminateStructuredFixture(fixture);

  const result = await dispatchStructuredControl({ path: "", conversationId: fixture.conversationId, action: "kill" }, {
    registry: fixture.registry,
    client: null,
    enabled: () => true,
  });

  expect(result).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: fixture.conversationId, outcome: "delivered" },
  });
});

test("a dead structured branch replays terminal kill without branch/root pane failures", async () => {
  const root = structuredConversation();
  const branch = structuredConversation({
    registry: root.registry,
    parentConversationId: root.conversationId as `conversation_${string}`,
  });
  terminateStructuredFixture(branch);
  terminateStructuredFixture(root);

  const branchResult = await dispatchStructuredControl({ path: branch.path, conversationId: "", action: "kill" }, {
    registry: root.registry,
    client: null,
    enabled: () => true,
  });
  const rootResult = await dispatchStructuredControl({ path: "", conversationId: root.conversationId, action: "kill" }, {
    registry: root.registry,
    client: null,
    enabled: () => true,
  });

  expect(branchResult).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: branch.conversationId, outcome: "delivered" },
  });
  expect(rootResult).toEqual({
    status: 200,
    body: { ok: true, structured: true, target: root.conversationId, outcome: "delivered" },
  });
});

test("disabled structured hosting leaves persisted ownership on the legacy control path", async () => {
  const fixture = structuredConversation();
  const commands: unknown[] = [];
  const client = {
    command: async (command: unknown) => {
      commands.push(command);
      throw new Error("disabled structured control reached the runtime host");
    },
  } as unknown as RuntimeHostClient;

  const result = await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "interrupt" }, {
    registry: fixture.registry,
    client,
    enabled: () => false,
  });

  expect(result).toBeNull();
  expect(commands).toEqual([]);
});

test("ordinary message routing remains outside the explicit-control module", async () => {
  const fixture = structuredConversation();
  expect(await dispatchStructuredControl({ path: fixture.path, conversationId: "", action: "" }, { registry: fixture.registry, enabled: () => true }))
    .toBeNull();
});


/* #1279 at the structured reconfigure seam. The account switch a structured
   conversation takes is the path that PLACES its work on an account, and it
   returned before the legacy path without consulting the binding at all.

   What it owes the binding is ATTRIBUTION, not a veto: the pool is the default
   the Viewer selects from on its own, and a deliberate switch — by the operator
   or by an agent acting for them — is a control that reaches outside it and is
   recorded when it does. Account ids here are invented; nothing names a real
   account. */

const ALLOWED_ACCOUNT = "codex-reserved";
const OUTSIDE_ACCOUNT = "codex-outside";

function recordingClient(commands: unknown[]): RuntimeHostClient {
  return {
    command: async (command: unknown) => {
      commands.push(command);
      return { operationId: "reconfigure-choice", receipt: { operationId: "reconfigure-choice", status: "queued" }, replayed: false };
    },
  } as unknown as RuntimeHostClient;
}

async function switchAccount(
  fixture: { registry: AgentRegistry; path: string },
  accountId: string,
  commands: unknown[],
  request: Partial<Parameters<typeof dispatchStructuredControl>[0]> = {},
  dependencies: Parameters<typeof dispatchStructuredControl>[1] = {},
) {
  return dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-sol", effort: "high", fast: true, accountId },
    ...request,
  }, {
    registry: fixture.registry,
    client: recordingClient(commands),
    operationId: () => "reconfigure-choice",
    accountExists: () => true,
    enabled: () => true,
    ...dependencies,
  });
}

test("a deliberate switch outside the project's pool is carried out and attributed", async () => {
  const fixture = structuredConversation();
  const project = projectForCwd(sandbox);
  expect(project).toBeTruthy();
  expect(bindAccountToProject("codex", ALLOWED_ACCOUNT, project!).ok).toBe(true);

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, OUTSIDE_ACCOUNT, commands);

  /* The choice stands: the operator asked for this account by name. */
  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true } });
  expect(commands).toMatchObject([{ kind: "reconfigure", accountId: OUTSIDE_ACCOUNT }]);
  /* And the answer says plainly that it went outside the pool. */
  expect(result).toMatchObject({
    body: {
      accountOverride: {
        outsidePool: true,
        accountId: OUTSIDE_ACCOUNT,
        project,
        allowedAccountIds: [ALLOWED_ACCOUNT],
        reason: "outside-pool",
        actor: "operator",
        recorded: true,
      },
    },
  });
  /* The durable record the project view renders: who, when, and what the pool
     was at that moment. */
  expect(accountProjectOverrides({ project, engine: "codex" })).toMatchObject([{
    accountId: OUTSIDE_ACCOUNT,
    actor: "operator",
    actorConversationId: null,
    conversationId: fixture.conversationId,
    reason: "outside-pool",
    via: "structured-reconfigure",
    allowedAccountIds: [ALLOWED_ACCOUNT],
  }]);
});

test("an agent's out-of-pool switch is recorded under the agent that made it", async () => {
  const fixture = structuredConversation();
  const project = projectForCwd(sandbox);
  expect(bindAccountToProject("codex", ALLOWED_ACCOUNT, project!).ok).toBe(true);

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, OUTSIDE_ACCOUNT, commands, {
    actor: { kind: "agent", conversationId: "conversation_caller" },
  });

  expect(result).toMatchObject({ status: 202, body: { accountOverride: { actor: "agent" } } });
  expect(commands).toHaveLength(1);
  expect(accountProjectOverrides({ project })).toMatchObject([{
    actor: "agent",
    actorConversationId: "conversation_caller",
  }]);
});

test("a switch inside the allowed set is unchanged, and attributes nothing", async () => {
  const fixture = structuredConversation();
  const project = projectForCwd(sandbox);
  expect(bindAccountToProject("codex", ALLOWED_ACCOUNT, project!).ok).toBe(true);

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, ALLOWED_ACCOUNT, commands);

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true, operationId: "reconfigure-choice" } });
  expect((result as { body: Record<string, unknown> }).body).not.toHaveProperty("accountOverride");
  expect(commands).toMatchObject([{ kind: "reconfigure", accountId: ALLOWED_ACCOUNT }]);
  expect(accountProjectOverrides()).toEqual([]);
});

test("an unbound project switches exactly as it always did", async () => {
  const fixture = structuredConversation();
  expect(fs.existsSync(RECORD)).toBe(false);

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, OUTSIDE_ACCOUNT, commands);

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true } });
  expect((result as { body: Record<string, unknown> }).body).not.toHaveProperty("accountOverride");
  expect(commands).toMatchObject([{ kind: "reconfigure", accountId: OUTSIDE_ACCOUNT }]);
  expect(accountProjectOverrides()).toEqual([]);
});

test("a binding record this process cannot read does not veto a named choice, and is recorded as unreadable", async () => {
  const fixture = structuredConversation();
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(RECORD, '{"schemaVersion":1,"bindings":[{"engine":"codex"', "utf8");

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, OUTSIDE_ACCOUNT, commands);

  /* A damaged file is not a decision anybody made: it fails closed for what the
     Viewer picks on its own, and must not stand in for the operator's choice. */
  expect(result).toMatchObject({
    status: 202,
    body: { accountOverride: { reason: "binding-unreadable", allowedAccountIds: null, recorded: true } },
  });
  expect(commands).toMatchObject([{ kind: "reconfigure", accountId: OUTSIDE_ACCOUNT }]);
  expect(accountProjectOverrides()).toMatchObject([{ reason: "binding-unreadable", accountId: OUTSIDE_ACCOUNT }]);
});

test("the choice is classified against the conversation's durable project, not the caller's word for it", async () => {
  const fixture = structuredConversation();
  const asked: unknown[] = [];
  const commands: unknown[] = [];

  await switchAccount(fixture, OUTSIDE_ACCOUNT, commands, {}, {
    attributeAccountChoice: (choice) => {
      asked.push(choice);
      return null;
    },
  });

  expect(asked).toMatchObject([{
    engine: "codex",
    project: projectForCwd(sandbox),
    accountId: OUTSIDE_ACCOUNT,
    conversationId: fixture.conversationId,
    via: "structured-reconfigure",
  }]);
});

test("re-stating the account a conversation already runs on moves nothing, and records nothing", async () => {
  const fixture = structuredConversation();
  const project = projectForCwd(sandbox);
  /* The account this fixture is already on, and one the project does not
     allow: a reconfigure that repeats it is a model change, not a switch. */
  expect(bindAccountToProject("codex", ALLOWED_ACCOUNT, project!).ok).toBe(true);

  const commands: unknown[] = [];
  const result = await switchAccount(fixture, "codex-subscription", commands);

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true } });
  expect((result as { body: Record<string, unknown> }).body).not.toHaveProperty("accountOverride");
  expect(accountProjectOverrides()).toEqual([]);
});

test("a reconfigure that names no account never consults the binding record", async () => {
  const fixture = structuredConversation();
  fs.mkdirSync(STATE, { recursive: true });
  /* A record damaged badly enough that any read of it refuses: a model change
     still behaves exactly as it does today, because it places this
     conversation's work on no new account. */
  fs.writeFileSync(RECORD, "{ not json", "utf8");

  const commands: unknown[] = [];
  const result = await dispatchStructuredControl({
    path: fixture.path,
    conversationId: "",
    action: "reconfigure",
    reconfiguration: { model: "gpt-5.6-sol", effort: "high", fast: true },
  }, {
    registry: fixture.registry,
    client: recordingClient(commands),
    operationId: () => "reconfigure-choice",
    enabled: () => true,
  });

  expect(result).toMatchObject({ status: 202, body: { ok: true, structured: true } });
  expect((result as { body: Record<string, unknown> }).body).not.toHaveProperty("accountOverride");
  expect(commands).toMatchObject([{ kind: "reconfigure", model: "gpt-5.6-sol" }]);
  expect(accountProjectOverrides()).toEqual([]);
});
