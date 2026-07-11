import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-manager-process-"));
const previousState = process.env.LLV_STATE_DIR;
const previousCodexHome = process.env.LLV_CODEX_HOME;
const previousClaudeHome = process.env.LLV_CLAUDE_HOME;
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.LLV_CODEX_HOME = path.join(sandbox, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "legacy-claude");

const { activeCodexAccountId, createManagedCodexAccount } = await import("./codex");
const { activeClaudeAccountId, createManagedClaudeAccount, listClaudeAccounts } = await import("./claude");
const { AgentRegistry } = await import("@/lib/agent/registry");

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  fs.rmSync(path.join(sandbox, "accounts"), { recursive: true, force: true });
});

afterAll(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCodexHome === undefined) delete process.env.LLV_CODEX_HOME;
  else process.env.LLV_CODEX_HOME = previousCodexHome;
  if (previousClaudeHome === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaudeHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function childResult(child: { exited: Promise<number>; stderr: ReadableStream<Uint8Array> }): Promise<{ exit: number; error: string }> {
  const exit = await child.exited;
  return { exit, error: await new Response(child.stderr).text() };
}

async function selectionRemovalRace(engine: "claude" | "codex"): Promise<void> {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  const account = engine === "codex" ? createManagedCodexAccount("Removal target") : createManagedClaudeAccount("Removal target");
  fs.writeFileSync(path.join(account.home, engine === "codex" ? "auth.json" : ".credentials.json"), "{}", { mode: 0o600 });
  const registry = new AgentRegistry();
  registry.setEngineRouting(engine, "default");

  const caseDir = path.join(sandbox, `remove-${engine}`);
  fs.rmSync(caseDir, { recursive: true, force: true });
  fs.mkdirSync(caseDir, { recursive: true });
  const readyPath = path.join(caseDir, "selector-ready");
  const releasePath = path.join(caseDir, "selector-release");
  const removedPath = path.join(caseDir, "removal-finished");
  const managerPath = path.join(import.meta.dir, "manager.ts");
  const registryPath = path.join(import.meta.dir, "../agent/registry.ts");
  const routePath = path.join(import.meta.dir, `../../app/api/accounts/${engine}/route.ts`);
  const env = {
    ...process.env,
    LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
    LLV_CODEX_HOME: process.env.LLV_CODEX_HOME!,
    LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME!,
  };

  const selector = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const manager = await import(${JSON.stringify(managerPath)});
      const { AgentRegistry } = await import(${JSON.stringify(registryPath)});
      const registry = new AgentRegistry();
      const routing = {
        engineRouting(engine) { return registry.engineRouting(engine); },
        setEngineRouting(engine, accountId) {
          fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
          while (!fs.existsSync(${JSON.stringify(releasePath)})) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          return registry.setEngineRouting(engine, accountId);
        },
      };
      manager.selectAccount(${JSON.stringify(engine)}, ${JSON.stringify(account.id)}, routing);
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await waitForFile(readyPath, 3_000)).toBeTrue();

  const remover = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const { NextRequest } = await import("next/server");
      const route = await import(${JSON.stringify(routePath)});
      const response = await route.DELETE(new NextRequest("http://127.0.0.1/api/accounts/${engine}", {
        method: "DELETE",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ id: ${JSON.stringify(account.id)}, force: true }),
      }));
      fs.writeFileSync(${JSON.stringify(removedPath)}, JSON.stringify({ status: response.status, body: await response.json() }));
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitForFile(removedPath, 500);
  fs.writeFileSync(releasePath, "release");

  const [selectorResult, removerResult] = await Promise.all([childResult(selector), childResult(remover)]);
  expect({ selectorResult, removerResult }).toEqual({
    selectorResult: { exit: 0, error: "" },
    removerResult: { exit: 0, error: "" },
  });
  expect(JSON.parse(fs.readFileSync(removedPath, "utf8"))).toMatchObject({ status: 200 });
  expect(registry.engineRouting(engine).activeAccountId).toBe("default");
  if (engine === "codex") expect(activeCodexAccountId()).toBe("default");
  else {
    expect(activeClaudeAccountId()).toBe("default");
    expect(listClaudeAccounts().some((candidate) => candidate.id === account.id)).toBeFalse();
  }
}

test("Codex removal serializes with selection across processes", async () => {
  await selectionRemovalRace("codex");
});

test("Claude removal serializes with selection across processes", async () => {
  await selectionRemovalRace("claude");
});

test("simultaneous stale-lock recovery admits one account mutation at a time", async () => {
  const accountB = createManagedCodexAccount("Recovery B");
  const accountC = createManagedCodexAccount("Recovery C");
  for (const account of [accountB, accountC]) fs.writeFileSync(path.join(account.home, "auth.json"), "{}", { mode: 0o600 });
  const caseDir = path.join(sandbox, "stale-recovery");
  fs.rmSync(caseDir, { recursive: true, force: true });
  fs.mkdirSync(caseDir, { recursive: true });
  const bDecidedPath = path.join(caseDir, "b-decided");
  const allowBRemovalPath = path.join(caseDir, "allow-b-removal");
  const aLivePath = path.join(caseDir, "a-live");
  const criticalPath = path.join(caseDir, "critical");
  const overlapPath = path.join(caseDir, "overlap");
  const routingPath = path.join(caseDir, "routing.json");
  fs.writeFileSync(routingPath, JSON.stringify({ activeAccountId: "default", revision: 0 }));
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  const lockPath = path.join(process.env.LLV_STATE_DIR!, "account-selection.lock");
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999_999_999,
    startIdentity: "dead",
    token: "stale",
  }));
  const managerPath = path.join(import.meta.dir, "manager.ts");
  const env = {
    ...process.env,
    LLV_STATE_DIR: process.env.LLV_STATE_DIR!,
    LLV_CODEX_HOME: process.env.LLV_CODEX_HOME!,
  };
  const source = (accountId: string, role: "a" | "b") => `
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    if (${JSON.stringify(role)} === "b") {
      const originalRemove = fs.rmSync.bind(fs);
      let intercepted = false;
      fs.rmSync = (target, options) => {
        if (!intercepted && target === ${JSON.stringify(lockPath)}) {
          intercepted = true;
          fs.writeFileSync(${JSON.stringify(bDecidedPath)}, "decided");
          while (!fs.existsSync(${JSON.stringify(allowBRemovalPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        return originalRemove(target, options);
      };
    }
    const manager = await import(${JSON.stringify(managerPath)});
    const routing = {
      engineRouting() { return JSON.parse(fs.readFileSync(${JSON.stringify(routingPath)}, "utf8")); },
      setEngineRouting(_engine, selectedId) {
        let descriptor = null;
        try { descriptor = fs.openSync(${JSON.stringify(criticalPath)}, "wx"); }
        catch { fs.writeFileSync(${JSON.stringify(overlapPath)}, "overlap"); }
        if (${JSON.stringify(role)} === "a") fs.writeFileSync(${JSON.stringify(aLivePath)}, "live");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${role === "a" ? 200 : 50});
        const current = JSON.parse(fs.readFileSync(${JSON.stringify(routingPath)}, "utf8"));
        fs.writeFileSync(${JSON.stringify(routingPath)}, JSON.stringify({ activeAccountId: selectedId, revision: current.revision + 1 }));
        if (descriptor !== null) { fs.closeSync(descriptor); fs.rmSync(${JSON.stringify(criticalPath)}, { force: true }); }
        return current.revision + 1;
      },
    };
    manager.selectAccount("codex", ${JSON.stringify(accountId)}, routing);
  `;
  const spawn = (accountId: string, role: "a" | "b") => Bun.spawn({
    cmd: [process.execPath, "-e", source(accountId, role)],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });

  const contenderB = spawn(accountB.id, "b");
  expect(await waitForFile(bDecidedPath, 3_000)).toBeTrue();
  const contenderA = spawn(accountC.id, "a");
  await waitForFile(aLivePath, 300);
  fs.writeFileSync(allowBRemovalPath, "remove");

  const results = await Promise.all([childResult(contenderA), childResult(contenderB)]);
  expect(results).toEqual([{ exit: 0, error: "" }, { exit: 0, error: "" }]);
  expect(fs.existsSync(overlapPath)).toBeFalse();
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
