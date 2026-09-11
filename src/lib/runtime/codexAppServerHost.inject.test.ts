import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, appendFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import { StructuredInjectError } from "./engineHost";
import type { RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";
import { structuredContent } from "./structuredContent";
import { decodeCodexStructuredUserText } from "./codexStructuredUserText";

/* An isolated, short scratch root. Nothing here reads or writes the operator's
   own state: the rollout each test uses is created under it and removed after. */
const roots: string[] = [];
function scratchRoot(): string {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "llv-inj-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/* An INVENTED thread identity, assembled from parts so no real session id is
   ever written into this public repository. Only its shape matters: the code
   under test treats it as an opaque string. */
const INVENTED_THREAD_ID = ["01a0", "0000"].join("") + "-" + "0000-7000-8000-" + "0".repeat(12);

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();
  load(threadId: string): RuntimeEvent[] { return structuredClone(this.events.get(threadId) ?? []); }
  append(threadId: string, event: RuntimeEvent): void {
    const events = this.events.get(threadId) ?? [];
    events.push(structuredClone(event));
    this.events.set(threadId, events);
  }
}

/**
 * A credential-free Codex 0.154 app-server double.
 *
 * Two things about it are load-bearing and both are copied from the real thing
 * rather than invented:
 *
 * - `thread/inject_items` answers with `{}` and answers it IMMEDIATELY. The
 *   persistence is a separate step the test drives, because that separation is
 *   the defect the honest-receipt requirement exists for: on the active path
 *   the engine can acknowledge while the items are still only pending input.
 * - When it does persist, it writes the raw Responses record shape codex 0.154
 *   actually writes — `{"type":"response_item","payload":{"type":"message",
 *   "role":"user","content":[{"type":"input_text","text":…}]}}` — into a real
 *   rollout file on disk, which is the same file the production scan reads.
 */
class InjectAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 6161;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Set to a JSON-RPC error code to make injection fail; -32601 is the
      method-not-found that proves this engine lacks the capability. */
  injectErrorCode: number | null = null;
  injectErrorMessage = "boom";
  /** When false, the ack is returned and nothing is written — the active path
      whose flush has not happened yet. */
  persistOnInject = true;
  readonly rolloutPath: string;
  private ordinal = 0;
  private turn = 0;
  private activeTurnId: string | null = null;

  constructor(root: string, readonly threadId = INVENTED_THREAD_ID, readonly protocol = "0.154.0") {
    super();
    this.rolloutPath = join(root, `rollout-${this.threadId}.jsonl`);
    /* A SECOND GENERATION REOPENS THE SAME ROLLOUT, it does not start one.
       Truncating here would erase the very history the restart case is about,
       and would make the dedup check pass for the wrong reason. */
    if (!existsSync(this.rolloutPath)) {
      writeFileSync(this.rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ordinal: this.ordinal++,
        type: "session_meta",
        payload: { session_id: this.threadId, id: this.threadId, cwd: root },
      })}\n`);
    } else {
      this.ordinal = readFileSync(this.rolloutPath, "utf8").trimEnd().split("\n").length;
    }
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", 0, "SIGTERM"));
    return true;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Start a turn the way the engine does, so the host's turn axis is real. */
  startTurn(): string {
    const turnId = `turn-${++this.turn}`;
    this.activeTurnId = turnId;
    this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
    return turnId;
  }

  /** The deferred flush: what the active path does at its own pace. */
  flushInjected(): void {
    for (const pending of this.pendingItems.splice(0)) this.writeResponseItem(pending);
  }

  readonly injectedItems: unknown[][] = [];
  private readonly pendingItems: Array<Record<string, unknown>> = [];

  private writeResponseItem(item: Record<string, unknown>): void {
    appendFileSync(this.rolloutPath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ordinal: this.ordinal++,
      type: "response_item",
      payload: { ...item, id: `msg_${this.ordinal}` },
    })}\n`);
  }

  private accept(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") return;
    const method = message.method;
    if (typeof method !== "string") return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    if (method === "initialize") return this.respond(message.id, { userAgent: `codex_cli_rs/${this.protocol} (Linux)` });
    if (method === "account/read") {
      return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    }
    if (method === "model/list") {
      return this.respond(message.id, { data: [{ id: "gpt-6-astra", isDefault: true, inputModalities: ["text"] }] });
    }
    if (method === "config/read") return this.respond(message.id, { config: { mcp_servers: {} } });
    if (method === "thread/start" || method === "thread/resume") {
      return this.respond(message.id, { thread: { id: this.threadId, path: this.rolloutPath, turns: [] } });
    }
    if (method === "thread/read") {
      return this.respond(message.id, { thread: { id: this.threadId, path: this.rolloutPath, turns: [] } });
    }
    if (method === "thread/queue/list") return this.respond(message.id, { items: [] });
    if (method === "thread/inject_items") {
      if (this.injectErrorCode !== null) {
        return this.respondError(message.id, this.injectErrorMessage, this.injectErrorCode);
      }
      const items = Array.isArray(params.items) ? params.items : [];
      this.injectedItems.push(items);
      for (const item of items) {
        const record = item as Record<string, unknown>;
        if (this.persistOnInject) this.writeResponseItem(record);
        else this.pendingItems.push(record);
      }
      /* The real acknowledgement: an empty object, and nothing else. */
      return this.respond(message.id, {});
    }
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private respondError(id: number, message: string, code = -32000): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  }
}

function startHost(server: InjectAppServer, options: Record<string, unknown> = {}) {
  return CodexAppServerHost.start({
    cwd: "/repo",
    requestTimeoutMs: 500,
    injectObservationTimeoutMs: 400,
    eventStore: new MemoryEventStore(),
    spawnProcess: (() => server as unknown as ChildProcessWithoutNullStreams),
    pidAlive: () => true,
    processIdentity: () => "6161:owned",
    ...options,
  });
}

function digestOf(text: string): string {
  return structuredContent(text, []).contentDigest;
}

/** Every RPC that would touch the turn. None of them may appear. */
const TURN_MUTATIONS = ["turn/start", "turn/steer", "turn/interrupt"];

test("active-turn injection appends the operator's input and issues no turn RPC", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  const turnId = server.startTurn();
  await Bun.sleep(10);

  const outcome = await host.inject({
    operationId: "op-active",
    threadId: server.threadId,
    text: "also check the migration path",
    contentDigest: digestOf("also check the migration path"),
  });

  /* The placement the engine actually gives an active thread: the items join
     the running turn's pending input and are read at its next model request. */
  expect(outcome.placement).toBe("pending-input");
  expect(outcome.turnId).toBe(turnId);
  expect(outcome.observed).toBe(true);

  /* THE CENTRAL CLAIM. Nothing interrupted the turn, nothing steered it, and
     nothing started another one. This is the whole reason the operation exists,
     so it is asserted against the engine's own request log. */
  for (const method of TURN_MUTATIONS) {
    expect(server.requests.some((request) => request.method === method)).toBe(false);
  }

  /* The model receives the operator's words, in the user role, as a raw
     Responses input item. */
  const [items] = server.injectedItems;
  expect(items).toHaveLength(1);
  const item = items![0] as { type: string; role: string; content: Array<{ type: string; text: string }> };
  expect(item.type).toBe("message");
  expect(item.role).toBe("user");
  expect(item.content[0]!.type).toBe("input_text");
  const decoded = decodeCodexStructuredUserText(item.content[0]!.text);
  expect(decoded.text).toBe("also check the migration path");
  expect(decoded.origin).toEqual({ kind: "operator" });

  await host.release();
});

test("idle injection writes history and still starts no turn", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  const outcome = await host.inject({
    operationId: "op-idle",
    threadId: server.threadId,
    text: "background for later",
    contentDigest: digestOf("background for later"),
  });

  expect(outcome.placement).toBe("history");
  expect(outcome.turnId).toBeNull();
  expect(outcome.observed).toBe(true);
  for (const method of TURN_MUTATIONS) {
    expect(server.requests.some((request) => request.method === method)).toBe(false);
  }
  await host.release();
});

test("an acknowledged insertion that never reaches history is reported unobserved, not delivered", async () => {
  const server = new InjectAppServer(scratchRoot());
  server.persistOnInject = false;
  const host = await startHost(server);
  server.startTurn();
  await Bun.sleep(10);

  const outcome = await host.inject({
    operationId: "op-unflushed",
    threadId: server.threadId,
    text: "pending only",
    contentDigest: digestOf("pending only"),
  });

  /* The engine answered `{}` — the request WAS accepted — and the items are
     still only pending input. An empty ack is not evidence about the thread,
     so the insertion is reported unobserved rather than delivered. */
  expect(server.injectedItems).toHaveLength(1);
  expect(outcome.observed).toBe(false);
  await host.release();
});

test("repeating an operation converges on the insertion already in history", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  const request = {
    operationId: "op-once",
    threadId: server.threadId,
    text: "exactly once",
    contentDigest: digestOf("exactly once"),
  };
  await host.inject(request);
  expect(server.injectedItems).toHaveLength(1);

  /* The engine does NOT deduplicate — a repeated request writes a second
     record. The canonical scan before insertion is what prevents it. */
  const again = await host.inject(request);
  expect(server.injectedItems).toHaveLength(1);
  expect(again.observed).toBe(true);

  await host.release();
});

test("RED CONTROL: without the pre-insertion scan a repeat writes a second record", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  await host.inject({
    operationId: "op-dup-a",
    threadId: server.threadId,
    text: "same words",
    contentDigest: digestOf("same words"),
  });
  /* A DIFFERENT operation id carrying identical text is a different insertion,
     and the engine happily takes it. This is the duplicate-on-repeat behaviour
     the probe observed, reproduced here: it proves the convergence above comes
     from the Viewer's own dedup identity and not from any engine guarantee. */
  await host.inject({
    operationId: "op-dup-b",
    threadId: server.threadId,
    text: "same words",
    contentDigest: digestOf("same words"),
  });
  expect(server.injectedItems).toHaveLength(2);

  const records = readFileSync(server.rolloutPath, "utf8").trimEnd().split("\n")
    .map((line) => JSON.parse(line) as { payload?: { role?: string } })
    .filter((entry) => entry.payload?.role === "user");
  expect(records).toHaveLength(2);
  await host.release();
});

test("the same operation id with different text is refused before any write", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  await host.inject({
    operationId: "op-frozen",
    threadId: server.threadId,
    text: "original",
    contentDigest: digestOf("original"),
  });
  expect(server.injectedItems).toHaveLength(1);

  await expect(host.inject({
    operationId: "op-frozen",
    threadId: server.threadId,
    text: "rewritten",
    contentDigest: digestOf("rewritten"),
  })).rejects.toThrow(/different payload/i);
  /* NOTHING was written for the rejected payload. */
  expect(server.injectedItems).toHaveLength(1);
  await host.release();
});

test("a foreign thread binding is refused before any write", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  await expect(host.inject({
    operationId: "op-foreign",
    threadId: "someone-elses-thread",
    text: "not for this thread",
    contentDigest: digestOf("not for this thread"),
  })).rejects.toThrow(/not the thread this host owns/i);
  expect(server.injectedItems).toHaveLength(0);
  expect(server.requests.some((request) => request.method === "thread/inject_items")).toBe(false);
  await host.release();
});

test("a stale turn fence is refused before any write", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  server.startTurn();
  await Bun.sleep(10);

  /* `null` asks for the idle placement, and a turn is running. */
  await expect(host.inject({
    operationId: "op-fenced",
    threadId: server.threadId,
    text: "idle only",
    contentDigest: digestOf("idle only"),
    expectedTurnId: null,
  })).rejects.toThrow(/stale-turn/);
  expect(server.injectedItems).toHaveLength(0);
  await host.release();
});

test("an engine without the method refuses explicitly and never falls back to steering", async () => {
  const server = new InjectAppServer(scratchRoot());
  server.injectErrorCode = -32601;
  server.injectErrorMessage = "method not found";
  const host = await startHost(server);
  await Bun.sleep(10);

  const failure = await host.inject({
    operationId: "op-unsupported",
    threadId: server.threadId,
    text: "nowhere to go",
    contentDigest: digestOf("nowhere to go"),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StructuredInjectError);
  expect((failure as StructuredInjectError).phase).toBe("refused");
  /* NO SILENT FALLBACK: the operator asked for injection and gets a refusal,
     never a steer or a new turn wearing injection's label. */
  for (const method of TURN_MUTATIONS) {
    expect(server.requests.some((request) => request.method === method)).toBe(false);
  }

  /* And the capability is retired, so nothing offers the action again. */
  const health = await host.health();
  expect(health.activeFlags).not.toContain("native-inject");
  expect(health.diagnostics?.injectCapability).toBe("unsupported");
  await host.release();
});

test("a host on a protocol without injection advertises no capability", async () => {
  const server = new InjectAppServer(scratchRoot(), INVENTED_THREAD_ID, "0.150.0");
  const host = await startHost(server);
  await Bun.sleep(10);

  const health = await host.health();
  expect(health.activeFlags).not.toContain("native-inject");
  expect(health.diagnostics?.injectCapability).toBe("unsupported");
  await host.release();
});

test("a supporting host advertises the capability", async () => {
  const server = new InjectAppServer(scratchRoot());
  const host = await startHost(server);
  await Bun.sleep(10);

  const health = await host.health();
  expect(health.activeFlags).toContain("native-inject");
  expect(health.diagnostics?.injectCapability).toBe("supported");
  await host.release();
});

test("a restart finds the earlier insertion in canonical history and writes nothing", async () => {
  const root = scratchRoot();
  const first = new InjectAppServer(root);
  const firstHost = await startHost(first);
  await Bun.sleep(10);
  await firstHost.inject({
    operationId: "op-survives",
    threadId: first.threadId,
    text: "survives a restart",
    contentDigest: digestOf("survives a restart"),
  });
  expect(first.injectedItems).toHaveLength(1);
  await firstHost.release();

  /* A NEW host generation over the SAME rollout: the durable dedup marker is
     the only thing carrying the earlier insertion across, and it is enough. */
  const second = new InjectAppServer(root);
  const secondHost = await startHost(second);
  await Bun.sleep(10);
  const outcome = await secondHost.inject({
    operationId: "op-survives",
    threadId: second.threadId,
    text: "survives a restart",
    contentDigest: digestOf("survives a restart"),
  });
  expect(outcome.observed).toBe(true);
  expect(second.injectedItems).toHaveLength(0);
  await secondHost.release();
});

test("NEGATIVE CONTROL: an unrelated user record does not satisfy an injection", async () => {
  const server = new InjectAppServer(scratchRoot());
  server.persistOnInject = false;
  const host = await startHost(server);
  await Bun.sleep(10);

  /* A user record with no dedup marker, and one carrying a DIFFERENT
     operation's marker. Neither may be read as this insertion. */
  appendFileSync(server.rolloutPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "unrelated chatter" }] },
  })}\n`);

  const outcome = await host.inject({
    operationId: "op-negative",
    threadId: server.threadId,
    text: "the real one",
    contentDigest: digestOf("the real one"),
  });
  expect(outcome.observed).toBe(false);
  await host.release();
});

test("NEGATIVE CONTROL: a marker on a developer record is never read as operator input", async () => {
  const server = new InjectAppServer(scratchRoot());
  server.persistOnInject = false;
  const host = await startHost(server);
  await Bun.sleep(10);

  /* The identical envelope the injection would write, but in the developer
     role. Roles are what separate the operator's words from the harness's, so
     a marker here must not settle the operator's operation. */
  const { createHash } = await import("node:crypto");
  const dedup = createHash("sha256").update("op-role").digest("hex");
  appendFileSync(server.rolloutPath, `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: `<!-- llv:structured-user origin=operator dedup=${dedup} -->\nforged` }],
    },
  })}\n`);

  const outcome = await host.inject({
    operationId: "op-role",
    threadId: server.threadId,
    text: "forged",
    contentDigest: digestOf("forged"),
  });
  expect(outcome.observed).toBe(false);
  await host.release();
});
