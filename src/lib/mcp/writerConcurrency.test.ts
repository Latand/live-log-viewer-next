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

async function runConcurrentWriters(kind: "task" | "pipeline", initialState: string): Promise<Record<string, unknown>> {
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
  fs.writeFileSync(first.release, "release\n", "utf8");
  await waitFor(second.ready);
  fs.writeFileSync(second.release, "release\n", "utf8");

  const exitCodes = await Promise.all(writers.map(({ child }) => child.exited));
  if (exitCodes.some((code) => code !== 0)) {
    const errors = await Promise.all(writers.map(({ child }) => new Response(child.stderr).text()));
    throw new Error(errors.filter(Boolean).join("\n"));
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
}

test("Viewer HTTP and standalone MCP task creates preserve both writes across processes", async () => {
  const persisted = await runConcurrentWriters("task", "{\"tasks\":[]}\n") as { tasks: unknown[]; recentCreates: unknown[] };
  expect(persisted.tasks).toHaveLength(2);
  expect(persisted.recentCreates).toHaveLength(2);
}, 15_000);

test("Viewer HTTP and standalone MCP pipeline creates preserve both writes across processes", async () => {
  const persisted = await runConcurrentWriters("pipeline", "{\"schemaVersion\":3,\"pipelines\":[]}\n") as { pipelines: unknown[] };
  expect(persisted.pipelines).toHaveLength(2);
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
