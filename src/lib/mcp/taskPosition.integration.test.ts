import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskWithRevision } from "@/lib/tasks/revision";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-position-"));
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR"]) {
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:1";
process.env.LLV_RUNTIME_HOST_SOCKET = path.join(sandbox, "runtime.sock");
process.env.LLV_RUNTIME_HOST_CONTROL_SOCKET = path.join(sandbox, "absent.sock");
const { viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } = await import("./server");
const { TASKS_FILE, loadTasks } = await import("@/lib/tasks/store");
expect(TASKS_FILE.startsWith(sandbox + path.sep)).toBe(true);

async function protocol() {
  const receipts = new SqliteMcpReceiptStore(path.join(sandbox, "receipts.sqlite"));
  const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), receipts));
  const client = new Client({ name: "task-position-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

test("published positioning contract carries coordinates and current-row guards", async () => {
  const p = await protocol();
  try {
    const { tools } = await p.client.listTools();
    for (const name of ["create_task", "update_task"]) {
      expect(tools.find(t => t.name === name)!.inputSchema.properties).toHaveProperty("pos");
    }
    expect(tools.find(t => t.name === "update_task")!.inputSchema.properties).toHaveProperty("expectedRevision");
  } finally { await p.close(); }
});

test.each([["foreign", "other-project"], ["stale", "fixture-project"]])("%s placement refuses atomically through real protocol and persistence", async (key, expectedProject) => {
  const p = await protocol();
  try {
    const created = (await p.client.callTool({ name: "create_task", arguments: {
      clientRequestId: `create-fence-${key}`, project: "fixture-project", text: "original", placement: "pinned", pos: { x: -0.5, y: 0 },
    } })).structuredContent as { ok: boolean; task: { id: string; revision?: string } };
    expect(created.ok).toBe(true);
    expect(loadTasks().find(task => task.id === created.task.id)!.pos).toEqual({ x: -0.5, y: 0 });
    const expectedRevision = key === "foreign" ? created.task.revision ?? "missing-baseline-token" : "task-v1:stale";
      const before = fs.readFileSync(TASKS_FILE, "utf8");
      const result = (await p.client.callTool({ name: "update_task", arguments: {
        clientRequestId: key, taskId: created.task.id, expectedProject, expectedRevision,
        pos: { x: 50, y: 60 }, text: "must not land", dueAt: "2026-10-01T00:00:00Z", dueTz: "UTC",
      } })).structuredContent;
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(fs.readFileSync(TASKS_FILE, "utf8")).toBe(before);
  } finally { await p.close(); }
});


test("completed SQLite receipts replay original coordinates and revisions after restart and deletion", async () => {
  let p = await protocol();
  const createArgs = { clientRequestId: "replay-create", project: "fixture-project", text: "receipt", placement: "pinned", pos: { x: -2.25, y: 0 } };
  const created = (await p.client.callTool({ name: "create_task", arguments: createArgs })).structuredContent as { task: { id: string; revision: string; project: string } };
  const updateArgs = { clientRequestId: "replay-update", taskId: created.task.id, expectedProject: created.task.project, expectedRevision: created.task.revision, pos: { x: 3.5, y: -4 } };
  const updated = (await p.client.callTool({ name: "update_task", arguments: updateArgs })).structuredContent as { task: unknown };
  expect(updated).toMatchObject({ ok: true });
  const { mutateTasks } = await import("@/lib/tasks/store");
  mutateTasks(tasks => ({ tasks: tasks.filter(t => t.id !== created.task.id), result: undefined }));
  const before = fs.readFileSync(TASKS_FILE, "utf8");
  await p.close(); p = await protocol();
  try {
    const replayCreate = (await p.client.callTool({ name: "create_task", arguments: createArgs })).structuredContent;
    const replayUpdate = (await p.client.callTool({ name: "update_task", arguments: updateArgs })).structuredContent;
    expect(replayCreate).toMatchObject({ ok: true, replayed: true, task: created.task });
    expect(replayUpdate).toMatchObject({ ok: true, replayed: true, task: updated.task });
    for (const [name, args] of [["create_task", { ...createArgs, text: "changed" }], ["update_task", { ...updateArgs, pos: { x: 9, y: 9 } }]] as const) {
      expect((await p.client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, code: "idempotency_conflict", retryable: false });
    }
    expect(fs.readFileSync(TASKS_FILE, "utf8")).toBe(before);
  } finally { await p.close(); }
});

test("MCP placement semantics and independent HTTP handlers share durable coordinates and optional guards", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/tasks/route");
  const { PATCH } = await import("@/app/api/tasks/[id]/route");
  const p = await protocol();
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => (await p.client.callTool({ name, arguments: { clientRequestId: `semantics-${++sequence}`, ...args } })).structuredContent as { task: TaskWithRevision; tasks: TaskWithRevision[] };
  const request = (body: unknown) => new NextRequest("http://localhost/api/tasks", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });
  try {
    const unplaced = await call("create_task", { project: "fixture-project", text: "unplaced" });
    expect(unplaced.task.placement).toBe("unplaced");
    for (const args of [{ placement: "pinned" }, { placement: "unplaced", pos: { x: 0, y: 0 } }, { pos: { x: 0, y: 0 } }]) {
      const refused = await call("create_task", { project: "fixture-project", text: "invalid", ...args });
      expect(refused).toMatchObject({ ok: false, retryable: false, details: { field: "pos" } });
    }
    let task = unplaced.task;
    const guarded = (args: Record<string, unknown>) => call("update_task", { taskId: task.id, expectedProject: task.project, expectedRevision: task.revision, ...args });
    expect(await guarded({ placement: "pinned" })).toMatchObject({ ok: false, retryable: false, details: { field: "pos" } });
    task = (await guarded({ pos: { x: -1.25, y: 0 } })).task;
    expect(task.placement).toBe("pinned");
    task = (await guarded({ placement: "pinned" })).task;
    expect(task.pos).toEqual({ x: -1.25, y: 0 });
    const beforeContent = task;
    task = (await call("update_task", { taskId: task.id, text: "content only" })).task;
    expect(task.pos).toEqual(beforeContent.pos);
    expect(task.revision).not.toBe(beforeContent.revision);
    const read = await call("get_task", { taskId: task.id });
    expect(read.task.revision).toBe(task.revision);
    const listed = await call("list_tasks", { project: task.project });
    expect(listed.tasks.find((t: { id: string }) => t.id === task.id)!.revision).toBe(task.revision);
    expect(await call("update_task", { taskId: task.id, pos: { x: 1, y: 2 } })).toMatchObject({ ok: false, retryable: false, details: { field: "expectedProject" } });
    const oldToken = task.revision;
    const http = await PATCH(request({ pos: { x: 12.5, y: -7 } }), { params: Promise.resolve({ id: task.id }) });
    expect(http.status).toBe(200);
    const httpTask = (await http.json()).task;
    expect(httpTask.revision).not.toBe(oldToken);
    expect(await guarded({ pos: { x: 9, y: 9 } })).toMatchObject({ ok: false, code: "TASK_REVISION_MISMATCH", retryable: false });
    const bytes = fs.readFileSync(TASKS_FILE, "utf8");
    expect((await PATCH(request({ expectedProject: "foreign", expectedRevision: httpTask.revision, text: "wrong" }), { params: Promise.resolve({ id: task.id }) })).status).toBe(409);
    expect(fs.readFileSync(TASKS_FILE, "utf8")).toBe(bytes);
    task = httpTask;
    task = (await guarded({ placement: "unplaced", pos: { x: 8, y: 9 } })).task;
    expect(task.placement).toBe("unplaced"); expect(task.pos).toBeUndefined();
    const httpCreated = await POST(request({ project: "fixture-project", text: "http", placement: "pinned", pos: { x: -0.5, y: 1.25 } }));
    expect(httpCreated.status).toBe(200);
    const durable = (await httpCreated.json()).task;
    expect(loadTasks().find(t => t.id === durable.id)).toEqual(durable);
  } finally { await p.close(); }
});

test("two independent processes racing identical coordinates under one revision have exactly one winner", async () => {
  const p = await protocol();
  const created = (await p.client.callTool({ name: "create_task", arguments: { clientRequestId: "race-create", project: "fixture-project", text: "race", placement: "pinned", pos: { x: 1, y: 1 } } })).structuredContent as { task: { id: string; revision: string } };
  await p.close();
  const gate = path.join(sandbox, "race-go");
  const script = `
    import fs from "node:fs";
    import { viewerMcpBindings } from "./src/lib/mcp/bindings";
    import { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } from "./src/lib/mcp/server";
    import type { TaskWithRevision } from "@/lib/tasks/revision";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
    import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
    const args = JSON.parse(process.env.POSITION_RACE_ARGS!);
    const store = new SqliteMcpReceiptStore(process.env.POSITION_RACE_RECEIPTS!);
    const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(), store));
    const client = new Client({ name: "race", version: "1" });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    fs.writeFileSync(process.env.POSITION_RACE_READY!, "ready");
    while (!fs.existsSync(process.env.POSITION_RACE_GATE!)) await Bun.sleep(5);
    Date.now = () => 1788220800000;
    Date.prototype.toISOString = () => "2026-09-01T00:00:00.000Z";
    const result = await client.callTool({ name: "update_task", arguments: args });
    console.log(JSON.stringify(result.structuredContent));
    await client.close(); await server.close(); store.close();
  `;
  const children = [0, 1].map(index => {
    const ready = path.join(sandbox, `race-ready-${index}`);
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), env: { ...process.env,
      POSITION_RACE_ARGS: JSON.stringify({ clientRequestId: `race-${index}`, taskId: created.task.id, expectedProject: "fixture-project", expectedRevision: created.task.revision, pos: { x: 1, y: 1 } }),
      POSITION_RACE_RECEIPTS: path.join(sandbox, `race-${index}.sqlite`), POSITION_RACE_READY: ready, POSITION_RACE_GATE: gate,
    }, stdout: "pipe", stderr: "pipe" });
    return { child, ready };
  });
  const deadline = Date.now() + 15000;
  while (!children.every(c => fs.existsSync(c.ready)) && Date.now() < deadline) await Bun.sleep(10);
  fs.writeFileSync(gate, "go");
  const results = await Promise.all(children.map(async ({ child }) => {
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect([await child.exited, error]).toEqual([0, ""]);
    return JSON.parse(output);
  }));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toMatchObject({ code: "TASK_REVISION_MISMATCH", retryable: false });
}, 20000);


test("canonical readback includes the persisted generation and placement preserves all unrelated fields", async () => {
  const { saveTasks } = await import("@/lib/tasks/store");
  const p = await protocol();
  try {
    const create = (await p.client.callTool({ name: "create_task", arguments: { clientRequestId: "preserve-create", project: "fixture-project", text: "preserve", placement: "pinned", pos: { x: 0, y: 0 } } })).structuredContent as { task: { id: string; revision: string } };
    expect(typeof create.task.revision).toBe("string");
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === create.task.id)!;
    Object.assign(task, { dueAt: "2026-10-01T00:00:00.000Z", dueTz: "UTC", extension: { keep: true },
      assignments: [{ path: "fixture.jsonl", panePid: null, state: "delivered", error: null, at: "2026-09-01T00:00:00Z" }],
      source: { path: "fixture.jsonl", ts: null, text: "source", fingerprint: "fixture", engine: "codex" },
      attachments: [{ id: crypto.randomUUID(), sha256: "a".repeat(64), ext: "png", mime: "image/png", bytes: 1, createdAt: "2026-09-01T00:00:00.000Z" }],
    });
    saveTasks(tasks);
    const before = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")).tasks;
    const current = before.find((t: { id: string }) => t.id === task.id);
    const result = (await p.client.callTool({ name: "update_task", arguments: { clientRequestId: "preserve-move", taskId: task.id, expectedProject: task.project, expectedRevision: current.revision, pos: { x: -5.25, y: 0 } } })).structuredContent as { task: Record<string, unknown> };
    expect(result).toMatchObject({ ok: true });
    const after = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")).tasks;
    expect(after.find((t: { id: string }) => t.id === task.id)).toEqual(result.task);
    expect(after.filter((t: { id: string }) => t.id !== task.id)).toEqual(before.filter((t: { id: string }) => t.id !== task.id));
    const { pos: _pos, revision: _revision, updatedAt: _updatedAt, ...preserved } = result.task;
    const { pos: _oldPos, revision: _oldRevision, updatedAt: _oldUpdatedAt, ...expected } = current;
    expect(preserved).toEqual(expected);
  } finally { await p.close(); }
});
