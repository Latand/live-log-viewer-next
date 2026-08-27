import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { afterAll, expect, test } from "bun:test";

import { claudeTranscriptPath } from "@/lib/agent/transcript";

import {
  CLAUDE_COMPACT_COMMAND,
  CLAUDE_COMPACT_UNOBSERVED_REASON,
  ClaudeStreamBrokerHost,
  fileClaudeCompactionEvidence,
  type ClaudeCompactionEvidenceSource,
  type ClaudeDeliveryLedger,
  type ClaudeDeliveryState,
} from "./claudeStreamBrokerHost";
import { StructuredCompactError, type QueueEntry, type RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";

/**
 * The Claude compact control (#1214). The stream-json transport has no compact
 * subtype — `interrupt` and `can_use_tool` are the whole control channel — so
 * the host reaches compaction the only way the transport allows: it types
 * `/compact` into the conversation, then watches the session transcript for the
 * compaction boundary. Every assertion here is about the two things that decide
 * the control: the command is really sent (exactly once), and the outcome the
 * receipt carries is the one that was actually witnessed.
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
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
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

/** A scripted evidence channel: the test decides when a boundary appears. */
function scriptedEvidence(): ClaudeCompactionEvidenceSource & { announce(uuid: string | null): void } {
  let pending: Array<{ uuid: string | null; trigger: string | null }> = [];
  return {
    cursor: () => 128,
    read: ({ fromByte }) => {
      const boundaries = pending;
      pending = [];
      return { boundaries, cursor: fromByte };
    },
    announce(uuid) { pending = [{ uuid, trigger: "manual" }]; },
  };
}

function startHost(options: {
  child: FakeClaude;
  compactionEvidence?: ClaudeCompactionEvidenceSource;
  compactEvidenceTimeoutMs?: number;
  compactEvidencePollMs?: number;
} ): Promise<ClaudeStreamBrokerHost> {
  return ClaudeStreamBrokerHost.start({
    cwd: sandbox,
    eventStore: new MemoryEventStore(),
    deliveryLedger: new MemoryDeliveryLedger(),
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    readTranscript: () => [],
    compactEvidencePollMs: options.compactEvidencePollMs ?? 2,
    compactEvidenceTimeoutMs: options.compactEvidenceTimeoutMs ?? 2_000,
    ...(options.compactionEvidence ? { compactionEvidence: options.compactionEvidence } : {}),
    /* A fixture never signals a real process group: the fake child's own
       `kill` is the fallback, and no pid on this machine is touched. */
    signalProcess: () => { throw new Error("fixture has no process group"); },
    processIdentity: () => "fixture-identity",
    spawnProcess: ((_command: string, _args: string[], _spawnOptions: SpawnOptionsWithoutStdio) =>
      options.child as unknown as ChildProcessWithoutNullStreams),
  });
}

test("the compact control types /compact once and terminalizes on the observed transcript boundary", async () => {
  const child = new FakeClaude();
  const evidence = scriptedEvidence();
  const host = await startHost({ child, compactionEvidence: evidence });
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

    evidence.announce("boundary-one");
    expect(await compaction).toEqual({ compactionId: "boundary-one" });
  } finally {
    await host.release();
  }
});

test("a compaction nobody witnessed terminalizes as sent-but-unobservable, never as success", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child, compactionEvidence: scriptedEvidence(), compactEvidenceTimeoutMs: 25 });
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
  const evidence = scriptedEvidence();
  const host = await startHost({ child, compactionEvidence: evidence });
  try {
    const first = host.compact({ operationId: "op-once", threadId: host.identity.sessionId });
    const concurrent = host.compact({ operationId: "op-once", threadId: host.identity.sessionId });
    await waitFor(() => compactFrames(child).length === 1, "the /compact frame never reached the child");

    evidence.announce("boundary-once");
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
  const host = await startHost({ child, compactionEvidence: scriptedEvidence() });
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
  const host = await startHost({ child, compactionEvidence: scriptedEvidence(), compactEvidenceTimeoutMs: 60_000 });
  const compaction = host.compact({ operationId: "op-dead", threadId: host.identity.sessionId })
    .then(() => "resolved", (error: unknown) => error);
  child.emitJson({ type: "system", subtype: "init", apiKeySource: "oops" });

  const outcome = await compaction;
  expect(outcome).toBeInstanceOf(StructuredCompactError);
  expect((outcome as StructuredCompactError).phase).toBe("unverified");
});

test("a compaction boundary announced on the stream settles the control immediately", async () => {
  const child = new FakeClaude();
  const host = await startHost({ child, compactionEvidence: scriptedEvidence(), compactEvidenceTimeoutMs: 60_000 });
  try {
    const compaction = host.compact({ operationId: "op-stream", threadId: host.identity.sessionId });
    child.emitJson({
      type: "system",
      subtype: "compact_boundary",
      session_id: host.identity.sessionId,
      uuid: "boundary-stream",
      compactMetadata: { trigger: "manual", preTokens: 900_000 },
    });

    expect(await compaction).toEqual({ compactionId: "boundary-stream" });
  } finally {
    await host.release();
  }
});

test("the transcript evidence source reports only boundaries appended after the fence", () => {
  const projectsRoot = fs.mkdtempSync(path.join(sandbox, "projects-"));
  const cwd = path.join(sandbox, "repo");
  const sessionId = "session-compact-evidence";
  const transcript = claudeTranscriptPath(cwd, sessionId, projectsRoot);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  /* The record shape the CLI writes: only `uuid` and the trigger are read, so
     the fixture carries no identifier of any real conversation. */
  const boundary = (uuid: string, trigger: string) => JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid,
    compactMetadata: { trigger, preTokens: 850_932, postTokens: 11_926 },
  });
  fs.writeFileSync(transcript, `${boundary("older-boundary", "auto")}\n`);

  const fence = fileClaudeCompactionEvidence.cursor({ cwd, sessionId, projectsRoot });
  expect(fileClaudeCompactionEvidence.read({ cwd, sessionId, projectsRoot, fromByte: fence }).boundaries).toEqual([]);

  /* A record still being written is not evidence until its newline lands. */
  fs.appendFileSync(transcript, `${JSON.stringify({ type: "assistant" })}\n${boundary("fresh-boundary", "manual")}`);
  const partial = fileClaudeCompactionEvidence.read({ cwd, sessionId, projectsRoot, fromByte: fence });
  expect(partial.boundaries).toEqual([]);

  fs.appendFileSync(transcript, "\n");
  const observed = fileClaudeCompactionEvidence.read({ cwd, sessionId, projectsRoot, fromByte: partial.cursor });
  expect(observed.boundaries).toEqual([{ uuid: "fresh-boundary", trigger: "manual" }]);
  /* The cursor advances, so the same boundary is never counted twice. */
  expect(fileClaudeCompactionEvidence.read({ cwd, sessionId, projectsRoot, fromByte: observed.cursor }).boundaries)
    .toEqual([]);
});

test("a missing transcript is not evidence of anything", () => {
  const projectsRoot = fs.mkdtempSync(path.join(sandbox, "empty-projects-"));
  const input = { cwd: path.join(sandbox, "gone"), sessionId: "absent", projectsRoot };
  expect(fileClaudeCompactionEvidence.cursor(input)).toBe(0);
  expect(fileClaudeCompactionEvidence.read({ ...input, fromByte: 0 })).toEqual({ boundaries: [], cursor: 0 });
});
