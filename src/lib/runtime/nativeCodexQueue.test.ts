import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import {
  NativeCodexQueue, NativeQueueProtocolRefusal, NativeQueueUncertainError,
  type NativeQueueRpcPort, type NativeQueueInput,
} from "./nativeCodexQueue";

const input: NativeQueueInput[] = [{ type: "text", text: "queued input", text_elements: [] }];
const submission = (id = "submission-a", clientUserMessageId = "client-a") => ({
  id, clientUserMessageId, input: structuredClone(input),
});

// Explicit opt-in: never discover a CLI/account or contact an external model.
// The fixture retains its private scratch directory for inspection.
const binary = process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;
test.skipIf(!binary)("installed Codex 0.154.0: adapter pagination and mutation acknowledgements", async () => {
  if (!binary || !isAbsolute(binary)) throw new Error("An absolute fixture binary is required");
  const base = mkdtempSync(join(tmpdir(), "nq-"));
  const env: NodeJS.ProcessEnv & Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME",
    "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = join(base, key.toLowerCase());
    mkdirSync(env[key]);
  }
  const cwd = join(base, "workspace");
  mkdirSync(cwd);
  expect(spawnSync(binary, ["--version"], { env, encoding: "utf8" }).stdout.trim()).toBe("codex-cli 0.154.0");
  const backendStarted = deferred<void>();
  const backend = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"response_fixture"}}\n\n');
    backendStarted.resolve();
    // Hold this synthetic turn until the fixture explicitly interrupts it.
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  if (!address || typeof address === "string") throw new Error("Fixture backend did not bind");
  writeFileSync(join(env.CODEX_HOME, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.fixture]
name = "Local queue fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  const child = spawn(binary, ["app-server", "--stdio"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  let serial = 0;
  let adapter: NativeCodexQueue | undefined;
  const completed = deferred<void>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new NativeQueueProtocolRefusal(message.error.code, message.error.message));
      else call.resolve(message.result);
    } else {
      adapter?.handleNotification(message.method, message.params);
      if (message.method === "turn/completed") completed.resolve();
    }
  });
  const failPending = () => { for (const call of pending.values()) call.reject(new Error("Fixture transport closed")); pending.clear(); };
  child.on("error", failPending);
  child.on("exit", failPending);
  const calls: string[] = [];
  const rpc: NativeQueueRpcPort["rpc"] = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    calls.push(method);
    const requestId = ++serial;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Fixture RPC timeout")); }, timeoutMs);
    pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (reason) => { clearTimeout(timer); reject(reason); },
    });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
  });
  async function wait<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture event timeout")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    await rpc("initialize", { clientInfo: { name: "queue_adapter_fixture", version: "1" }, capabilities: { experimentalApi: true } }, 5000);
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const started = await rpc("thread/start", { cwd, model: "fixture-model", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only" }, 5000) as { thread: { id: string } };
    const threadId = started.thread.id;
    adapter = new NativeCodexQueue({ rpc }, threadId, { pageSize: 1 });
    const active = await rpc("turn/start", { threadId, input, clientUserMessageId: "active-client" }, 5000) as { turn: { id: string } };
    await wait(backendStarted.promise);
    const a = (await adapter.add("same-client", input)).result.queuedSubmission;
    const b = (await adapter.add("same-client", input)).result.queuedSubmission;
    expect(a.id).not.toBe(b.id);
    expect(a.clientUserMessageId).toBe(b.clientUserMessageId);
    const beforePages = calls.filter((method) => method === "thread/queue/list").length;
    expect((await adapter.refresh()).items?.map((item) => item.id)).toEqual([a.id, b.id]);
    // An add notification may arrive after its acknowledgement and invalidate
    // the first pagination pass. Both passes remain bounded and complete.
    const pageCalls = calls.filter((method) => method === "thread/queue/list").length - beforePages;
    expect([2, 4]).toContain(pageCalls);
    const edited: NativeQueueInput[] = [{ type: "text", text: "edited native input", text_elements: [] }];
    expect((await adapter.update(a, edited)).result.queuedSubmission).toMatchObject({ id: a.id, clientUserMessageId: a.clientUserMessageId, input: edited });
    expect((await adapter.reorder([b.id, a.id])).outcome).toBe("acknowledged");
    expect((await adapter.refresh()).items?.map((item) => item.id)).toEqual([b.id, a.id]);
    expect((await adapter.delete(b.id)).result.deleted).toBe(true);
    expect((await adapter.delete(b.id)).result.deleted).toBe(false);
    await expect(adapter.start(a.id)).rejects.toBeInstanceOf(NativeQueueProtocolRefusal);
    await rpc("turn/interrupt", { threadId, turnId: active.turn.id }, 5000);
    await wait(completed.promise);
    const ack = await adapter.start(a.id);
    expect(ack.outcome).toBe("acknowledged");
    expect(ack.result.turn.id).toBeTruthy();
    expect((await adapter.refresh()).items).toEqual([]);
    // Empty native queue is still unrelated to durable delivery settlement.
    expect(ack.outcome).toBe("acknowledged");
    const lostAck = new NativeCodexQueue({ rpc: async (method, params, timeoutMs) => {
      const result = await rpc(method, params, timeoutMs);
      if (method === "thread/queue/add") throw new Error("Fixture dropped the successful acknowledgement");
      return result;
    } }, threadId, { pageSize: 1 });
    const beforeAdds = calls.filter((method) => method === "thread/queue/add").length;
    await expect(lostAck.add("lost-ack-client", input)).rejects.toBeInstanceOf(NativeQueueUncertainError);
    expect(calls.filter((method) => method === "thread/queue/add").length - beforeAdds).toBe(1);
    expect((await lostAck.refresh()).items?.filter((item) => item.clientUserMessageId === "lost-ack-client")).toHaveLength(1);
    lostAck.dispose();
  } finally {
    adapter?.dispose();
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
    try { if (child.exitCode === null) await wait(exited); }
    finally { clearTimeout(timer); lines.close(); backend.closeAllConnections(); backend.close(); }
  }
}, 30_000);
const page = (...data: ReturnType<typeof submission>[]) => ({ data, nextCursor: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(replies: Array<unknown | (() => unknown)> = [], options = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const port: NativeQueueRpcPort = { rpc: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (!replies.length) throw new Error("unexpected RPC");
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  } };
  return { queue: new NativeCodexQueue(port, "thread-a", options), calls, replies };
}

describe("native queue reads", () => {
  test("coalesces callers and commits all pages with opaque cursors in order", async () => {
    const pending = deferred<unknown>();
    const { queue, calls } = fixture([() => pending.promise, page(submission("submission-b"))]);
    const first = queue.refresh();
    const second = queue.refresh();
    expect(first).toBe(second);
    expect(queue.read()).toEqual({ threadId: "thread-a", items: null, stale: true });
    pending.resolve({ data: [submission()], nextCursor: "opaque:2" });
    expect((await first).items?.map((s) => s.id)).toEqual(["submission-a", "submission-b"]);
    expect(calls).toEqual([
      { method: "thread/queue/list", params: { threadId: "thread-a", cursor: null, limit: 100 } },
      { method: "thread/queue/list", params: { threadId: "thread-a", cursor: "opaque:2", limit: 100 } },
    ]);
    expect(queue.read().stale).toBe(false);
  });

  const invalidPages = [
    null, {}, { data: null }, { data: [] }, { data: [], nextCursor: 4 },
    { data: [], nextCursor: "" }, { data: [], nextCursor: null, threadId: "thread-b" },
    page({ ...submission(), id: "" }), page({ ...submission(), clientUserMessageId: "" }),
    page({ ...submission(), input: [{ type: "image" }] } as never),
    page({ ...submission(), threadId: "thread-b" } as never),
    page(submission(), submission()),
  ];
  test.each(invalidPages)("malformed page cannot erase a complete snapshot: %j", async (bad) => {
    const { queue } = fixture([page(submission()), bad]);
    await queue.refresh();
    await expect(queue.refresh()).rejects.toThrow();
    expect(queue.read()).toEqual({ threadId: "thread-a", items: [submission()], stale: true });
  });

  test("partial results and RPC errors retain the last complete snapshot", async () => {
    const { queue } = fixture([page(submission()), { data: [], nextCursor: "next" }, new Error("lost page")]);
    await queue.refresh();
    await expect(queue.refresh()).rejects.toThrow("lost page");
    expect(queue.read().items).toEqual([submission()]);
    expect(queue.read().stale).toBe(true);
  });

  test.each(["cursor", "duplicate", "pages", "items", "identity"])("rejects bounded/inconsistent pagination: %s", async (kind) => {
    const next = { data: [submission("submission-b")], nextCursor: "next" };
    const replies = kind === "identity" ? [page(submission("submission-a", "different-client"))]
      : kind === "items" ? [page(submission(), submission("submission-b"))]
      : [next, kind === "duplicate" ? page(submission("submission-b")) : { data: [], nextCursor: "next" }];
    const { queue, calls } = fixture([page(submission()), ...replies], {
      ...(kind === "pages" ? { maxPages: 1 } : {}), ...(kind === "items" ? { maxItems: 1 } : {}),
    });
    await queue.refresh();
    await expect(queue.refresh()).rejects.toThrow();
    expect(queue.read().items).toEqual([submission()]);
    expect(queue.read().stale).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  test("notifications invalidate only the bound thread and coalesce a fresh pass", async () => {
    const pending = deferred<unknown>();
    const started = deferred<void>();
    const { queue, calls } = fixture([page(submission()), () => { started.resolve(); return pending.promise; }, page(submission("fresh"))]);
    await queue.refresh();
    expect(queue.handleNotification("thread/queue/changed", { threadId: "thread-b" })).toBe(false);
    expect(queue.handleNotification("turn/started", { threadId: "thread-a" })).toBe(false);
    expect(queue.handleNotification("thread/queue/changed", {})).toBe(false);
    expect(queue.read().stale).toBe(false);
    expect(queue.handleNotification("thread/queue/changed", { threadId: "thread-a" })).toBe(true);
    expect(calls).toHaveLength(1);
    const refresh = queue.refresh();
    await started.promise;
    for (let i = 0; i < 50; i++) queue.handleNotification("thread/queue/changed", { threadId: "thread-a" });
    pending.resolve(page());
    expect((await refresh).items?.[0].id).toBe("fresh");
    expect(calls).toHaveLength(3);
  });

  test("invalidation storms stop at the refresh-pass bound", async () => {
    const { queue, replies, calls } = fixture([page(submission())], { maxRefreshPasses: 2 });
    await queue.refresh();
    const changing = () => { queue.invalidate(); return page(); };
    replies.push(changing, changing);
    await expect(queue.refresh()).rejects.toThrow();
    expect(calls).toHaveLength(3);
    expect(queue.read()).toEqual({ threadId: "thread-a", items: [submission()], stale: true });
  });

  test("a hanging port is time bounded and cannot accumulate overlapping reads", async () => {
    const pending = deferred<unknown>();
    const { queue, calls, replies } = fixture([() => pending.promise], { timeoutMs: 10 });
    await expect(queue.refresh()).rejects.toThrow();
    await expect(queue.refresh()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    pending.resolve(page(submission("late")));
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.read().items).toBeNull();
    replies.push(page(submission()));
    await queue.refresh();
    expect(queue.read().items).toEqual([submission()]);
  });

  test("snapshot copies cannot corrupt retained inputs or identity", async () => {
    const { queue } = fixture([page(submission())]);
    const snapshot = await queue.refresh();
    snapshot.items![0].id = "changed";
    snapshot.items![0].input.length = 0;
    expect(queue.read().items).toEqual([submission()]);
  });

  test("a mutation between list request and response forces a complete new read", async () => {
    const pending = deferred<unknown>();
    const started = deferred<void>();
    const { queue, calls } = fixture([
      page(submission()), () => { started.resolve(); return pending.promise; },
      { queuedSubmission: submission("submission-b") }, page(submission("submission-b")),
    ]);
    await queue.refresh();
    const refreshing = queue.refresh();
    await started.promise;
    await queue.add("client-a", input);
    pending.resolve(page());
    expect((await refreshing).items).toEqual([submission("submission-b")]);
    expect(calls).toHaveLength(4);
  });

  test("disposing during pagination preserves the stale snapshot and rejects late pages", async () => {
    const pending = deferred<unknown>();
    const started = deferred<void>();
    const { queue } = fixture([page(submission()), () => { started.resolve(); return pending.promise; }]);
    await queue.refresh();
    const refreshing = queue.refresh();
    await started.promise;
    queue.dispose();
    pending.resolve(page());
    await expect(refreshing).rejects.toThrow("disposed");
    expect(queue.read()).toEqual({ threadId: "thread-a", items: [submission()], stale: true });
  });
});

describe("native queue mutations", () => {
  test("preserves all native input variants and separate server/client identities through add and update", async () => {
    const media: NativeQueueInput[] = [
      { type: "text", text: "é", text_elements: [{ byteRange: { start: 0, end: 2 }, placeholder: null }] },
      { type: "image", url: "data:image/png;base64,AA==", detail: "original" },
      { type: "localImage", path: "fixtures/image.png", detail: null },
      { type: "audio", url: "data:audio/wav;base64,AA==" },
      { type: "localAudio", path: "fixtures/audio.wav" },
      { type: "skill", name: "example", path: "fixtures/SKILL.md" },
      { type: "mention", name: "document", path: "fixtures/document.md" },
    ];
    const queuedSubmission = { ...submission(), input: media };
    const { queue, calls } = fixture([{ queuedSubmission }, { queuedSubmission }]);
    expect(await queue.add("client-a", media)).toEqual({ outcome: "acknowledged", result: { queuedSubmission } });
    expect(await queue.update(queuedSubmission, media)).toEqual({ outcome: "acknowledged", result: { queuedSubmission } });
    expect(calls).toEqual([
      { method: "thread/queue/add", params: { threadId: "thread-a", clientUserMessageId: "client-a", input: media } },
      { method: "thread/queue/update", params: { threadId: "thread-a", queuedSubmissionId: "submission-a", input: media } },
    ]);
    expect(queue.read()).toEqual({ threadId: "thread-a", items: null, stale: true });
  });

  test("duplicate client IDs remain separate native submissions; empty queue does not settle either", async () => {
    const { queue, calls } = fixture([{ queuedSubmission: submission() }, { queuedSubmission: submission("submission-b") }, page()]);
    const first = await queue.add("client-a", input);
    const second = await queue.add("client-a", input);
    expect(first.result.queuedSubmission.id).not.toBe(second.result.queuedSubmission.id);
    expect(first.outcome).toBe("acknowledged");
    expect(second.outcome).toBe("acknowledged");
    expect((await queue.refresh()).items).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  test("delete/reorder/start use native IDs, optional start selector, and native acknowledgements", async () => {
    const turn = { id: "turn-a", status: "inProgress" as const, items: [], error: null };
    const { queue, calls } = fixture([{ deleted: false }, {}, { turn }, { turn }]);
    expect((await queue.delete("submission-a")).result).toEqual({ deleted: false });
    expect((await queue.reorder(["submission-b", "submission-a"])).outcome).toBe("acknowledged");
    expect((await queue.start("submission-a")).result).toEqual({ turn });
    expect((await queue.start()).outcome).toBe("acknowledged");
    expect(calls.map((c) => c.params)).toEqual([
      { threadId: "thread-a", queuedSubmissionId: "submission-a" },
      { threadId: "thread-a", queuedSubmissionIds: ["submission-b", "submission-a"] },
      { threadId: "thread-a", queuedSubmissionId: "submission-a" }, { threadId: "thread-a" },
    ]);
  });

  test.each(["add", "update", "delete", "reorder", "start"] as const)("lost %s acknowledgement is uncertain and never retried", async (method) => {
    const { queue, calls } = fixture([new Error("connection lost after write")]);
    const action = () => method === "add" ? queue.add("client-a", input)
      : method === "update" ? queue.update(submission(), input)
      : method === "delete" ? queue.delete("submission-a")
      : method === "reorder" ? queue.reorder(["submission-a"]) : queue.start("submission-a");
    const error = await action().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeQueueUncertainError);
    expect(error).toMatchObject({ outcome: "uncertain", method: `thread/queue/${method}`, threadId: "thread-a" });
    expect(calls).toHaveLength(1);
    expect(queue.read().stale).toBe(true);
  });

  test.each([
    ["add", { queuedSubmission: submission("submission-a", "wrong-client") }],
    ["update", { queuedSubmission: submission("wrong-server-id") }],
    ["update", { queuedSubmission: submission("submission-a", "wrong-client") }],
    ["delete", {}], ["delete", { deleted: "true" }], ["reorder", null],
    ["reorder", { error: { code: -32602, message: "wrapped error" } }],
    ["add", { threadId: "thread-b", queuedSubmission: submission() }],
    ["start", { turn: { id: "turn-a", status: "inProgress", items: [], threadId: "thread-b" } }],
    ["start", { turn: { id: "", status: "inProgress", items: [] } }],
    ["start", { turn: { id: "turn-a", status: "invented", items: [] } }],
    ["start", { turn: { id: "turn-a", status: "inProgress" } }],
  ])("malformed or mismatched %s acknowledgement is uncertain", async (method, reply) => {
    const { queue } = fixture([reply]);
    const action = method === "add" ? queue.add("client-a", input)
      : method === "update" ? queue.update(submission(), input)
      : method === "delete" ? queue.delete("submission-a")
      : method === "reorder" ? queue.reorder([]) : queue.start();
    await expect(action).rejects.toBeInstanceOf(NativeQueueUncertainError);
  });

  test("only an explicit protocol refusal is classified as refused", async () => {
    const refusal = new NativeQueueProtocolRefusal(-32602, "queue is empty");
    const { queue, calls } = fixture([refusal, Object.assign(new Error("socket"), { code: -32602 })]);
    await expect(queue.start()).rejects.toBe(refusal);
    await expect(queue.start()).rejects.toBeInstanceOf(NativeQueueUncertainError);
    expect(calls).toHaveLength(2);
  });

  test("timeout remains uncertain after a late acknowledgement", async () => {
    const pending = deferred<unknown>();
    const { queue, calls } = fixture([() => pending.promise], { timeoutMs: 10 });
    const error = await queue.add("client-a", input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeQueueUncertainError);
    pending.resolve({ queuedSubmission: submission() });
    await pending.promise;
    expect(queue.read().items).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("an unresolved wire mutation keeps reads stale beyond the caller deadline", async () => {
    const pending = deferred<unknown>();
    const { queue, calls, replies } = fixture([page(submission()), () => pending.promise], { timeoutMs: 10 });
    await queue.refresh();
    await expect(queue.add("client-a", input)).rejects.toBeInstanceOf(NativeQueueUncertainError);
    await expect(queue.refresh()).rejects.toThrow("mutation is still pending");
    expect(calls).toHaveLength(2);
    pending.resolve({ queuedSubmission: submission("submission-b") });
    await pending.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.read().stale).toBe(true);
    replies.push(page(submission("submission-b")));
    expect((await queue.refresh()).items).toEqual([submission("submission-b")]);
  });

  test("an in-flight mutation prevents a read from claiming a fresh queue", async () => {
    const pending = deferred<unknown>();
    const { queue, replies } = fixture([page(submission()), () => pending.promise]);
    await queue.refresh();
    const adding = queue.add("client-a", input);
    await expect(queue.refresh()).rejects.toThrow();
    expect(queue.read()).toEqual({ threadId: "thread-a", items: [submission()], stale: true });
    pending.resolve({ queuedSubmission: submission("submission-b") });
    await adding;
    replies.push(page(submission("submission-b")));
    expect((await queue.refresh()).stale).toBe(false);
  });

  test("local validation and disposal cannot send mutations", async () => {
    const { queue, calls } = fixture();
    await expect(queue.add("", input)).rejects.toThrow();
    await expect(queue.update(submission(), [{ type: "audio" }] as never)).rejects.toThrow();
    await expect(queue.reorder(["duplicate", "duplicate"])).rejects.toThrow();
    queue.dispose();
    await expect(queue.start()).rejects.toThrow();
    await expect(queue.refresh()).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("disposal before the RPC microtask prevents an unsent mutation", async () => {
    const { queue, calls } = fixture([{ queuedSubmission: submission() }]);
    const adding = queue.add("client-a", input);
    queue.dispose();
    await expect(adding).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
