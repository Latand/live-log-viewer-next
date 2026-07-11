import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-mutation-"));

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("same-process contenders leave an async transaction holder runnable", async () => {
  const state = path.join(sandbox, "state");
  const result = path.join(sandbox, "result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fs = await import("node:fs");
      const { withAccountMutationLock, withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      let releaseHolder;
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const holder = withAccountMutationLockAsync(async () => {
        markStarted();
        await new Promise((resolve) => { releaseHolder = resolve; });
      });
      await started;

      const syncStartedAt = Date.now();
      let syncFailed = false;
      try { withAccountMutationLock(() => undefined); }
      catch { syncFailed = true; }
      const syncElapsedMs = Date.now() - syncStartedAt;

      let timerFired = false;
      setTimeout(() => { timerFired = true; releaseHolder(); }, 25);
      let waiterRan = false;
      const waiter = withAccountMutationLockAsync(async () => { waiterRan = true; });
      await Promise.all([holder, waiter]);
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ syncFailed, syncElapsedMs, timerFired, waiterRan }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const completed = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!completed) child.kill();
  const error = await new Response(child.stderr).text();

  expect({ completed, error }).toEqual({ completed: true, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({
    syncFailed: true,
    syncElapsedMs: expect.any(Number),
    timerFired: true,
    waiterRan: true,
  });
  expect((JSON.parse(fs.readFileSync(result, "utf8")) as { syncElapsedMs: number }).syncElapsedMs).toBeLessThan(100);
});

test("revision admission failure prevents the durable mutation callback", async () => {
  const state = path.join(sandbox, "revision-state");
  const result = path.join(sandbox, "revision-result.json");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      process.env.LLV_STATE_DIR = ${JSON.stringify(state)};
      const fsModule = await import("node:fs");
      const fs = fsModule.default;
      const originalRename = fs.renameSync.bind(fs);
      fs.renameSync = (source, target) => {
        if (String(target).endsWith("account-mutation-revision.json")) throw new Error("revision unavailable");
        return originalRename(source, target);
      };
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      let callbackRan = false;
      let failed = false;
      try { withAccountMutationLock(() => { callbackRan = true; }); }
      catch { failed = true; }
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ callbackRan, failed }));
    `],
    stdout: "ignore",
    stderr: "pipe",
  });

  const exit = await child.exited;
  const error = await new Response(child.stderr).text();
  expect({ exit, error }).toEqual({ exit: 0, error: "" });
  expect(JSON.parse(fs.readFileSync(result, "utf8"))).toEqual({ callbackRan: false, failed: true });
});

test("a sync contender fails quickly while another process owns the file lock", async () => {
  const state = path.join(sandbox, "cross-process-state");
  const modulePath = path.join(import.meta.dir, "accountMutation.ts");
  const ready = path.join(sandbox, "cross-process-ready");
  const release = path.join(sandbox, "cross-process-release");
  const env = { ...process.env, LLV_STATE_DIR: state };
  const holder = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const fs = await import("node:fs");
      const { withAccountMutationLockAsync } = await import(${JSON.stringify(modulePath)});
      await withAccountMutationLockAsync(async () => {
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
      });
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1) await Bun.sleep(10);
  expect(fs.existsSync(ready)).toBeTrue();

  const contender = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const { withAccountMutationLock } = await import(${JSON.stringify(modulePath)});
      try { withAccountMutationLock(() => undefined); process.exit(2); }
      catch { process.exit(0); }
    `],
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  const completed = await Promise.race([contender.exited.then(() => true), Bun.sleep(500).then(() => false)]);
  if (!completed) contender.kill();
  fs.writeFileSync(release, "release");
  const [holderExit, contenderError, holderError] = await Promise.all([
    holder.exited,
    new Response(contender.stderr).text(),
    new Response(holder.stderr).text(),
  ]);

  expect({ completed, holderExit, contenderError, holderError }).toEqual({
    completed: true,
    holderExit: 0,
    contenderError: "",
    holderError: "",
  });
});
