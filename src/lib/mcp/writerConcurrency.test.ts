import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

async function waitFor(pathname: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathname}`);
    await Bun.sleep(5);
  }
}

type WriterOperation = "create" | "update" | "transition";

async function runConcurrentWriters(
  kind: "task" | "pipeline",
  initialState: string,
  operation: WriterOperation = "create",
): Promise<{ enteredBeforeRelease: boolean; persisted: Record<string, unknown> }> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `llv-${kind}-writers-`));
  sandboxes.push(sandbox);
  const stateFile = path.join(sandbox, `${kind}s.json`);
  fs.writeFileSync(stateFile, initialState, "utf8");
  const fixture = path.join(import.meta.dir, "writerConcurrencyChild.ts");
  const writers = ["http", "mcp"].map((writer) => {
    const ready = path.join(sandbox, `${writer}.ready`);
    const release = path.join(sandbox, `${writer}.release`);
    const child = Bun.spawn({
      cmd: [process.execPath, fixture],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_STATE_DIR: sandbox,
        LLV_WRITER_KIND: kind,
        LLV_WRITER_INTERFACE: writer,
        LLV_WRITER_OPERATION: operation,
        LLV_WRITER_READY: ready,
        LLV_WRITER_RELEASE: release,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    return { child, ready, release };
  });

  await Promise.race([
    Promise.any(writers.map(({ ready }) => waitFor(ready))),
    Promise.all(writers.map(async ({ child }) => {
      await child.exited;
      throw new Error((await new Response(child.stderr).text()) || "writer exited before reaching the barrier");
    })),
  ]);
  const first = writers.find(({ ready }) => fs.existsSync(ready))!;
  const second = writers.find((candidate) => candidate !== first)!;
  await Bun.sleep(750);
  const enteredBeforeRelease = fs.existsSync(second.ready);
  fs.writeFileSync(first.release, "release\n", "utf8");
  await waitFor(second.ready);
  fs.writeFileSync(second.release, "release\n", "utf8");

  const exitCodes = await Promise.all(writers.map(({ child }) => child.exited));
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all(writers.map(({ child }) => new Response(child.stderr).text()));
    throw new Error(errors.filter(Boolean).join("\n"));
  }
  return {
    enteredBeforeRelease,
    persisted: JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>,
  };
}

test("Viewer HTTP and standalone MCP task creates preserve both writes across processes", async () => {
  const result = await runConcurrentWriters("task", "{\"tasks\":[]}\n");
  const persisted = result.persisted as { tasks: unknown[]; recentCreates: unknown[] };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.tasks).toHaveLength(2);
  expect(persisted.recentCreates).toHaveLength(2);
}, 15_000);

test("Viewer HTTP and standalone MCP pipeline creates preserve both writes across processes", async () => {
  const result = await runConcurrentWriters("pipeline", "{\"schemaVersion\":3,\"pipelines\":[]}\n");
  const persisted = result.persisted as { pipelines: unknown[] };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.pipelines).toHaveLength(2);
}, 15_000);

test("Viewer HTTP PATCH and standalone MCP update_task serialize across processes", async () => {
  const now = "2026-07-20T10:00:00.000Z";
  const task = (id: string) => ({
    id,
    project: "viewer",
    status: "inbox",
    text: `${id} original`,
    placement: "unplaced",
    assignments: [],
    createdAt: now,
    updatedAt: now,
  });
  const result = await runConcurrentWriters("task", JSON.stringify({
    tasks: [task("task-http"), task("task-mcp")],
  }), "update");
  const persisted = result.persisted as { tasks: Array<{ id: string; text: string }> };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.tasks.find(({ id }) => id === "task-http")?.text).toBe("http updated task");
  expect(persisted.tasks.find(({ id }) => id === "task-mcp")?.text).toBe("mcp updated task");
}, 15_000);

test("Viewer HTTP pipeline start and standalone MCP pipeline_action serialize across processes", async () => {
  const baseRef = "0".repeat(40);
  const pipeline = (id: string) => ({
    id,
    task: `${id} task`,
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    worktreeDir: path.join(path.dirname(process.cwd()), `${path.basename(process.cwd())}-pipeline-${id}`),
    branch: `pipeline/${id}-task-${id}`,
    baseBranch: "main",
    baseRef,
    lastPassedCommit: baseRef,
    stages: [{
      id: "implement",
      kind: "run",
      "prompt": "Implement the task",
      next: null,
      onFail: null,
      effectiveRole: {
        roleId: null,
        engine: "claude",
        model: null,
        effort: null,
        access: "read-write",
        promptScaffold: null,
      },
    }],
    runs: [{ stageId: "implement", attempts: [] }],
    cursor: { stageId: "implement", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-20T10:00:00.000Z",
    closedAt: null,
    hiddenAt: null,
  });
  const result = await runConcurrentWriters("pipeline", JSON.stringify({
    schemaVersion: 3,
    pipelines: [pipeline("pipeline-http"), pipeline("pipeline-mcp")],
  }), "transition");
  const persisted = result.persisted as { pipelines: Array<{ id: string; state: string }> };
  expect(result.enteredBeforeRelease).toBe(false);
  expect(persisted.pipelines.find(({ id }) => id === "pipeline-http")?.state).toBe("provisioning");
  expect(persisted.pipelines.find(({ id }) => id === "pipeline-mcp")?.state).toBe("provisioning");
}, 15_000);

test("an aged live writer without process identity retains the transaction until release", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-live-owner-writers-"));
  sandboxes.push(sandbox);
  const stateFile = path.join(sandbox, "tasks.json");
  const queuePath = `${stateFile}.write-locks`;
  const lockPath = `${stateFile}.write-lock`;
  const fixture = path.join(import.meta.dir, "writerConcurrencyChild.ts");
  fs.writeFileSync(stateFile, "{\"tasks\":[]}\n", "utf8");

  const spawnWriter = (writer: "http" | "mcp") => {
    const ready = path.join(sandbox, `${writer}.ready`);
    const release = path.join(sandbox, `${writer}.release`);
    const child = Bun.spawn({
      cmd: [process.execPath, fixture],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_STATE_DIR: sandbox,
        LLV_WRITER_KIND: "task",
        LLV_WRITER_INTERFACE: writer,
        LLV_WRITER_READY: ready,
        LLV_WRITER_RELEASE: release,
        LLV_WRITER_NO_PROCESS_IDENTITY: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    return { child, ready, release };
  };

  const first = spawnWriter("http");
  await waitFor(first.ready);
  const aged = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, aged, aged);
  for (const ticket of fs.readdirSync(queuePath)) fs.utimesSync(path.join(queuePath, ticket), aged, aged);

  const second = spawnWriter("mcp");
  await Bun.sleep(300);
  const enteredBeforeRelease = fs.existsSync(second.ready);
  fs.writeFileSync(first.release, "release\n", "utf8");
  if (!enteredBeforeRelease) await waitFor(second.ready);
  fs.writeFileSync(second.release, "release\n", "utf8");

  const exitCodes = await Promise.all([first.child.exited, second.child.exited]);
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all([new Response(first.child.stderr).text(), new Response(second.child.stderr).text()]);
    throw new Error(errors.filter(Boolean).join("\n"));
  }
  expect(enteredBeforeRelease).toBe(false);
  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { tasks: unknown[] };
  expect(persisted.tasks).toHaveLength(2);
}, 15_000);
