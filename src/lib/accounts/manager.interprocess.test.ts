import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-manager-process-"));
const previousState = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "legacy-codex");

const { activeCodexAccountId, createManagedCodexAccount } = await import("./codex");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
});

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function waitForFile(filename: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) return true;
    await Bun.sleep(10);
  }
  return fs.existsSync(filename);
}

test("overlapping selections keep catalog and launch routing aligned across processes", async () => {
  const accountB = createManagedCodexAccount("Process B");
  const accountC = createManagedCodexAccount("Process C");
  fs.writeFileSync(path.join(accountB.home, "auth.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(accountC.home, "auth.json"), "{}", { mode: 0o600 });

  const routingPath = path.join(sandbox, "routing.json");
  const readyPath = path.join(sandbox, "b-ready");
  const releasePath = path.join(sandbox, "b-release");
  const cRoutedPath = path.join(sandbox, "c-routed");
  fs.writeFileSync(routingPath, JSON.stringify({ activeAccountId: "default", revision: 0 }));
  const managerPath = path.join(import.meta.dir, "manager.ts");
  const env = {
    ...process.env,
    LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
    LLV_CODEX_HOME: process.env.LLV_CODEX_HOME!,
  };

  const source = (id: string, pause: boolean) => `
    const fs = await import("node:fs");
    const manager = await import(${JSON.stringify(managerPath)});
    const routingPath = ${JSON.stringify(routingPath)};
    const routing = {
      engineRouting() { return JSON.parse(fs.readFileSync(routingPath, "utf8")); },
      setEngineRouting(_engine, accountId) {
        if (${JSON.stringify(pause)}) {
          fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
          while (!fs.existsSync(${JSON.stringify(releasePath)})) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        const current = JSON.parse(fs.readFileSync(routingPath, "utf8"));
        fs.writeFileSync(routingPath, JSON.stringify({ activeAccountId: accountId, revision: current.revision + 1 }));
        if (!${JSON.stringify(pause)}) fs.writeFileSync(${JSON.stringify(cRoutedPath)}, "routed");
        return current.revision + 1;
      },
    };
    manager.selectAccount("codex", ${JSON.stringify(id)}, routing);
  `;
  const spawn = (id: string, pause: boolean) => Bun.spawn({
    cmd: [process.execPath, "-e", source(id, pause)],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });

  const processB = spawn(accountB.id, true);
  expect(await waitForFile(readyPath, 3_000)).toBeTrue();
  const processC = spawn(accountC.id, false);
  await waitForFile(cRoutedPath, 500);
  fs.writeFileSync(releasePath, "release");

  const [exitB, exitC] = await Promise.all([processB.exited, processC.exited]);
  const errors = [await new Response(processB.stderr).text(), await new Response(processC.stderr).text()];
  expect({ exitB, exitC, errors }).toEqual({ exitB: 0, exitC: 0, errors: ["", ""] });
  expect(activeCodexAccountId()).toBe(accountC.id);
  expect(JSON.parse(fs.readFileSync(routingPath, "utf8")).activeAccountId).toBe(accountC.id);
});
