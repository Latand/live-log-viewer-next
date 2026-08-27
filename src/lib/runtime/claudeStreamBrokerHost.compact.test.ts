import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { afterAll, expect, test } from "bun:test";

import {
  CLAUDE_COMPACT_COMMAND,
  CLAUDE_COMPACT_DECLINED_REASON,
  CLAUDE_COMPACT_UNOBSERVED_REASON,
  ClaudeStreamBrokerHost,
  type ClaudeDeliveryLedger,
  type ClaudeDeliveryState,
} from "./claudeStreamBrokerHost";
import { StructuredCompactError, type QueueEntry, type RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";

/**
 * The Claude compact control (#1214). The stream-json transport has no compact
 * subtype — `interrupt` and `can_use_tool` are the whole control channel — so
 * the host reaches compaction the only way the transport allows: it types
 * `/compact` into the conversation and reads the outcome off the stream it
 * already consumes: `system/compact_boundary` when the engine compacted, and
 * the command's own boundary-less `result` when it declined. Every assertion
 * here is about the two things that decide the control: the command is really
 * sent (exactly once), and the outcome the receipt carries is the one that was
 * actually witnessed.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-compact-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

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

class MemoryDeliveryLedger implements ClaudeDeliveryLedger {
  readonly records: string[] = [];
  private readonly states = new Map<string, ClaudeDeliveryState[]>();

  load(sessionId: string): ClaudeDeliveryState[] {
    return structuredClone(this.states.get(sessionId) ?? []);
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    this.records.push(`queued:${entry.id}`);
    const states = this.states.get(sessionId) ?? [];
    states.push({ entry: structuredClone(entry) as ClaudeDeliveryState["entry"], disposition, delivered: false });
    this.states.set(sessionId, states);
  }

  confirmDelivered(sessionId: string, entryId: string): void {
    this.records.push(`delivered:${entryId}`);
  }
}

class FakeClaude extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly inputs: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.inputs.push(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  emitJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }
}

/** Waits for a fixture condition without pinning the test to a stream tick. */
async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(2);
  }
  throw new Error(label);
}

/** Every `/compact` frame the child was actually handed. */
function compactFrames(child: FakeClaude): Array<Record<string, unknown>> {
  return child.inputs.filter((input) => {
    if (input.type !== "user") return false;
    const message = input.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    return (message?.content ?? []).some((block) => block.type === "text" && block.text === CLAUDE_COMPACT_COMMAND);
  });
}

/** The boundary frame the CLI announces on stdout when it compacted. */
function announceBoundary(child: FakeClaude, host: ClaudeStreamBrokerHost, uuid: string): void {
  child.emitJson({
    type: "system",
    subtype: "compact_boundary",
    session_id: host.identity.sessionId,
    uuid,
    compact_metadata: { trigger: "manual", pre_tokens: 850_932, post_tokens: 11_926 },
  });
}

/** The frame the CLI answers `/compact` with once it is done with the command;
    it belongs to no turn, because the compaction never took a turn slot. */
function announceResult(child: FakeClaude, host: ClaudeStreamBrokerHost): void {
  child.emitJson({
    type: "result",
    subtype: "success",
    session_id: host.identity.sessionId,
    is_error: false,
    num_turns: 0,
  });
}

function startHost(options: {
  child: FakeClaude;
  compactEvidenceTimeoutMs?: number;
} ): Promise<ClaudeStreamBrokerHost> {
  return ClaudeStreamBrokerHost.start({
    cwd: sandbox,
    eventStore: new MemoryEventStore(),
    deliveryLedger: new MemoryDeliveryLedger(),
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    readTranscript: () => [],
    compactEvidenceTimeoutMs: options.compactEvidenceTimeoutMs ?? 2_000,
    /* A fixture never signals a real process group: the fake child's own
       `kill` is the fallback, and no pid on this machine is touched. */
    signalProcess: () => { throw new Error("fixture has no process group"); },
    processIdentity: () => "fixture-identity",
    spawnProcess: ((_command: string, _args: string[], _spawnOptions: SpawnOptionsWithoutStdio) =>
      options.child as unknown as ChildProcessWithoutNullStreams),
  });
}

test("the compact control types /compact once and terminalizes on the boundary the CLI announces", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child });
  try {
    const compaction = host.compact({ operationId: "op-compact", threadId: host.identity.sessionId });

    /* The command reaches the conversation as a message — the transport offers
       no other way — and it carries nothing but the command itself. */
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");
    expect(compactFrames(child)[0]).toMatchObject({
      type: "user",
      session_id: host.identity.sessionId,
      message: { role: "user", content: [{ type: "text", text: "/compact" }] },
    });

    announceBoundary(child, host, "boundary-one");
    expect(await compaction).toEqual({ compactionId: "boundary-one" });
  } finally {
    await host.release();
  }
});

test("the boundary settles the control before the command's own result can call it declined", async () => {
  /* The CLI emits the boundary and then closes the command with a `result`,
     which is what makes a boundary-less `result` legible as a decline. */
  const child = new FakeClaude();
  const host = await startHost({ child, compactEvidenceTimeoutMs: 60_000 });
  try {
    const compaction = host.compact({ operationId: "op-order", threadId: host.identity.sessionId });
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");

    announceBoundary(child, host, "boundary-then-result");
    announceResult(child, host);

    expect(await compaction).toEqual({ compactionId: "boundary-then-result" });
  } finally {
    await host.release();
  }
});

test("a /compact the engine declines terminalizes at once instead of waiting out the budget", async () => {
  /* "Error: No messages to compact" is the everyday shape: the CLI answers the
     command, emits no boundary, and closes it with a `result` that belongs to
     no turn. Sitting out five minutes for evidence the engine already declined
     to produce would be an honest verdict reached silently and far too late. */
  const child = new FakeClaude();
  const host = await startHost({ child, compactEvidenceTimeoutMs: 60_000 });
  try {
    const compaction = host.compact({ operationId: "op-declined", threadId: host.identity.sessionId })
      .then(() => "resolved", (error: unknown) => error);
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");

    child.emitJson({
      type: "assistant",
      session_id: host.identity.sessionId,
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Error: No messages to compact" }] },
    });
    announceResult(child, host);

    const outcome = await compaction;
    expect(outcome).toBeInstanceOf(StructuredCompactError);
    /* `refused` is the phase the queue turns into a visible failed receipt: the
       engine did not compact, and the reason says so without claiming one. */
    expect((outcome as StructuredCompactError).phase).toBe("refused");
    expect((outcome as StructuredCompactError).message).toBe(CLAUDE_COMPACT_DECLINED_REASON);
  } finally {
    await host.release();
  }
});

test("a result that belongs to a live turn is not a compaction decline", async () => {
  /* Only the compaction runs off the turn plane, so only a result no turn
     claims can be the `/compact` command's. A turn's own result must never
     terminalize a compaction that is still running. */
  const child = new FakeClaude();
  const host = await startHost({ child, compactEvidenceTimeoutMs: 60_000 });
  try {
    const compaction = host.compact({ operationId: "op-turn-result", threadId: host.identity.sessionId });
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");

    /* A delivery the queue's barrier would normally hold back; its echo opens a
       turn, so the result that follows is that turn's. */
    void host.send({ id: "entry-turn", text: "hello" }).catch(() => undefined);
    await waitFor(async () => (await host.health()).activeTurnRef !== null, "the delivery never opened a turn");
    announceResult(child, host);

    /* Still running: nothing declined it. */
    expect(await Promise.race([compaction.then(() => "settled", () => "settled"), Bun.sleep(30).then(() => "pending")]))
      .toBe("pending");

    announceBoundary(child, host, "boundary-after-turn");
    expect(await compaction).toEqual({ compactionId: "boundary-after-turn" });
  } finally {
    await host.release();
  }
});

test("a compaction nobody witnessed terminalizes as sent-but-unobservable, never as success", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child, compactEvidenceTimeoutMs: 25 });
  try {
    const outcome = await host.compact({ operationId: "op-silent", threadId: host.identity.sessionId })
      .then(() => "resolved", (error: unknown) => error);

    expect(outcome).toBeInstanceOf(StructuredCompactError);
    expect((outcome as StructuredCompactError).phase).toBe("unverified");
    expect((outcome as StructuredCompactError).message).toBe(CLAUDE_COMPACT_UNOBSERVED_REASON);
    /* The command was still sent: the operator asked for it, and the receipt
       says exactly what is known about the outcome. */
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");
  } finally {
    await host.release();
  }
});

test("a retry on the same operation replays the outcome instead of typing /compact twice", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child });
  try {
    const first = host.compact({ operationId: "op-once", threadId: host.identity.sessionId });
    const concurrent = host.compact({ operationId: "op-once", threadId: host.identity.sessionId });
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");

    announceBoundary(child, host, "boundary-once");
    expect(await first).toEqual({ compactionId: "boundary-once" });
    expect(await concurrent).toEqual({ compactionId: "boundary-once" });

    /* A caller that gave up and retried after the outcome landed replays it. */
    expect(await host.compact({ operationId: "op-once", threadId: host.identity.sessionId }))
      .toEqual({ compactionId: "boundary-once" });
    expect(compactFrames(child)).toHaveLength(1);
  } finally {
    await host.release();
  }
});

test("a compaction refused before the command is written sends nothing", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child });
  try {
    /* Someone else's session. */
    await expect(host.compact({ operationId: "op-foreign", threadId: "another-session" }))
      .rejects.toMatchObject({ phase: "refused" });

    /* A live turn: compaction underneath a running turn is the race this
       control must not run, and admission already fenced it once. The delivery
       stays in flight — its echo never arrives in this fixture. */
    const delivery = host.send({ id: "entry-one", text: "hello" });
    void delivery.catch(() => undefined);
    await expect(host.compact({ operationId: "op-busy", threadId: host.identity.sessionId }))
      .rejects.toMatchObject({ phase: "refused" });

    await Bun.sleep(10);
    expect(compactFrames(child)).toHaveLength(0);
  } finally {
    await host.release();
  }
});

test("a host that dies mid-compaction terminalizes unverified rather than hanging", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child, compactEvidenceTimeoutMs: 60_000 });
  const compaction = host.compact({ operationId: "op-dead", threadId: host.identity.sessionId })
    .then(() => "resolved", (error: unknown) => error);
  child.emitJson({ type: "system", subtype: "init", apiKeySource: "oops" });

  const outcome = await compaction;
  expect(outcome).toBeInstanceOf(StructuredCompactError);
  expect((outcome as StructuredCompactError).phase).toBe("unverified");
});
