import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { expect, test } from "bun:test";

import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";
import { serveRuntimeHost } from "@/runtime-host/socket";

import {
  ClaudeStreamBrokerHost,
  type ClaudeDeliveryLedger,
  type ClaudeDeliveryState,
} from "./claudeStreamBrokerHost";
import { UnixRuntimeHostClient } from "./client";
import { normalizeQueueEntry, type QueueEntry } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";

class MemoryDeliveryLedger implements ClaudeDeliveryLedger {
  private readonly states = new Map<string, ClaudeDeliveryState[]>();

  load(sessionId: string): ClaudeDeliveryState[] {
    return structuredClone(this.states.get(sessionId) ?? []);
  }

  recordQueued(sessionId: string, entry: QueueEntry, disposition: ClaudeDeliveryState["disposition"]): void {
    const states = this.states.get(sessionId) ?? [];
    states.push({ entry: structuredClone(normalizeQueueEntry(entry)), disposition, delivered: false });
    this.states.set(sessionId, states);
  }

  confirmDelivered(sessionId: string, entryId: string, engineMessageId: string | null): void {
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
  readonly pid = 424242;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }

  emitJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

const SESSION_ID = "0f367367-0000-4000-8000-000000000367";
const SEEDED_EVENTS = 80_000;
const BURST_FRAMES = 200;
const SEEDED_DELTA_TEXT = "structured reviewer reasoning ".repeat(8);

/* Production #367 on exact main 4b0690a2: while a Fable reviewer streamed a
   structured turn on the default account, GET /api/runtime/snapshot timed out
   with zero bytes and a second-account pipeline spawn admission terminalized
   as "runtime host request timed out". The turn's streamed events made every
   ledger append O(ledger) on the shared event loop, so one coalesced stdout
   burst starved every concurrent control-plane request. This regression pins
   the acceptance: snapshot and independent-account admission stay bounded by
   their production client timeouts while a long structured turn is running. */
test("snapshot and second-account admission stay bounded during a live Fable-like structured turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-live-turn-"));
  const eventsDirectory = path.join(directory, "events");
  fs.mkdirSync(eventsDirectory, { recursive: true, mode: 0o700 });
  const seeded: string[] = [];
  for (let seq = 1; seq <= SEEDED_EVENTS; seq += 1) {
    seeded.push(JSON.stringify({ kind: "delta", turnId: "seed-turn", text: SEEDED_DELTA_TEXT, seq }));
  }
  fs.writeFileSync(path.join(eventsDirectory, `${SESSION_ID}.jsonl`), `${seeded.join("\n")}\n`, { mode: 0o600 });

  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const socketPath = path.join(directory, "runtime.sock");
  const server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, true));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new UnixRuntimeHostClient(socketPath);

  const child = new FakeClaude();
  const store = new FileRuntimeEventStore(eventsDirectory);
  const host = await ClaudeStreamBrokerHost.adopt(SESSION_ID, {
    cwd: directory,
    eventStore: store,
    deliveryLedger: new MemoryDeliveryLedger(),
    initialEventCursor: SEEDED_EVENTS,
    shutdownGraceMs: 50,
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", version: "3.0.0" }),
    readTranscript: () => [],
    spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    signalProcess: () => { throw new Error("no process group in fixture"); },
  });

  try {
    const sendPromise = host.send({ id: "turn-367", text: "start the structured review" });
    child.emitJson({
      type: "user",
      session_id: SESSION_ID,
      uuid: "uuid-turn-367",
      message: { role: "user", content: [{ type: "text", text: "start the structured review" }] },
    });
    expect(await sendPromise).toEqual({ outcome: "turn-started", turnId: "turn-367" });

    /* Both probes are in flight before the turn's coalesced stdout burst is
       accepted; their timers are the production Viewer client bounds (10s for
       snapshot, 3s for admission). The burst is then processed in a single
       synchronous data callback, exactly like a backpressured child pipe. */
    const probes = Promise.all([
      client.snapshot(),
      client.command({
        kind: "spawn",
        operationId: "launch-second-account",
        idempotencyKey: "launch-second-account",
        conversationId: "conversation_second-account",
        engine: "claude",
        cwd: directory,
        prompt: "independent-account pipeline launch",
        accountId: "opensource",
      }),
    ]);
    const frames: string[] = [];
    for (let frame = 0; frame < BURST_FRAMES; frame += 1) {
      frames.push(`${JSON.stringify({
        type: "stream_event",
        session_id: SESSION_ID,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: SEEDED_DELTA_TEXT } },
      })}\n`);
    }
    child.stdout.write(frames.join(""));

    const [snapshot, admission] = await probes;
    expect(snapshot.runtime.health).toBe("ready");
    expect(admission.receipt).toMatchObject({
      status: "queued",
      conversationId: "conversation_second-account",
      kind: "spawn",
    });
    expect((await host.health())).toMatchObject({ status: "active", activeTurnRef: "turn-367" });

    child.emitJson({ type: "result", subtype: "success", session_id: SESSION_ID });
    expect((await host.health()).activeTurnRef).toBeNull();

    const events = store.load(SESSION_ID);
    expect(events.at(-1)!.seq).toBe(events.length);
    expect(events.length).toBeGreaterThanOrEqual(SEEDED_EVENTS + BURST_FRAMES);
    expect(events.filter((event) => event.kind === "turn-ended").at(-1)).toMatchObject({
      turnId: "turn-367",
      status: "completed",
    });
  } finally {
    await host.release();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
  }
  expect((await host.health()).status).toBe("unhosted");
}, 180_000);
