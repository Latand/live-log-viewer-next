/**
 * Board membership is a published, honoured field of the task surface (#1614).
 *
 * `board` governs whether an empty task draws a band. The dashboard writes it
 * through the HTTP PATCH, and `update_task` reached the same command through a
 * passthrough schema — so an agent could set it, but nothing in the tool's
 * published contract said the field existed, and nothing said what it meant.
 * A surface that quietly does the right thing with a field it does not admit
 * to is one refactor away from quietly ignoring it.
 *
 * So: the field is in the schema an agent reads, a value it sets survives to
 * the task file, an unsupported value is refused rather than dropped, and the
 * two surfaces that expose it agree.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { TaskWithRevision } from "@/lib/tasks/revision";

// Establish every state root before importing production bindings.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "task-board-visibility-"));
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
  const client = new Client({ name: "task-board-visibility-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); receipts.close(); } };
}

test("update_task publishes board membership, and every published value lands in the task file", async () => {
  const p = await protocol();
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await p.client.callTool({ name, arguments: { clientRequestId: `board-${++sequence}`, ...args } })).structuredContent as
      { ok: boolean; task: TaskWithRevision; details?: { field?: string } };
  try {
    /* Published: an agent reads the field and its two values from the tool. */
    const { tools } = await p.client.listTools();
    const board = (tools.find(tool => tool.name === "update_task")!.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>).board;
    expect(board).toBeDefined();
    expect(board.enum?.slice().sort()).toEqual(["hidden", "shown"]);
    expect(board.description ?? "").toContain("board");

    const created = await call("create_task", { project: "fixture-project", text: "band membership" });
    expect(created.ok).toBe(true);
    /* A task is on the board until something says otherwise. */
    expect(loadTasks().find(task => task.id === created.task.id)!.board).toBeUndefined();

    const hidden = await call("update_task", { taskId: created.task.id, board: "hidden" });
    expect(hidden).toMatchObject({ ok: true });
    expect(hidden.task.board).toBe("hidden");
    /* Durable, not just answered: the row on disk carries it, and the task is
       still a row — hiding a band never removes a task. */
    const stored = loadTasks().find(task => task.id === created.task.id)!;
    expect(stored.board).toBe("hidden");
    expect(stored.text).toBe("band membership");
    expect(loadTasks()).toHaveLength(1);
    expect((await call("get_task", { taskId: created.task.id })).task.board).toBe("hidden");

    /* Reversible from the same surface, in one write. */
    const shown = await call("update_task", { taskId: created.task.id, board: "shown" });
    expect(shown.task.board).toBe("shown");
    expect(loadTasks().find(task => task.id === created.task.id)!.board).toBe("shown");
  } finally { await p.close(); }
});

test("an unsupported board value is refused, never accepted and dropped", async () => {
  const p = await protocol();
  try {
    const created = (await p.client.callTool({ name: "create_task", arguments: {
      clientRequestId: "board-refusal-create", project: "fixture-project", text: "refusal",
    } })).structuredContent as { task: { id: string } };
    const before = fs.readFileSync(TASKS_FILE, "utf8");
    for (const value of ["archived", "", null, 1]) {
      const refused = (await p.client.callTool({ name: "update_task", arguments: {
        clientRequestId: `board-refusal-${String(value)}`, taskId: created.task.id, board: value,
      } })).structuredContent as { ok: boolean; details?: { field?: string } };
      expect(refused).toMatchObject({ ok: false, retryable: false });
      expect(refused.details?.field).toBe("board");
    }
    /* Nothing was written by any of them. */
    expect(fs.readFileSync(TASKS_FILE, "utf8")).toBe(before);
  } finally { await p.close(); }
});

test("the HTTP task PATCH and update_task write the same board flag", async () => {
  const { NextRequest } = await import("next/server");
  const { PATCH } = await import("@/app/api/tasks/[id]/route");
  const p = await protocol();
  try {
    const created = (await p.client.callTool({ name: "create_task", arguments: {
      clientRequestId: "board-parity-create", project: "fixture-project", text: "parity",
    } })).structuredContent as { task: { id: string } };

    /* «Remove from board» as the dashboard sends it. */
    const response = await PATCH(
      new NextRequest("http://localhost/api/tasks", { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ board: "hidden" }) }),
      { params: Promise.resolve({ id: created.task.id }) },
    );
    expect(response.status).toBe(200);
    expect(loadTasks().find(task => task.id === created.task.id)!.board).toBe("hidden");

    /* And an agent puts it back through its own surface. */
    const restored = (await p.client.callTool({ name: "update_task", arguments: {
      clientRequestId: "board-parity-restore", taskId: created.task.id, board: "shown",
    } })).structuredContent as { task: TaskWithRevision };
    expect(restored.task.board).toBe("shown");
    expect(loadTasks().find(task => task.id === created.task.id)!.board).toBe("shown");
  } finally { await p.close(); }
});
