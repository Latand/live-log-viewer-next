import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readCodexHistory, findCodexHistoryDelivery,
  type CodexHistoryRpc, type CodexHistoryOptions, type CodexHistoryDeliveryTarget,
} from "./codexHistoryReader";

const identity = { threadId: "thread-a", path: "/fixture/session.jsonl" };
const content = [{ type: "text", text: "Повідомлення 🌍 e\u0301", text_elements: [] }];
const user = { type: "userMessage", id: "item-a", clientId: "original-key", content };
const target: CodexHistoryDeliveryTarget = { clientId: user.clientId, content, turnId: "turn-a", itemId: user.id };
const turn = (items: unknown[] = [user], itemsView = "full", id = "turn-a") => ({ id, status: "completed", items, itemsView });
const page = (data: unknown[], nextCursor: string | null = null) => ({ data, nextCursor, backwardsCursor: null });
const metadata = { thread: { id: identity.threadId, path: identity.path, ephemeral: false } };
const options = (extra: Partial<CodexHistoryOptions> = {}): CodexHistoryOptions => ({ deadlineAt: Date.now() + 2000, ...extra });
function fixture(responses: unknown[]) {
  const calls: { method: string; params: Record<string, unknown>; timeout: number }[] = [];
  const rpc: CodexHistoryRpc = async (method, params, timeout) => {
    calls.push({ method, params, timeout });
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return structuredClone(response);
  };
  return { rpc, calls };
}
async function lookup(responses: unknown[], wanted = target, extra: Partial<CodexHistoryOptions> = {}) {
  const f = fixture(responses);
  const history = await readCodexHistory(f.rpc, identity, options(extra));
  return { history, delivery: findCodexHistoryDelivery(history, wanted), calls: f.calls };
}

describe("bounded canonical history", () => {
  test("walks second turns and items pages, preserves order and opaque cursors", async () => {
    const turnCursor = '{"anchor":"opaque-turn"}';
    const itemCursor = '{"anchor":"opaque-item"}';
    const tool = { type: "commandExecution", id: "tool-a", aggregatedOutput: "tool result" };
    const result = await lookup([
      metadata,
      page([turn([], "notLoaded", "turn-b")], turnCursor),
      page([]),
      page([turn([], "summary")]),
      page([{ turnId: "turn-a", item: tool }], itemCursor),
      page([{ turnId: "turn-a", item: user }]),
    ]);
    expect(result.delivery.state).toBe("found");
    expect(result.calls.map(c => [c.method, c.params.cursor])).toEqual([
      ["thread/read", undefined], ["thread/turns/list", null], ["thread/items/list", null],
      ["thread/turns/list", turnCursor], ["thread/items/list", null], ["thread/items/list", itemCursor],
    ]);
    if (result.history.state !== "complete") throw new Error("history incomplete");
    expect(result.history.turns.map(t => t.id)).toEqual(["turn-b", "turn-a"]);
    expect(result.history.turns[1].items.map(i => i.id)).toEqual(["tool-a", "item-a"]);
    expect(result.history.pages[3].nextCursor).toBe(itemCursor);
    expect(result.calls.every(c => c.timeout > 0 && c.timeout <= 2000)).toBe(true);
  });

  test("full is complete, including the schema's omitted itemsView default", async () => {
    const full = turn();
    const { itemsView: _view, ...omitted } = full;
    for (const row of [full, omitted]) {
      const result = await lookup([metadata, page([row])]);
      expect(result.delivery.state).toBe("found");
      expect(result.calls).toHaveLength(2);
    }
  });

  test("summary and partial full items cannot supply delivery evidence", async () => {
    for (const row of [turn([user], "summary"), turn([], "notLoaded"), { ...turn(), itemsBackwardsCursor: "older" }]) {
      const result = await lookup([metadata, page([row]), page([])]);
      expect(result.history.state).toBe("complete");
      expect(result.delivery).toEqual({ state: "unknown", reason: "not-observed" });
      expect(result.calls[2].params.cursor).toBeNull();
    }
  });

  test("canonical record removal makes the positive control red", async () => {
    expect((await lookup([metadata, page([turn()])])).delivery.state).toBe("found");
    expect((await lookup([metadata, page([turn([])])])).delivery.state).toBe("unknown");
  });

  test("requires key, exact payload, turn and optional canonical item identity", async () => {
    for (const change of [
      { clientId: "wrong" }, { content: [{ type: "text", text: "other" }] },
      { turnId: "other-turn" }, { itemId: "other-item" },
      { content: [{ type: "text", text: "Повідомлення 🌍 é" }] },
      { content: [...content, { type: "image", url: "fixture-image" }] },
    ]) expect((await lookup([metadata, page([turn()])], { ...target, ...change })).delivery.state).toBe("unknown");
    expect((await lookup([metadata, page([turn()])], { ...target, turnId: null })).delivery.state).toBe("found");
    expect((await lookup([metadata, page([turn()])], { ...target, turnId: undefined } as unknown as CodexHistoryDeliveryTarget)).delivery.state).toBe("unknown");
  });

  test("normalizes only schema defaults and object key order; preserves spans and attachments", async () => {
    const reordered = [{ text: content[0].text, type: "text" }];
    expect((await lookup([metadata, page([turn()])], { ...target, content: reordered })).delivery.state).toBe("found");
    const mixed = [...content, { type: "image", url: "fixture-image", detail: "original" }];
    const response = [metadata, page([turn([{ ...user, content: mixed }])])];
    expect((await lookup(response, { ...target, content: mixed })).delivery.state).toBe("found");
    expect((await lookup(response, { ...target, content: [...content, { type: "image", url: "fixture-image" }] })).delivery.state).toBe("unknown");
    expect((await lookup([metadata, page([turn()])], { ...target, content: [{ ...content[0], text_elements: [{ byteRange: { start: 0, end: 2 }, placeholder: "x" }] }] })).delivery.state).toBe("unknown");
  });

  test("omitted and null span placeholders match without changing frozen content or other fields", async () => {
    const span = { byteRange: { start: 0, end: 2 } };
    const withSpan = (element: Record<string, unknown>) => [
      { ...content[0], text_elements: [element] },
      { type: "image", url: "fixture-image", detail: "original" },
    ];
    for (const canonicalSpan of [span, { ...span, placeholder: null }]) {
      const responses = [metadata, page([turn([{ ...user, content: withSpan(canonicalSpan) }])])];
      const before = structuredClone(responses);
      for (const admittedSpan of [span, { ...span, placeholder: null }]) {
        const wanted = { ...target, content: withSpan(admittedSpan) };
        const frozen = structuredClone(wanted);
        expect((await lookup(responses, wanted)).delivery.state).toBe("found");
        expect(wanted).toEqual(frozen);
      }
      for (const changed of [
        { content: withSpan({ ...span, placeholder: "" }) },
        { content: withSpan({ ...span, placeholder: "marker" }) },
        { content: withSpan({ byteRange: { start: 2, end: 4 } }) },
        { content: withSpan({ byteRange: { start: 0, end: 4 } }) },
        { content: [{ ...withSpan(span)[0], text: "Інший текст" }, withSpan(span)[1]] },
        { content: [withSpan(span)[0], { type: "image", url: "other-image", detail: "original" }] },
        { clientId: "other-key", content: withSpan(span) },
        { turnId: "other-turn", content: withSpan(span) },
        { itemId: "other-item", content: withSpan(span) },
      ]) expect((await lookup(responses, { ...target, ...changed })).delivery.state).toBe("unknown");
      expect(responses).toEqual(before);
    }
    const named = withSpan({ ...span, placeholder: "marker" });
    const responses = [metadata, page([turn([{ ...user, content: named }])])];
    expect((await lookup(responses, { ...target, content: named })).delivery.state).toBe("found");
    expect((await lookup(responses, { ...target, content: withSpan({ ...span, placeholder: "changed" }) })).delivery.state).toBe("unknown");
    expect((await lookup(responses, { ...target, content: withSpan(span) })).delivery.state).toBe("unknown");
  });

  test("duplicate text under other keys is harmless, duplicate original keys are ambiguous", async () => {
    const other = { ...user, id: "item-b", clientId: "other-key" };
    expect((await lookup([metadata, page([turn([other, user])])])).delivery.state).toBe("found");
    expect((await lookup([metadata, page([turn([other])])])).delivery.state).toBe("unknown");
    expect((await lookup([metadata, page([turn([user, { ...user, id: "item-b" }])])])).delivery.state).toBe("unknown");
    expect((await lookup([metadata, page([turn(), turn([user], "full", "turn-b")])])).delivery.state).toBe("unknown");
  });

  test("wrong metadata path/thread, page thread and item turn remain unknown", async () => {
    for (const thread of [{ ...metadata.thread, id: "thread-b" }, { ...metadata.thread, path: "wrong" }, { ...metadata.thread, path: null }, { ...metadata.thread, ephemeral: true }]) {
      expect((await lookup([{ thread }, page([turn()])])).history).toEqual({ state: "unknown", reason: "identity" });
    }
    expect((await lookup([metadata, { ...page([turn()]), threadId: "thread-b" }])).history.state).toBe("unknown");
    expect((await lookup([metadata, page([turn([], "notLoaded")]), page([{ turnId: "turn-b", item: user }])])).history.state).toBe("unknown");
  });

  test("missing, malformed and error pages never establish absence or fallback", async () => {
    for (const bad of [undefined, null, {}, { data: [] }, { nextCursor: null }, { data: "bad", nextCursor: null }, { data: [], nextCursor: 1 }, { ...page([]), error: { code: -32601 } }, page([null]), page([{ ...turn(), items: null }]), page([{ ...turn(), itemsView: null }]), page([{ ...turn(), status: "unknown" }])]) {
      expect((await lookup([metadata, bad])).history.state).toBe("unknown");
    }
    expect((await lookup([metadata, page([turn([], "summary")]), { data: [] }])).history.state).toBe("unknown");
    expect((await lookup([metadata, page([turn()], "more"), new Error("connection lost")])).delivery.state).toBe("unknown");
  });

  test("malformed canonical content remains unknown", async () => {
    for (const malformed of [
      [{ type: "text", text: "text", text_elements: [42] }],
      [{ type: "text", text: "text", text_elements: [{ byteRange: { start: 3, end: 1 } }] }],
      [{ type: "image", url: "fixture", detail: "invalid" }],
      [{ type: "localImage", path: 3 }],
    ]) expect((await lookup([metadata, page([turn([{ ...user, content: malformed }])])])).history.state).toBe("unknown");
  });

  test("repeated cursors, duplicate records and empty continuation pages fail closed", async () => {
    for (const responses of [
      [metadata, page([turn()], "same"), page([turn([], "full", "turn-b")], "same")],
      [metadata, page([turn()], "next"), page([turn()])],
      [metadata, page([], "next")],
      [metadata, page([turn([user, user])])],
      [metadata, page([turn([], "summary")]), page([{ turnId: "turn-a", item: user }], "same"), page([{ turnId: "turn-a", item: { ...user, id: "item-b" } }], "same")],
    ]) expect((await lookup(responses)).history.state).toBe("unknown");
  });

  test("capability refusal alone permits legacy fallback", async () => {
    for (const error of [Object.assign(new Error("Method not found"), { code: -32601 }), new Error("Codex app-server request failed: list_turns is not supported yet")]) {
      expect((await lookup([metadata, error])).history).toEqual({ state: "legacy-fallback", reason: "unsupported" });
    }
    for (const error of [new Error("transport not supported"), new Error("Codex app-server request failed: permission denied"), new Error("Codex app-server request failed: thread not materialized yet before first user message"), new Error("thread/read timed out")]) {
      expect((await lookup([error])).history).toEqual({ state: "unknown", reason: "transport" });
    }
  });

  test("delayed materialization is polled by the caller without mutation or new identity", async () => {
    const early = await lookup([metadata, page([])]);
    const late = await lookup([metadata, page([turn()])]);
    expect(early.delivery.state).toBe("unknown");
    expect(late.delivery.state).toBe("found");
    expect([...early.calls, ...late.calls].every(c => c.method.endsWith("/list") || c.method === "thread/read")).toBe(true);
  });

  test("bounds aggregate bytes including large tool items and UTF-8", async () => {
    const tool = { type: "commandExecution", id: "tool-a", aggregatedOutput: "🌍".repeat(128 * 1024) };
    const responses = [metadata, page([turn([], "notLoaded")]), page([{ turnId: "turn-a", item: tool }, { turnId: "turn-a", item: user }])];
    expect((await lookup(responses, target, { maxBytes: 100_000 })).history).toEqual({ state: "unknown", reason: "bytes" });
    const exact = responses.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
    const result = await lookup(responses, target, { maxBytes: exact });
    expect(result.delivery.state).toBe("found");
    if (result.history.state === "complete") expect(result.history.bytes).toBe(exact);
    expect((await lookup(responses, target, { maxBytes: exact - 1 })).history.state).toBe("unknown");
  });

  test("bounds pages, enforces one deadline even if RPC never settles, ignores late results", async () => {
    expect((await lookup([metadata, page([turn()])], target, { maxPages: 1 })).history).toEqual({ state: "unknown", reason: "pages" });
    const calls: number[] = [];
    const rpc: CodexHistoryRpc = async (_method, _params, timeout) => {
      calls.push(timeout);
      await new Promise(resolve => setTimeout(resolve, 15));
      return calls.length === 1 ? metadata : page([turn()]);
    };
    const result = await readCodexHistory(rpc, identity, options({ deadlineAt: Date.now() + 22 }));
    expect(result).toEqual({ state: "unknown", reason: "deadline" });
    expect(calls[1]).toBeLessThan(calls[0]);
    expect(await readCodexHistory(() => new Promise(() => {}), identity, options({ deadlineAt: Date.now() + 10 }))).toEqual({ state: "unknown", reason: "deadline" });
  });
});

// Opt in with an explicit executable. CI without the CLI still runs every seam test.
const nativeCli = process.env.LLV_CODEX_HISTORY_CLI;
test.skipIf(!nativeCli)("real Codex 0.154: isolated Responses, multi-page history, original-key persistence across restart", async () => {
  const root = mkdtempSync("/tmp/chr-");
  const env: NodeJS.ProcessEnv & Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = join(root, key.toLowerCase()); mkdirSync(env[key], { mode: 0o700 });
  }
  const cwd = join(root, "workspace"); mkdirSync(cwd);
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const output = { id: `answer-${requests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fixture answer 🌍", annotations: [] }] };
      for (const event of [
        { type: "response.created", response: { id: `response-${requests}` } },
        { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } },
        { type: "response.output_item.done", output_index: 0, item: output },
        { type: "response.completed", response: { id: `response-${requests}`, status: "completed", output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(env.CODEX_HOME, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"
[model_providers.fixture]
name = "Credential-free local Responses"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  type Client = { rpc: CodexHistoryRpc; events: Record<string, unknown>[]; stop: () => Promise<void> };
  const clients: Client[] = [];
  function startClient(): Client {
    const child = spawn(nativeCli!, ["app-server", "--stdio"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    let serial = 0;
    const events: Record<string, unknown>[] = [];
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
    lines.on("line", line => {
      const row = JSON.parse(line);
      const waiter = pending.get(row.id);
      if (waiter) { pending.delete(row.id); if (row.error) waiter.reject(Object.assign(new Error(row.error.message), { code: row.error.code })); else waiter.resolve(row.result); }
      else events.push(row);
    });
    const rpc: CodexHistoryRpc = (method, params, timeoutMs) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture RPC timeout: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    const stop = async () => {
      child.stdin.end();
      if (child.exitCode === null) await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      lines.close();
    };
    const client = { rpc, events, stop };
    clients.push(client);
    return client;
  }
  const init = async (client: Client) => {
    const result = await client.rpc("initialize", { clientInfo: { name: "history_reader_fixture", version: "1" }, capabilities: { experimentalApi: true } }, 5000) as { userAgent: string };
    expect(result.userAgent).toContain("/0.154.0");
    expect(await client.rpc("account/read", { refreshToken: false }, 5000)).toMatchObject({ account: null });
  };
  try {
    expect(spawnSync(nativeCli!, ["--version"], { env, cwd, encoding: "utf8" }).stdout.trim()).toBe("codex-cli 0.154.0");
    let client = startClient(); await init(client);
    const started = await client.rpc("thread/start", { cwd, model: "fixture-model", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", historyMode: "paginated" }, 5000) as { thread: { id: string; path: string } };
    const nativeIdentity = { threadId: started.thread.id, path: started.thread.path };
    const targets: CodexHistoryDeliveryTarget[] = [];
    for (let i = 0; i < 3; i++) {
      const input = [{ type: "text", text: `Canonical fixture ${i} 🌍`, text_elements: [
        { byteRange: { start: 0, end: 9 }, ...(i === 0 ? {} : { placeholder: i === 1 ? null : "marker" }) },
      ] }];
      const result = await client.rpc("turn/start", { threadId: nativeIdentity.threadId, clientUserMessageId: `original-${i}`, input }, 5000) as { turn: { id: string } };
      targets.push({ clientId: `original-${i}`, content: input, turnId: result.turn.id });
      const deadline = Date.now() + 8000;
      while (!client.events.some(e => e.method === "turn/completed" && (e.params as { turn?: { id?: string } })?.turn?.id === result.turn.id)) {
        if (Date.now() > deadline) throw new Error("Fixture turn did not complete");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    expect(requests).toBe(3);
    const read = (view: "notLoaded" | "summary" | "full") => readCodexHistory(client.rpc, nativeIdentity, options({ deadlineAt: Date.now() + 8000, itemsView: view, turnsPerPage: 1, itemsPerPage: 1 }));
    const history = await read("notLoaded");
    expect(history.state).toBe("complete");
    if (history.state !== "complete") throw new Error(JSON.stringify(history));
    expect(history.turns).toHaveLength(3);
    expect(history.pages.filter(p => p.method === "thread/turns/list" && p.cursor !== null).length).toBeGreaterThanOrEqual(2);
    expect(history.pages.filter(p => p.method === "thread/items/list" && p.cursor !== null).length).toBeGreaterThanOrEqual(3);
    const firstUser = history.turns[0].items.find(item => item.clientId === targets[0].clientId);
    expect(firstUser?.content).toEqual([{ ...targets[0].content[0], text_elements: [
      { byteRange: { start: 0, end: 9 }, placeholder: null },
    ] }]);
    expect(targets[0].content[0].text_elements).toEqual([{ byteRange: { start: 0, end: 9 } }]);
    for (const wanted of targets) {
      expect(findCodexHistoryDelivery(history, wanted).state).toBe("found");
      for (const element of [
        { byteRange: { start: 0, end: 9 }, placeholder: "changed" },
        { byteRange: { start: 0, end: 8 }, placeholder: null },
      ]) expect(findCodexHistoryDelivery(history, {
        ...wanted, content: [{ ...wanted.content[0], text_elements: [element] }],
      })).toEqual({ state: "unknown", reason: "conflicting-record" });
    }
    const removed = { ...history, turns: history.turns.map(t => ({ ...t, items: t.items.filter(i => i.clientId !== targets[1].clientId) })) };
    expect(findCodexHistoryDelivery(removed, targets[1]).state).toBe("unknown");
    for (const view of ["summary", "full"] as const) {
      const alternate = await read(view);
      expect(alternate.state).toBe("complete");
      if (alternate.state === "complete") expect(alternate.turns).toEqual(history.turns);
    }
    // A fork exercises the native shared-history cutoff. This is synthetic
    // protocol data; it never launches a helper or contacts a model service.
    const fork = await client.rpc("thread/fork", { threadId: nativeIdentity.threadId, lastTurnId: targets[1].turnId, excludeTurns: true, cwd }, 5000) as { thread: { id: string; path: string } };
    const forkIdentity = { threadId: fork.thread.id, path: fork.thread.path };
    const forkHistory = await readCodexHistory(client.rpc, forkIdentity, options({ deadlineAt: Date.now() + 8000, turnsPerPage: 1, itemsPerPage: 1 }));
    expect(findCodexHistoryDelivery(forkHistory, targets[1]).state).toBe("found");
    expect(findCodexHistoryDelivery(forkHistory, targets[2]).state).toBe("unknown");
    await client.stop();
    const forkMeta = JSON.parse(readFileSync(forkIdentity.path, "utf8").split("\n")[0]);
    expect(forkMeta.payload.history_base.thread_id).toBe(nativeIdentity.threadId);
    // Reproduce the supported cold .jsonl.zst representation while retaining
    // the original fixture bytes beside it. Never alter an operator rollout.
    for (const path of [nativeIdentity.path, forkIdentity.path]) {
      const compressed = spawnSync("/usr/bin/zstd", ["-q", "-c", path], { env, cwd, maxBuffer: 8 * 1024 * 1024 });
      expect(compressed.status).toBe(0);
      writeFileSync(path + ".zst", compressed.stdout);
      const decoded = spawnSync("/usr/bin/zstd", ["-q", "-d", "-c", path + ".zst"], { env, cwd, maxBuffer: 8 * 1024 * 1024 });
      expect(decoded.stdout.equals(readFileSync(path))).toBe(true);
      renameSync(path, path + ".fixture-backup");
    }
    client = startClient(); await init(client);
    // Read persisted history cold. No resume/start/send occurs during reconciliation.
    const restarted = await read("notLoaded");
    expect(findCodexHistoryDelivery(restarted, targets[1]).state).toBe("found");
    expect(findCodexHistoryDelivery(restarted, { ...targets[1], clientId: "missing-original" }).state).toBe("unknown");
    const compressedFork = await readCodexHistory(client.rpc, forkIdentity, options({ deadlineAt: Date.now() + 8000, turnsPerPage: 1, itemsPerPage: 1 }));
    expect(findCodexHistoryDelivery(compressedFork, targets[1]).state).toBe("found");
    expect(findCodexHistoryDelivery(compressedFork, targets[2]).state).toBe("unknown");
    expect(requests).toBe(3);
    await client.stop();
    // Native pagination reads the persisted thread-history projection. Remove
    // the exact canonical row there, preserving the original fixture database.
    const dbPath = join(env.CODEX_HOME, "thread_history_1.sqlite");
    copyFileSync(dbPath, dbPath + ".negative-backup");
    const db = new Database(dbPath);
    const evidence = findCodexHistoryDelivery(history, targets[1]);
    if (evidence.state !== "found") throw new Error("Missing positive control");
    try {
      const deleted = db.query("DELETE FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?")
        .run(nativeIdentity.threadId, evidence.turnId, evidence.item.id);
      expect(deleted.changes).toBe(1);
    } finally { db.close(); }
    client = startClient(); await init(client);
    const missingCanonical = await read("notLoaded");
    expect(missingCanonical.state).toBe("complete");
    expect(findCodexHistoryDelivery(missingCanonical, targets[1]).state).toBe("unknown");
    expect(findCodexHistoryDelivery(missingCanonical, targets[0]).state).toBe("found");
    expect(requests).toBe(3);
  } finally {
    for (const client of clients) await client.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
