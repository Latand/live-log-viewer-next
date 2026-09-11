import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore } from "./eventStore";
import { structuredContent } from "./structuredContent";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { RuntimeJournal } from "@/runtime-host/journal";

// Real Codex protocol and real canonical history. Only account/read is shimmed:
// the Viewer requires a subscription account, while this local Responses
// provider deliberately has no credentials. No operator environment is copied.
const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
async function until(predicate: () => boolean, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await Bun.sleep(20);
  expect(predicate()).toBe(true);
}
function sse(type: string, data: object) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
async function fixture() {
  const version = spawnSync(codexBinary, ["--version"], { encoding: "utf8" });
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toBe("codex-cli 0.154.0");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "inj-real-"));
  const model = "fixture-model";
  const requests: Array<{ body: { input?: unknown[] } }> = [];
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  let dropInjectAck = false;
  let processChild: ChildProcessWithoutNullStreams | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const raw = new Uint8Array(await req.arrayBuffer());
    const encoding = req.headers.get("content-encoding");
    const data = encoding === "zstd" ? Bun.zstdDecompressSync(raw)
      : encoding === "gzip" ? Bun.gunzipSync(raw) : raw;
    requests.push({ body: JSON.parse(new TextDecoder().decode(data)) });
    const n = requests.length;
    return new Response(new ReadableStream({ async start(controller) {
      const encode = (s: string) => new TextEncoder().encode(s);
      controller.enqueue(encode(sse("response.created", { response: { id: `resp_${n}` } })));
      if (n === 1) await held;
      try {
        controller.enqueue(encode(sse("response.output_item.done", { output_index: 0, item: {
          type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: `REPLY-${n}` }],
        } }) + sse("response.completed", { response: { id: `resp_${n}`, status: "completed", output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })));
        controller.close();
      } catch { /* An interrupted turn closes its fixture response. */ }
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex");
  const cwd = path.join(root, "workspace");
  for (const d of [home, codexHome, cwd, path.join(root, "events"), path.join(root, "t")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "${model}"
model_provider = "fixture"
web_search = "disabled"
[model_providers.fixture]
name = "Local Responses fixture"
base_url = "http://127.0.0.1:${server.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  const accountReadIds = new Set<unknown>();
  const rpcOut: { at: number; method: string; id?: unknown }[] = [];
  const notes: { at: number; method: string; params?: { turn?: { id?: string } } }[] = [];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TMPDIR: path.join(root, "t"), LANG: "C.UTF-8" };

  const host = await CodexAppServerHost.start({
    cwd,
    binary: codexBinary,
    codexHome,
    env,
    model,
    sandbox: "read-only",
    approvalPolicy: "never",
    requestTimeoutMs: 5_000,
    deliveryConfirmationTimeoutMs: 20_000,
    injectObservationTimeoutMs: 30_000,
    eventStore: new FileRuntimeEventStore(path.join(root, "events")),
    spawnProcess: (command, args, options) => {
      const child = spawn(command, args, options);
      processChild = child;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          try { const m = JSON.parse(line); if (m.method) rpcOut.push({ at: Date.now(), method: m.method, id: m.id }); if (m.method === "account/read") accountReadIds.add(m.id); } catch {}
        }
        return typeof encoding === "string" ? write(chunk, encoding, callback) : write(chunk, encoding);
      };
      /* Gate shim: ONLY the host's account/read answer is rewritten to a chatgpt
         account (the local no-auth provider always reports account:null). Every
         other byte, including all thread/turn/inject traffic, is the real
         app-server's. */
      const shimmed = new PassThrough();
      let shimBuf = "";
      child.stdout.on("data", (c: Buffer) => {
        shimBuf += c.toString("utf8");
        let j;
        while ((j = shimBuf.indexOf("\n")) >= 0) {
          let line = shimBuf.slice(0, j); shimBuf = shimBuf.slice(j + 1);
          try {
            const m = JSON.parse(line);
            if (dropInjectAck && rpcOut.some(r => r.method === "thread/inject_items" && r.id === m.id)) continue;
            if (m.id !== undefined && accountReadIds.has(m.id) && m.result && m.result.account === null) {
              m.result.account = { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" };
              line = JSON.stringify(m);
            }
          } catch {}
          shimmed.write(line + "\n");
        }
      });
      child.stdout.on("end", () => shimmed.end());
      Object.defineProperty(child, "stdout", { value: shimmed, configurable: true });
      let buf = "";
      shimmed.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { const m = JSON.parse(line); if (m.method && m.id === undefined) notes.push({ at: Date.now(), method: m.method, params: m.params }); } catch {}
        }
      });
      return child;
    },
  }).catch(error => {
    releaseFirst();
    processChild?.kill("SIGKILL");
    server.stop(true);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  });

  const journal = new RuntimeJournal(path.join(root, "journal.sqlite"), { structuredHosts: true });
  const binding = { threadId: host.identity.threadId, accountId: null, writerClaim: "fixture-owner:1" };
  let currentBinding = { ...binding };
  journal.append({ scope: { type: "session", id: "fixture-conversation" }, kind: "session-status", payload: {
    conversationId: "fixture-conversation", sessionKey: { engine: "codex", sessionId: binding.threadId },
    hostKind: "codex-app-server", host: "hosted", turn: "idle", accountId: null, writerClaim: binding.writerClaim,
    capabilities: { inject: true, steer: true, structuredAttention: true }, activeTurnId: null,
  } });
  const queue = new StructuredDeliveryQueue({
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
    status: async id => journal.operationResult(id)?.receipt ?? null,
    transition: async (id, status, details) => { journal.transitionOperation(id, status, details); },
    hostClaim: () => currentBinding.writerClaim,
    injectionBinding: () => currentBinding,
  }, () => host);
  return {
    host, requests, rpcOut, notes, queue, releaseFirst,
    async interrupt(turnId: string) {
      journal.append({ scope: { type: "session", id: "fixture-conversation" }, kind: "session-status",
        payload: { turn: "running", activeTurnId: turnId } });
      const result = journal.executeOperation({ kind: "interrupt", conversationId: "fixture-conversation", idempotencyKey: "interrupt-once", turnId });
      await queue.drainAfterAdmission();
      return journal.operationResult(result.operationId)!.receipt;
    },
    drift: () => { currentBinding = { ...currentBinding, writerClaim: "fixture-owner:2" }; },
    dropAck: () => { dropInjectAck = true; },
    killChild: () => processChild!.kill("SIGKILL"),
    admit(text = "injected fixture context") {
      const result = journal.executeOperation({ kind: "inject", conversationId: "fixture-conversation",
        idempotencyKey: "inject-once", text, contentDigest: structuredContent(text, []).contentDigest });
      return () => journal.operationResult(result.operationId)!.receipt;
    },
    async stop() { releaseFirst(); await host.release(); journal.close(); server.stop(true); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("real Codex: proof after 10 seconds settles the original receipt in the same turn with one injection", async () => {
  const f = await fixture();
  try {
    const send = await f.host.send({ id: "start-fixture-turn", text: "start fixture turn" });
    expect(send.outcome).toBe("turn-started");
    const turnId = (send as { turnId: string }).turnId;
    await until(() => f.requests.length === 1);
    const at = f.rpcOut.length;
    const receipt = f.admit();
    const start = Date.now();
    await f.queue.drain();
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(receipt().status).toBe("delivering");
    await Bun.sleep(10_500);
    // A later pass must preserve the acknowledged operation, never abandon or replay it.
    await f.queue.drain();
    expect(receipt().status).toBe("delivering");
    expect(f.requests).toHaveLength(1);
    f.releaseFirst();
    await until(() => receipt().status === "delivered");
    expect(Date.now() - start).toBeGreaterThan(10_000);
    expect(receipt().turnId).toBe(turnId);
    expect(f.requests).toHaveLength(2);
    const input = f.requests[1]!.body.input!;
    expect(input.some(item => JSON.stringify(item).includes("injected fixture context"))).toBe(true);
    expect(input.some(item => JSON.stringify(item).includes("REPLY-1"))).toBe(true);
    expect(f.rpcOut.slice(at).map(r => r.method)).toEqual(["thread/inject_items"]);
    await until(() => f.notes.some(n => n.method === "turn/completed"));
    expect(f.notes.filter(n => n.method === "turn/started")).toHaveLength(1);
    expect(f.notes.find(n => n.method === "turn/completed")!.params?.turn?.id).toBe(turnId);
    await f.queue.drain();
    expect(f.rpcOut.slice(at).filter(r => r.method === "thread/inject_items")).toHaveLength(1);
  } finally { await f.stop(); }
}, 45_000);

test("real Codex: idle injection persists with no generation", async () => {
  const f = await fixture();
  try {
    const at = f.rpcOut.length;
    const receipt = f.admit();
    await f.queue.drain();
    await until(() => receipt().status === "delivered");
    expect(f.requests).toHaveLength(0);
    expect(f.notes.some(n => n.method === "turn/started")).toBe(false);
    expect(f.rpcOut.slice(at).map(r => r.method)).toEqual(["thread/inject_items"]);
  } finally { await f.stop(); }
}, 20_000);

test("real Codex: interrupt runs while observation is pending; ending without proof settles uncertain", async () => {
  const f = await fixture();
  try {
    const send = await f.host.send({ id: "start-interrupted-turn", text: "start fixture turn" });
    await until(() => f.requests.length === 1);
    const receipt = f.admit();
    await f.queue.drain();
    expect(receipt().status).toBe("delivering");
    // This is an independently requested interrupt, not an injection fallback.
    const start = Date.now();
    const interrupted = await f.interrupt((send as { turnId: string }).turnId);
    expect(interrupted.status).toBe("interrupted");
    expect(Date.now() - start).toBeLessThan(2_000);
    await until(() => receipt().status === "uncertain");
    await f.queue.drain();
    expect(f.rpcOut.filter(r => r.method === "thread/inject_items")).toHaveLength(1);
  } finally { await f.stop(); }
}, 20_000);

test("real Codex: writer generation drift after admission produces zero injections", async () => {
  const f = await fixture();
  try {
    const receipt = f.admit();
    f.drift();
    await f.queue.drain();
    expect(receipt().status).toBe("failed");
    expect(receipt().reason).toBe("stale-generation");
    expect(f.rpcOut.some(r => r.method === "thread/inject_items")).toBe(false);
  } finally { await f.stop(); }
}, 20_000);

for (const loss of ["child exit", "host release"] as const) {
  test(`real Codex: lost acknowledgement followed by ${loss} remains uncertain without replay`, async () => {
    const f = await fixture();
    try {
      f.dropAck();
      const receipt = f.admit();
      const pass = f.queue.drain();
      await until(() => f.rpcOut.some(r => r.method === "thread/inject_items"));
      if (loss === "child exit") f.killChild(); else await f.host.release();
      await pass;
      expect(receipt().status).toBe("uncertain");
      await f.queue.drain();
      expect(f.rpcOut.filter(r => r.method === "thread/inject_items")).toHaveLength(1);
    } finally { await f.stop(); }
  }, 20_000);
}
