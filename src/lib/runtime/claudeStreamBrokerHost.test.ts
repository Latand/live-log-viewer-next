import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, spyOn, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";

import {
  ClaudeStreamBrokerHost,
  FileClaudeDeliveryLedger,
  type ClaudeDeliveryLedger,
  type ClaudeDeliveryState,
} from "./claudeStreamBrokerHost";
import type { RuntimeEventStore } from "./eventStore";
import type { HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import {
  adoptClaudeRegistryHosts,
  bindClaudeHostPersistence,
  demoteSkippedStructuredRegistryHosts,
  startClaudeStructuredHost,
} from "./registry";

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();

  load(sessionId: string): RuntimeEvent[] {
    return structuredClone(this.events.get(sessionId) ?? []);
  }

  append(sessionId: string, event: RuntimeEvent): void {
    const events = this.events.get(sessionId) ?? [];
    events.push(structuredClone(event));
    this.events.set(sessionId, events);
  }
}

class FailingEventStore implements RuntimeEventStore {
  readonly events: RuntimeEvent[] = [];
  appendAttempts = 0;

  load(): RuntimeEvent[] { return structuredClone(this.events); }

  append(_sessionId: string, event: RuntimeEvent): void {
    this.appendAttempts += 1;
    if (this.appendAttempts >= 2) throw new Error("ENOSPC oauth_token=must-stay-private");
    this.events.push(structuredClone(event));
  }
}

class RecordingDeliveryLedger implements ClaudeDeliveryLedger {
  readonly order: string[] = [];
  private readonly states = new Map<string, ClaudeDeliveryState[]>();

  load(sessionId: string): ClaudeDeliveryState[] {
    return structuredClone(this.states.get(sessionId) ?? []);
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    this.order.push(`ledger:${entry.id}`);
    const states = this.states.get(sessionId) ?? [];
    states.push({ entry: structuredClone(entry), disposition, delivered: false });
    this.states.set(sessionId, states);
  }

  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null): void {
    this.order.push(`confirmed:${entryId}`);
    const state = this.states.get(sessionId)?.find((candidate) => candidate.entry.id === entryId);
    if (state) {
      state.delivered = true;
      state.engineMessageId = engineMessageId;
    }
  }
}

class FakeClaude extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5150;
  readonly signals: NodeJS.Signals[] = [];
  readonly inputs: Array<Record<string, unknown>> = [];
  sessionId = "";

  constructor(
    private readonly ledger: RecordingDeliveryLedger,
    private readonly ignoreTerm = false,
    private readonly ignoreKill = false,
  ) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          const input = JSON.parse(line) as Record<string, unknown>;
          this.inputs.push(input);
          const message = input.message as { content?: Array<{ text?: string }> } | undefined;
          if (input.type === "user") {
            this.ledger.order.push(`stdin:${message?.content?.[0]?.text}`);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  }

  emitJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    if (signal === "SIGKILL" && this.ignoreKill) return true;
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

function fakeSpawn(
  child: FakeClaude,
  captured: { args?: string[]; options?: SpawnOptionsWithoutStdio },
) {
  return (_command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    captured.args = args;
    captured.options = options;
    const sessionIndex = args.indexOf("--session-id");
    child.sessionId = args[sessionIndex + 1] ?? "";
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

async function nextEvent(iterator: AsyncIterator<RuntimeEvent>): Promise<RuntimeEvent> {
  const next = await iterator.next();
  if (next.done) throw new Error("event stream ended");
  return next.value;
}

describe("ClaudeStreamBrokerHost", () => {
  test("passes bypassPermissions to the pane-less Claude process", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      permissionMode: "bypassPermissions",
      eventStore: new MemoryEventStore(),
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: fakeSpawn(child, captured),
    });

    const modeIndex = captured.args!.indexOf("--permission-mode");
    expect(captured.args?.slice(modeIndex, modeIndex + 2)).toEqual(["--permission-mode", "bypassPermissions"]);
    await host.release();
  });

  test.each([0, 2])("anchors resumed Claude emission after durable sequence 1 when the registry cursor is %i", async (registryCursor) => {
    const sessionId = `claude-cursor-${registryCursor}`;
    const eventStore = new MemoryEventStore();
    eventStore.append(sessionId, { kind: "session-status", status: "idle", seq: 1 });
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const diagnostics: unknown[] = [];

    const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      initialEventCursor: registryCursor,
      onEventCursorRecovery: (diagnostic) => diagnostics.push(diagnostic),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });

    expect(eventStore.load(sessionId).slice(-2)).toEqual([
      { kind: "session-status", status: "idle", seq: 1 },
      { kind: "session-status", status: "idle", seq: 2 },
    ]);
    expect(await host.health()).toMatchObject({ eventCursor: 2, status: "idle" });
    expect(diagnostics).toEqual([expect.objectContaining({
      kind: "runtime-event-cursor-recovery",
      sessionId,
      durableTailSeq: 1,
      registryCursor,
      chosenNextSeq: 2,
      action: "use-durable-tail",
    })]);
    await host.release();
  });

  test("fails closed before Claude emission advances beyond the safe-integer cursor range", async () => {
    const sessionId = "claude-cursor-near-safe-limit";
    const eventStore = new MemoryEventStore();
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      initialEventCursor: Number.MAX_SAFE_INTEGER - 1,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    expect(eventStore.load(sessionId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);

    child.emitJson({
      type: "user",
      isReplay: true,
      session_id: sessionId,
      uuid: "unsafe-cursor-user",
      message: { role: "user", content: [{ type: "text", text: "remain bounded" }] },
    });
    await Bun.sleep(0);

    expect(eventStore.load(sessionId)).toEqual([
      { kind: "session-status", status: "idle", seq: Number.MAX_SAFE_INTEGER },
    ]);
    expect(await host.health()).toMatchObject({ status: "dead", eventCursor: Number.MAX_SAFE_INTEGER });
    await host.release();
  });

  test("persists sends before stdin and fans durable events to late viewers", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const eventStore = new MemoryEventStore();
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "must-not-cross",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-cross",
        PRIVATE_SERVICE_TOKEN: "must-not-cross",
      },
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.197" }),
      spawnProcess: fakeSpawn(child, captured),
    });

    expect(captured.options?.env).toEqual({ NODE_ENV: "test", PATH: process.env.PATH });
    expect(captured.args).toContain("--input-format");
    expect(captured.args).toContain("--output-format");
    expect(captured.args).toContain("--safe-mode");
    expect(captured.args).toContain("--disallowedTools");
    expect(captured.args).toContain("Task,Agent");
    expect(captured.args).toContain("--replay-user-messages");
    expect(captured.args).toContain("--permission-prompt-tool");
    expect(captured.args?.at(captured.args.indexOf("--permission-prompt-tool") + 1)).toBe("stdio");
    expect(captured.args?.slice(-2)).toEqual(["--session-id", host.identity.sessionId]);
    const owner = host.attach(0)[Symbol.asyncIterator]();
    expect(await nextEvent(owner)).toEqual({ kind: "session-status", status: "idle", seq: 1 });

    let sendSettled = false;
    const pendingReceipt = host.send({ id: "delivery-one", text: "begin" }).finally(() => { sendSettled = true; });
    await Bun.sleep(0);
    expect(sendSettled).toBeFalse();
    expect(ledger.order.slice(0, 2)).toEqual(["ledger:delivery-one", "stdin:begin"]);
    expect(child.inputs.find((input) => input.type === "user")).toMatchObject({
      message: { role: "user" },
    });

    child.emitJson({ type: "system", subtype: "init", session_id: host.identity.sessionId, apiKeySource: "none", model: "claude-test" });
    child.emitJson({ type: "user", isReplay: true, session_id: host.identity.sessionId, uuid: "user-one", message: { role: "user", content: [{ type: "text", text: "begin" }] } });
    child.emitJson({ type: "assistant", session_id: host.identity.sessionId, message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    child.emitJson({ type: "result", subtype: "success", session_id: host.identity.sessionId, result: "done" });

    expect(await pendingReceipt).toEqual({ outcome: "turn-started", turnId: "delivery-one" });

    expect(await nextEvent(owner)).toEqual({ kind: "turn-started", turnId: "delivery-one", seq: 2 });
    expect(await nextEvent(owner)).toMatchObject({ kind: "item", turnId: "delivery-one", phase: "completed" });
    expect(await nextEvent(owner)).toEqual({ kind: "delta", turnId: "delivery-one", text: "done", seq: 4 });
    expect(await nextEvent(owner)).toMatchObject({ kind: "item", turnId: "delivery-one", phase: "completed" });
    expect(await nextEvent(owner)).toEqual({ kind: "turn-ended", turnId: "delivery-one", status: "completed", seq: 6 });
    expect(await nextEvent(owner)).toEqual({ kind: "session-status", status: "idle", seq: 7 });
    expect(ledger.order).toContain("confirmed:delivery-one");

    const late = host.attach(3)[Symbol.asyncIterator]();
    expect(await nextEvent(late)).toEqual({ kind: "delta", turnId: "delivery-one", text: "done", seq: 4 });
    expect((await host.health()).account).toEqual({ type: "claude.ai", planType: "max" });
    await host.release();
  });

  test("structured Claude hosts install the deny profile and preserve the explicit escape", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-structured-policy-"));
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ theme: "dark" }));

    const deniedLedger = new RecordingDeliveryLedger();
    const deniedChild = new FakeClaude(deniedLedger);
    const deniedCapture: { args?: string[] } = {};
    const denied = await ClaudeStreamBrokerHost.start({
      cwd: home,
      claudeConfigDir: home,
      deliveryLedger: deniedLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(deniedChild, deniedCapture),
    });
    const deniedSettingsIndex = deniedCapture.args!.indexOf("--settings");
    const deniedSettings = JSON.parse(fs.readFileSync(deniedCapture.args![deniedSettingsIndex + 1]!, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(deniedSettingsIndex).toBeGreaterThanOrEqual(0);
    expect(deniedCapture.args).toContain("Task,Agent");
    expect(deniedSettings.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent")).toBe(true);
    await denied.release();

    const allowedLedger = new RecordingDeliveryLedger();
    const allowedChild = new FakeClaude(allowedLedger);
    const allowedCapture: { args?: string[] } = {};
    const allowed = await ClaudeStreamBrokerHost.adopt("allowed-structured-session", {
      cwd: home,
      claudeConfigDir: home,
      allowSubagents: true,
      deliveryLedger: allowedLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(allowedChild, allowedCapture),
    });
    const allowedSettingsIndex = allowedCapture.args!.indexOf("--settings");
    const allowedSettings = JSON.parse(fs.readFileSync(allowedCapture.args![allowedSettingsIndex + 1]!, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(allowedSettingsIndex).toBeGreaterThanOrEqual(0);
    expect(allowedCapture.args).not.toContain("Task,Agent");
    expect(allowedSettings.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent")).toBe(false);
    await allowed.release();
  });

  test("managed fresh and adopted hosts share one settings profile while legacy settings stay local", async () => {
    const managedHome = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-managed-policy-"));
    const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-shared-policy-"));
    const sharedSettingsPath = path.join(sharedHome, "settings.json");
    fs.writeFileSync(sharedSettingsPath, JSON.stringify({
      theme: "shared-dark",
      env: { SHARED_SETTING: "kept" },
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "shared-read-hook" }] }] },
    }));

    const freshChild = new FakeClaude(new RecordingDeliveryLedger());
    const freshCapture: { args?: string[] } = {};
    const fresh = await ClaudeStreamBrokerHost.start({
      sessionId: "managed-policy-session",
      cwd: managedHome,
      claudeConfigDir: managedHome,
      spawnPolicyBaseSettingsPath: sharedSettingsPath,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(freshChild, freshCapture),
    });
    const freshSettingsPath = freshCapture.args![freshCapture.args!.indexOf("--settings") + 1]!;
    const freshSettings = JSON.parse(fs.readFileSync(freshSettingsPath, "utf8")) as {
      theme: string;
      env: Record<string, string>;
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    await fresh.release();

    const adoptedChild = new FakeClaude(new RecordingDeliveryLedger());
    const adoptedCapture: { args?: string[] } = {};
    const adopted = await ClaudeStreamBrokerHost.adopt("managed-policy-session", {
      cwd: managedHome,
      claudeConfigDir: managedHome,
      spawnPolicyBaseSettingsPath: sharedSettingsPath,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(adoptedChild, adoptedCapture),
    });
    const adoptedSettingsPath = adoptedCapture.args![adoptedCapture.args!.indexOf("--settings") + 1]!;
    const adoptedSettings = JSON.parse(fs.readFileSync(adoptedSettingsPath, "utf8"));
    expect(freshSettings.theme).toBe("shared-dark");
    expect(freshSettings.env).toEqual({ SHARED_SETTING: "kept" });
    expect(freshSettings.hooks.PreToolUse.map((group) => group.matcher)).toEqual(["Read", "Task|Agent"]);
    expect(adoptedSettings).toEqual(freshSettings);
    await adopted.release();

    const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-legacy-policy-"));
    const legacySettingsPath = path.join(legacyHome, "settings.json");
    const legacySettings = JSON.stringify({ theme: "legacy-light", custom: { owner: "legacy" } });
    fs.writeFileSync(legacySettingsPath, legacySettings);
    const legacyChild = new FakeClaude(new RecordingDeliveryLedger());
    const legacyCapture: { args?: string[] } = {};
    const legacy = await ClaudeStreamBrokerHost.start({
      sessionId: "legacy-policy-session",
      cwd: legacyHome,
      claudeConfigDir: legacyHome,
      spawnPolicyBaseSettingsPath: null,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(legacyChild, legacyCapture),
    });
    const legacyProfilePath = legacyCapture.args![legacyCapture.args!.indexOf("--settings") + 1]!;
    const legacyProfile = JSON.parse(fs.readFileSync(legacyProfilePath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(legacyProfile.hooks.PreToolUse.some((group) => group.matcher === "Task|Agent")).toBe(true);
    expect(fs.readFileSync(legacySettingsPath, "utf8")).toBe(legacySettings);
    await legacy.release();
  });

  test("confirms delivery only from replayed user-role frames", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: fakeSpawn(child, {}),
    });
    let settled = false;
    const sent = host.send({ id: "replay-only", text: "match me" }).finally(() => { settled = true; });

    child.emitJson({ type: "user", isReplay: false, session_id: host.identity.sessionId, uuid: "ordinary", message: { role: "user", content: [{ type: "text", text: "match me" }] } });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    child.emitJson({ type: "user", isReplay: true, session_id: host.identity.sessionId, uuid: "wrong-role", message: { role: "tool", content: [{ type: "text", text: "match me" }] } });
    await Bun.sleep(0);
    expect(settled).toBeFalse();
    child.emitJson({ type: "user", isReplay: true, session_id: host.identity.sessionId, uuid: "replay", message: { role: "user", content: [{ type: "text", text: "match me" }] } });
    expect(await sent).toEqual({ outcome: "turn-started", turnId: "replay-only" });
    await host.release();
  });

  test("preserves split UTF-8 replay text for delivery confirmation", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: fakeSpawn(child, {}),
    });
    let receipt: Awaited<ReturnType<typeof host.send>> | undefined;
    const sent = host.send({ id: "utf8-replay", text: "привіт" }).then((value) => { receipt = value; });
    const frame = Buffer.from(`${JSON.stringify({
      type: "user",
      isReplay: true,
      session_id: host.identity.sessionId,
      uuid: "utf8-user",
      message: { role: "user", content: [{ type: "text", text: "привіт" }] },
    })}\n`);
    const textStart = frame.indexOf(Buffer.from("привіт"));
    expect(textStart).toBeGreaterThanOrEqual(0);
    child.stdout.write(frame.subarray(0, textStart + 1));
    child.stdout.write(frame.subarray(textStart + 1));
    await Bun.sleep(0);
    const confirmed = receipt;
    await host.release();
    await sent.catch(() => {});

    expect(confirmed).toEqual({ outcome: "turn-started", turnId: "utf8-replay" });
  });

  test("queues ordinary active-turn sends and resumes the same durable session", async () => {
    const ledger = new RecordingDeliveryLedger();
    const eventStore = new MemoryEventStore();
    const firstChild = new FakeClaude(ledger);
    const first = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(firstChild, {}),
    });
    const sessionId = first.identity.sessionId;
    const firstSend = first.send({ id: "first", text: "one" });
    firstChild.emitJson({ type: "user", isReplay: true, session_id: sessionId, uuid: "user-one", message: { role: "user", content: [{ type: "text", text: "one" }] } });
    expect(await firstSend).toEqual({ outcome: "turn-started", turnId: "first" });
    const secondSend = first.send({ id: "second", text: "two" });
    const duplicateSecond = first.send({ id: "second", text: "two" });
    expect(firstChild.inputs.filter((input) => input.type === "user")).toHaveLength(2);
    firstChild.emitJson({ type: "result", subtype: "success", session_id: sessionId });
    expect((await first.health()).activeTurnRef).toBe("second");
    firstChild.emitJson({ type: "user", isReplay: true, session_id: sessionId, uuid: "user-two", message: { role: "user", content: [{ type: "text", text: "two" }] } });
    expect(await secondSend).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    expect(await duplicateSecond).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    firstChild.emitJson({ type: "result", subtype: "success", session_id: sessionId });
    await first.release();

    const replacementChild = new FakeClaude(ledger);
    const captured: { args?: string[] } = {};
    const replacement = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      eventStore,
      deliveryLedger: ledger,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(replacementChild, captured),
    });
    expect(captured.args).toContain("--resume");
    expect(captured.args?.at(captured.args.indexOf("--resume") + 1)).toBe(sessionId);
    expect(await replacement.send({ id: "second", text: "two" })).toEqual({ outcome: "queued-next-turn", turnId: "second" });
    expect(replacementChild.inputs).toHaveLength(0);
    await replacement.release();
  });

  test("retries a ledgered pre-actuation entry and confirms an actuated entry from transcript", async () => {
    const pendingLedger = new RecordingDeliveryLedger();
    const pendingEntry: QueueEntry = {
      id: "pending",
      text: "retry me",
      expectedTurnId: "turn-before-crash",
    };
    pendingLedger.recordQueued("pending-session", pendingEntry, "queued-next-turn");
    const pendingChild = new FakeClaude(pendingLedger);
    const pending = await ClaudeStreamBrokerHost.adopt("pending-session", {
      cwd: "/repo",
      deliveryLedger: pendingLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(pendingChild, {}),
    });
    expect((await pending.health()).activeTurnRef).toBeNull();
    const retried = pending.send(pendingEntry);
    pendingChild.emitJson({ type: "user", isReplay: true, session_id: "pending-session", uuid: "retried-user", message: { role: "user", content: [{ type: "text", text: "retry me" }] } });
    expect(await retried).toEqual({ outcome: "queued-next-turn", turnId: "pending" });
    expect(pendingChild.inputs.filter((input) => input.type === "user")).toHaveLength(1);
    await pending.release();

    const confirmedLedger = new RecordingDeliveryLedger();
    confirmedLedger.recordQueued("confirmed-session", { id: "confirmed", text: "already sent" }, "turn-started");
    const confirmedChild = new FakeClaude(confirmedLedger);
    const confirmed = await ClaudeStreamBrokerHost.adopt("confirmed-session", {
      cwd: "/repo",
      deliveryLedger: confirmedLedger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [{ text: "already sent", uuid: "transcript-user", timestamp: new Date().toISOString() }],
      spawnProcess: fakeSpawn(confirmedChild, {}),
    });
    expect(await confirmed.send({ id: "confirmed", text: "already sent" })).toEqual({ outcome: "turn-started", turnId: "confirmed" });
    expect(confirmedChild.inputs).toHaveLength(0);
    expect(confirmedLedger.order).toContain("confirmed:confirmed");
    await confirmed.release();
  });

  test("rejects a changed payload before retrying an undelivered ledger entry", async () => {
    const sessionId = "immutable-pending-session";
    const ledger = new RecordingDeliveryLedger();
    ledger.recordQueued(sessionId, { id: "immutable-entry", text: "original" }, "turn-started");
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });

    await expect(host.send({ id: "immutable-entry", text: "changed" })).rejects.toThrow("different payload");
    expect(child.inputs.filter((input) => input.type === "user")).toHaveLength(0);
    await host.release();
  });

  test("rejects changed queue fields for an entry already confirmed delivered", async () => {
    const sessionId = "immutable-delivered-session";
    const original: QueueEntry = { id: "immutable-entry", text: "original", expectedTurnId: null };
    const ledger = new RecordingDeliveryLedger();
    ledger.recordQueued(sessionId, original, "turn-started");
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [{ text: "original", uuid: "original-user", timestamp: new Date().toISOString() }],
      spawnProcess: fakeSpawn(child, {}),
    });

    await expect(host.send({ ...original, text: "changed" })).rejects.toThrow("different payload");
    await expect(host.send({ ...original, expectedTurnId: "changed-turn" })).rejects.toThrow("different payload");
    expect(await host.send(original)).toEqual({ outcome: "turn-started", turnId: "immutable-entry" });
    expect(child.inputs).toHaveLength(0);
    await host.release();
  });

  test("host loss rejects an unconfirmed send and leaves retry ownership for adoption", async () => {
    const ledger = new RecordingDeliveryLedger();
    const eventStore = new MemoryEventStore();
    const firstChild = new FakeClaude(ledger);
    const first = await ClaudeStreamBrokerHost.adopt("retry-session", {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(firstChild, {}),
    });
    const unconfirmed = first.send({ id: "retry-entry", text: "retry after crash" });
    firstChild.emit("close", 1, null);
    await expect(unconfirmed).rejects.toThrow("Claude child exited");
    await first.release();

    const replacementChild = new FakeClaude(ledger);
    const replacement = await ClaudeStreamBrokerHost.adopt("retry-session", {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(replacementChild, {}),
    });
    const retried = replacement.send({ id: "retry-entry", text: "retry after crash" });
    expect(replacementChild.inputs.filter((input) => input.type === "user")).toHaveLength(1);
    replacementChild.emitJson({ type: "user", isReplay: true, session_id: "retry-session", uuid: "retry-user", message: { role: "user", content: [{ type: "text", text: "retry after crash" }] } });
    expect(await retried).toEqual({ outcome: "turn-started", turnId: "retry-entry" });
    await replacement.release();
  });

  test("a missing replay confirmation times out and leaves retry ownership for adoption", async () => {
    const ledger = new RecordingDeliveryLedger();
    const eventStore = new MemoryEventStore();
    const firstChild = new FakeClaude(ledger);
    const first = await ClaudeStreamBrokerHost.adopt("timeout-session", {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      requestTimeoutMs: 5,
      shutdownGraceMs: 5,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(firstChild, {}),
    });

    await expect(first.send({ id: "timeout-entry", text: "retry after timeout" }))
      .rejects.toThrow("delivery confirmation timed out");
    expect((await first.health()).status).toBe("dead");
    expect(ledger.load("timeout-session")).toContainEqual(expect.objectContaining({
      entry: { id: "timeout-entry", text: "retry after timeout" },
      delivered: false,
    }));
    await first.release();

    const replacementChild = new FakeClaude(ledger);
    const replacement = await ClaudeStreamBrokerHost.adopt("timeout-session", {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      requestTimeoutMs: 1_000,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(replacementChild, {}),
    });
    const retried = replacement.send({ id: "timeout-entry", text: "retry after timeout" });
    replacementChild.emitJson({
      type: "user",
      isReplay: true,
      session_id: "timeout-session",
      uuid: "retry-timeout-user",
      message: { role: "user", content: [{ type: "text", text: "retry after timeout" }] },
    });
    expect(await retried).toEqual({ outcome: "turn-started", turnId: "timeout-entry" });
    await replacement.release();
  });

  test("managed Claude adoption uses its credential home and transcript root", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-managed-claude-host-"));
    const configDir = path.join(directory, "account");
    const projectsDir = path.join(configDir, "projects");
    const sessionId = "managed-session";
    const transcript = path.join(projectsDir, "-repo", `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      uuid: "managed-user",
      message: { role: "user", content: [{ type: "text", text: "managed prompt" }] },
    })}\n`);
    const ledger = new RecordingDeliveryLedger();
    ledger.recordQueued(sessionId, { id: "managed-entry", text: "managed prompt" }, "turn-started");
    const child = new FakeClaude(ledger);
    const captured: { options?: SpawnOptionsWithoutStdio } = {};
    const host = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: "/repo",
      claudeConfigDir: configDir,
      claudeProjectsDir: projectsDir,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "must-not-cross",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-cross",
      },
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: fakeSpawn(child, captured),
    });
    expect(captured.options?.env).toEqual({
      NODE_ENV: "test",
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: configDir,
    });
    expect(await host.send({ id: "managed-entry", text: "managed prompt" })).toEqual({ outcome: "turn-started", turnId: "managed-entry" });
    expect(child.inputs).toHaveLength(0);
    await host.release();
  });

  test("uses explicit control messages for interrupt and attention answers", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const sent = host.send({ id: "active", text: "work" });
    child.emitJson({ type: "user", isReplay: true, session_id: host.identity.sessionId, uuid: "active-user", message: { role: "user", content: [{ type: "text", text: "work" }] } });
    await sent;
    const interrupted = host.interrupt("active");
    const request = child.inputs.find((input) => input.type === "control_request")!;
    expect(request.request).toEqual({ subtype: "interrupt" });
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
    await interrupted;
    const terminalEvents = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    child.emitJson({ type: "result", subtype: "error_during_execution", session_id: host.identity.sessionId });
    expect(await nextEvent(terminalEvents)).toMatchObject({ kind: "turn-ended", turnId: "active", status: "interrupted" });

    child.emitJson({ type: "control_request", request_id: "permission-one", request: { subtype: "can_use_tool", tool_name: "Bash" } });
    await Bun.sleep(0);
    expect((await host.health()).pendingAttention).toEqual(["permission-one"]);
    const answer = host.answer("permission-one", { behavior: "deny" });
    expect(child.inputs.at(-1)).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "permission-one", response: { behavior: "deny" } },
    });
    expect((await host.health()).pendingAttention).toEqual(["permission-one"]);
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: "permission-one", response: { behavior: "deny" } } });
    await answer;
    expect((await host.health()).pendingAttention).toEqual([]);

    child.emitJson({ type: "control_request", request_id: "permission-two", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/a.txt", content: "hello" } } });
    await Bun.sleep(0);
    const allowed = host.answer("permission-two", { behavior: "allow" });
    expect(child.inputs.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "permission-two",
        response: { behavior: "allow", updatedInput: { file_path: "/repo/a.txt", content: "hello" } },
      },
    });
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: "permission-two", response: { behavior: "allow" } } });
    await allowed;

    child.emitJson({ type: "control_request", request_id: "question-one", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Continue?" }] } } });
    await Bun.sleep(0);
    const question = host.answer("question-one", { behavior: "allow", updatedInput: { answers: { "Continue?": "Yes" } } });
    expect(child.inputs.at(-1)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "question-one",
        response: {
          behavior: "allow",
          updatedInput: { questions: [{ question: "Continue?" }], answers: { "Continue?": "Yes" } },
        },
      },
    });
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: "question-one", response: { behavior: "allow" } } });
    await question;
    await host.release();
  });

  test("retires control attention from response acknowledgements and cancellations", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      requestTimeoutMs: 1_000,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      spawnProcess: fakeSpawn(child, {}),
    });

    child.emitJson({ type: "control_request", request_id: "answered-request", request: { subtype: "can_use_tool" } });
    await Bun.sleep(0);
    const answeredCursor = (await host.health()).eventCursor;
    const answeredEvents = host.attach(answeredCursor)[Symbol.asyncIterator]();
    const answered = host.answer("answered-request", { behavior: "deny" });
    await Bun.sleep(0);
    expect((await host.health()).pendingAttention).toEqual(["answered-request"]);
    expect((await host.health()).eventCursor).toBe(answeredCursor);
    child.emitJson({ type: "control_response", response: { subtype: "success", request_id: "answered-request", response: { behavior: "deny" } } });
    await answered;
    expect(await nextEvent(answeredEvents)).toMatchObject({
      kind: "attention-resolved",
      id: "answered-request",
      resolution: "answered",
    });

    child.emitJson({ type: "control_request", request_id: "cancelled-request", request: { subtype: "can_use_tool" } });
    await Bun.sleep(0);
    const cancelledEvents = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    const cancelledAnswer = host.answer("cancelled-request", { behavior: "deny" });
    child.emitJson({ type: "control_cancel_request", request_id: "cancelled-request" });
    await expect(cancelledAnswer).rejects.toThrow("cancelled before answer confirmation");
    expect(await nextEvent(cancelledEvents)).toMatchObject({
      kind: "attention-resolved",
      id: "cancelled-request",
      resolution: "server-resolved",
    });
    expect((await host.health()).pendingAttention).toEqual([]);
    await host.release();
  });

  test("does not repeat a completed assistant message after partial deltas", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const sent = host.send({ id: "partial", text: "reply" });
    child.emitJson({ type: "user", isReplay: true, session_id: host.identity.sessionId, uuid: "partial-user", message: { role: "user", content: [{ type: "text", text: "reply" }] } });
    await sent;
    const events = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
    for (const text of ["ACK", "-", "150"]) {
      child.emitJson({ type: "stream_event", session_id: host.identity.sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    }
    child.emitJson({ type: "assistant", session_id: host.identity.sessionId, message: { role: "assistant", content: [{ type: "text", text: "ACK-150" }] } });
    child.emitJson({ type: "result", subtype: "success", session_id: host.identity.sessionId });
    expect(await nextEvent(events)).toMatchObject({ kind: "delta", text: "ACK" });
    expect(await nextEvent(events)).toMatchObject({ kind: "delta", text: "-" });
    expect(await nextEvent(events)).toMatchObject({ kind: "delta", text: "150" });
    expect(await nextEvent(events)).toMatchObject({ kind: "item", phase: "completed" });
    await host.release();
  });

  test("requires subscription OAuth before spawning", async () => {
    let spawned = false;
    await expect(ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      readAuthStatus: () => ({ loggedIn: true, authMethod: "apiKey", subscriptionType: null }),
      spawnProcess: () => {
        spawned = true;
        throw new Error("unexpected spawn");
      },
    })).rejects.toThrow("requires a claude.ai subscription login");
    expect(spawned).toBeFalse();
  });

  test("requires the exact structured-host opt-in before start", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const options = {
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    };
    await expect(startClaudeStructuredHost(options, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "true" }))
      .rejects.toThrow("structured hosts are disabled");
    expect(child.sessionId).toBe("");
    const host = await startClaudeStructuredHost(options, { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" });
    expect(child.sessionId).toBe(host.identity.sessionId);
    await host.release();
  });

  test("boot adoption resumes claimed Claude rows and persists broker columns", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-adoption-"));
    const registryPath = path.join(directory, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
    const sessionId = "adopted-claude-session";
    registry.upsert({
      key: { engine: "claude", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:old",
        process: null,
        eventCursor: 4,
        protocolVersion: "2.1.196",
        writerClaimEpoch: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const captured: { args?: string[] } = {};
    const adopted = await adoptClaudeRegistryHosts(
      registry,
      () => ({
        cwd: "/repo",
        deliveryLedger: ledger,
        eventStore: new MemoryEventStore(),
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.197" }),
        readTranscript: () => [],
        spawnProcess: fakeSpawn(child, captured),
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(adopted).toHaveLength(1);
    expect(captured.args).toContain("--resume");
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "idle",
      claimEpoch: 3,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        eventCursor: 5,
        protocolVersion: "2.1.197",
        writerClaimEpoch: 3,
      },
    });
    await adopted[0]!.host.release();
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });

    const restartedRegistry = new AgentRegistry(registryPath);
    const replacement = new FakeClaude(ledger);
    const restartCaptured: { args?: string[] } = {};
    const restarted = await adoptClaudeRegistryHosts(
      restartedRegistry,
      () => ({
        cwd: "/repo",
        deliveryLedger: ledger,
        eventStore: new MemoryEventStore(),
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "2.1.197" }),
        readTranscript: () => [],
        spawnProcess: fakeSpawn(replacement, restartCaptured),
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );
    expect(restarted).toHaveLength(1);
    expect(restartCaptured.args).toContain("--resume");
    expect(restartedRegistry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "idle",
      host: null,
      claimEpoch: 4,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        writerClaimEpoch: 4,
      },
    });
    await restarted[0]!.host.release();
  });

  test("startup adoption retains an unreaped Claude child until late cleanup converges", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-uncertain-claude-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "uncertain-claude-adoption";
    registry.upsert({
      key: { engine: "claude", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "dead",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:released",
        process: null,
        eventCursor: 4,
        protocolVersion: "2.1.197",
        writerClaimEpoch: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 2,
      claimOwner: null,
      pendingAction: null,
    });
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger, true, true);

    const adopted = await adoptClaudeRegistryHosts(
      registry,
      () => ({
        cwd: "/repo",
        deliveryLedger: ledger,
        eventStore: new MemoryEventStore(),
        shutdownGraceMs: 2,
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
        readTranscript: () => { throw new Error("resume transcript failed"); },
        spawnProcess: fakeSpawn(child, {}),
      }),
      { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
    );

    expect(adopted).toEqual([]);
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "idle",
      claimOwner: expect.any(String),
      structuredHost: {
        endpoint: "stdio:5150",
        process: { pid: 5150 },
        writerClaimEpoch: 3,
      },
    });

    child.emit("close", 0, "SIGKILL");
    await Bun.sleep(0);
    expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });
  });

  test("boot adoption reaps a surviving orphaned Claude child before resume", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-orphan-adoption-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "orphaned-claude-session";
    const orphan = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    const orphanExit = new Promise<void>((resolve) => { orphan.once("exit", () => resolve()); });
    let startIdentity: string | null = null;
    for (let attempt = 0; attempt < 100 && !startIdentity; attempt += 1) {
      startIdentity = orphan.pid ? procBackend.processIdentity(orphan.pid) : null;
      if (!startIdentity) await Bun.sleep(2);
    }
    if (!orphan.pid || !startIdentity) {
      try { orphan.kill("SIGKILL"); } catch { /* already exited */ }
      await orphanExit;
      throw new Error("orphan test process identity is unavailable");
    }
    registry.upsert({
      key: { engine: "claude", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: `stdio:${orphan.pid}`,
        process: { pid: orphan.pid, startIdentity },
        eventCursor: 2,
        protocolVersion: "2.1.197",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: null,
      pendingAction: null,
    });
    const ledger = new RecordingDeliveryLedger();
    const replacement = new FakeClaude(ledger);
    let optionsCalls = 0;
    let adopted: Awaited<ReturnType<typeof adoptClaudeRegistryHosts>> = [];
    try {
      adopted = await adoptClaudeRegistryHosts(
        registry,
        () => {
          optionsCalls += 1;
          return {
            cwd: "/repo",
            deliveryLedger: ledger,
            eventStore: new MemoryEventStore(),
            readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
            readTranscript: () => [],
            spawnProcess: fakeSpawn(replacement, {}),
          };
        },
        { NODE_ENV: "test", LLV_STRUCTURED_HOSTS: "1" },
      );
    } finally {
      if (procBackend.processIdentity(orphan.pid) === startIdentity) {
        try { orphan.kill("SIGKILL"); } catch { /* already exited */ }
      }
      await Promise.race([orphanExit, Bun.sleep(2_000)]);
    }

    expect(adopted).toHaveLength(1);
    expect(optionsCalls).toBe(1);
    expect(procBackend.processIdentity(orphan.pid)).not.toBe(startIdentity);
    await adopted[0]!.host.release();
  }, 10_000);

  test("startup demotion reaps a surviving skipped Claude child", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-skipped-orphan-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "skipped-orphaned-claude-session";
    const orphan = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    const orphanExit = new Promise<void>((resolve) => { orphan.once("exit", () => resolve()); });
    let startIdentity: string | null = null;
    for (let attempt = 0; attempt < 100 && !startIdentity; attempt += 1) {
      startIdentity = orphan.pid ? procBackend.processIdentity(orphan.pid) : null;
      if (!startIdentity) await Bun.sleep(2);
    }
    if (!orphan.pid || !startIdentity) {
      try { orphan.kill("SIGKILL"); } catch { /* already exited */ }
      await orphanExit;
      throw new Error("orphan test process identity is unavailable");
    }
    registry.upsert({
      key: { engine: "claude", sessionId },
      artifactPath: `/sessions/${sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "live",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: `stdio:${orphan.pid}`,
        process: { pid: orphan.pid, startIdentity },
        eventCursor: 2,
        protocolVersion: "2.1.197",
        writerClaimEpoch: 1,
        activeTurnRef: "stale-turn",
        pendingAttention: ["stale-attention"],
        activeFlags: ["working"],
      },
      claimEpoch: 1,
      claimOwner: null,
      pendingAction: null,
    });

    try {
      await demoteSkippedStructuredRegistryHosts(registry, () => false);
      expect(procBackend.processIdentity(orphan.pid)).not.toBe(startIdentity);
      expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
        status: "dead",
        claimOwner: null,
        structuredHost: {
          endpoint: "stdio:released",
          process: null,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
      });
    } finally {
      if (procBackend.processIdentity(orphan.pid) === startIdentity) {
        try { orphan.kill("SIGKILL"); } catch { /* already exited */ }
      }
      await Promise.race([orphanExit, Bun.sleep(2_000)]);
    }
  }, 10_000);

  test("a timed-out Claude release converges after a late child reap and permits cleanup retry", async () => {
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger, true, true);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      shutdownGraceMs: 2,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const states: HostState[] = [];
    host.onStateChange((state) => states.push(state));

    await expect(host.release()).rejects.toThrow("Claude child could not be reaped");
    child.emit("close", 0, "SIGKILL");
    await Bun.sleep(0);

    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null, endpoint: "stdio:released" });
    expect(states.at(-1)).toMatchObject({ status: "unhosted", pid: null });
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("a late Claude reap after ledger failure releases the persisted writer claim", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-late-ledger-reap-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger, true, true);
    const eventStore = new FailingEventStore();
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      shutdownGraceMs: 2,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const key = { engine: "claude" as const, sessionId: host.identity.sessionId };
    registry.upsert({
      key,
      artifactPath: `/sessions/${host.identity.sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        process: { pid: 5150, startIdentity: null },
        eventCursor: 1,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "late-ledger-reap-owner",
      pendingAction: null,
    });
    await bindClaudeHostPersistence(registry, key, host, "late-ledger-reap-owner", 1);

    child.emitJson({
      type: "stream_event",
      session_id: host.identity.sessionId,
      event: { type: "content_block_delta", delta: { text: "fails append" } },
    });
    await Bun.sleep(0);
    expect(await host.health()).toMatchObject({ status: "dead", pid: 5150 });
    await expect(host.release()).rejects.toThrow("Claude child could not be reaped");

    child.emit("close", 0, "SIGKILL");
    await Bun.sleep(0);

    expect(registry.snapshot().entries[`claude:${host.identity.sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { endpoint: "stdio:released", process: null },
    });
    await expect(host.release()).resolves.toBeUndefined();
  });

  test("protocol failure reaps a TERM-resistant child and releases its writer claim", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-failure-claim-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger, true);
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore: new MemoryEventStore(),
      shutdownGraceMs: 5,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const key = { engine: "claude" as const, sessionId: host.identity.sessionId };
    registry.upsert({
      key,
      artifactPath: `/sessions/${host.identity.sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        process: { pid: 5150, startIdentity: null },
        eventCursor: 1,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "failure-owner",
      pendingAction: null,
    });
    await bindClaudeHostPersistence(registry, key, host, "failure-owner", 1);
    child.stdout.write("malformed\n");
    await Bun.sleep(20);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(registry.snapshot().entries[`claude:${host.identity.sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: { process: null, endpoint: "stdio:released" },
    });
    await host.release();
  });

  test("shutdown ledger failure still releases its writer claim", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-release-claim-"));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const ledger = new RecordingDeliveryLedger();
    const child = new FakeClaude(ledger);
    const eventStore = new FailingEventStore();
    const host = await ClaudeStreamBrokerHost.start({
      cwd: "/repo",
      deliveryLedger: ledger,
      eventStore,
      readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      readTranscript: () => [],
      spawnProcess: fakeSpawn(child, {}),
    });
    const key = { engine: "claude" as const, sessionId: host.identity.sessionId };
    registry.upsert({
      key,
      artifactPath: `/sessions/${host.identity.sessionId}.jsonl`,
      cwd: "/repo",
      accountId: null,
      status: "idle",
      host: null,
      structuredHost: {
        kind: "claude-broker",
        endpoint: "stdio:5150",
        process: { pid: 5150, startIdentity: null },
        eventCursor: 1,
        protocolVersion: null,
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "release-owner",
      pendingAction: null,
    });
    await bindClaudeHostPersistence(registry, key, host, "release-owner", 1);
    await host.release();
    expect(eventStore.appendAttempts).toBe(2);
    expect(registry.snapshot().entries[`claude:${host.identity.sessionId}`]).toMatchObject({
      status: "unhosted",
      claimOwner: null,
      structuredHost: { process: null, endpoint: "stdio:released" },
    });
  });

  test("file delivery ledger survives restart and repairs a partial tail", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-ledger-"));
    const ledger = new FileClaudeDeliveryLedger(directory);
    ledger.recordQueued("durable", { id: "entry", text: "hello" }, "turn-started");
    ledger.confirmDelivered("durable", "entry", "engine-user");
    expect(() => ledger.recordQueued("durable", { id: "entry", text: "changed" }, "turn-started"))
      .toThrow("different payload");
    expect(new FileClaudeDeliveryLedger(directory).load("durable")).toMatchObject([{
      entry: { id: "entry", text: "hello" },
      disposition: "turn-started",
      delivered: true,
      engineMessageId: "engine-user",
    }]);
    const filename = path.join(directory, "durable.jsonl");
    fs.appendFileSync(filename, "{partial");
    ledger.recordQueued("durable", { id: "second", text: "world" }, "queued-next-turn");
    expect(ledger.load("durable").map((state) => state.entry.id)).toEqual(["entry", "second"]);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  });

  test("file delivery ledger completes short writes before returning", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-short-ledger-"));
    const originalWriteSync = fs.writeSync as unknown as (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => number;
    const shortWrite = spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      value: string | Uint8Array,
      offset = 0,
      length?: number,
      position: number | null = null,
    ) => {
      const buffer = typeof value === "string" ? Buffer.from(value) : value;
      const start = typeof value === "string" || typeof offset !== "number" ? 0 : offset;
      const requested = typeof value === "string" ? buffer.byteLength : (length ?? buffer.byteLength - start);
      const shortLength = Math.max(1, Math.floor(requested / 2));
      return originalWriteSync(fd, buffer, start, shortLength, position);
    }) as typeof fs.writeSync);
    try {
      const ledger = new FileClaudeDeliveryLedger(directory);
      ledger.recordQueued("short-write", { id: "entry", text: "fully durable" }, "turn-started");
      expect(ledger.load("short-write")).toMatchObject([{
        entry: { id: "entry", text: "fully durable" },
        disposition: "turn-started",
        delivered: false,
      }]);
    } finally {
      shortWrite.mockRestore();
    }
  });
});
