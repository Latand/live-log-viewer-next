import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withoutWakatimeCredential } from "./credential";
import { acquireWakatimeSchedulerLease } from "./lease";

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filename)) return;
    await Bun.sleep(5);
  }
  throw new Error("scheduler lease fixture did not become ready");
}

test("blue-green overlap keeps one scheduler owner through promotion and rollback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-lease-"));
  const filename = path.join(directory, "scheduler-owner.json");
  try {
    const previous = acquireWakatimeSchedulerLease(filename);
    expect(previous).not.toBeNull();
    expect(previous?.isHeld()).toBe(true);

    const promotedCandidate = acquireWakatimeSchedulerLease(filename);
    expect(promotedCandidate).toBeNull();
    expect(previous?.isHeld()).toBe(true);

    const rollbackCandidate = acquireWakatimeSchedulerLease(filename);
    expect(rollbackCandidate).toBeNull();
    expect(previous?.isHeld()).toBe(true);

    previous?.release();
    const successor = acquireWakatimeSchedulerLease(filename);
    expect(successor).not.toBeNull();
    expect(successor?.isHeld()).toBe(true);
    successor?.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reclaims an abandoned scheduler recovery claim", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-recovery-"));
  const filename = path.join(directory, "scheduler-owner.json");
  const recoveryDirectory = `${filename}.recovery`;
  try {
    fs.mkdirSync(recoveryDirectory, { mode: 0o700 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(recoveryDirectory, stale, stale);

    const lease = acquireWakatimeSchedulerLease(filename);

    expect(lease).not.toBeNull();
    expect(lease?.isHeld()).toBe(true);
    lease?.release();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("separate processes fence overlap and recover a crashed owner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-wakatime-process-lease-"));
  const filename = path.join(directory, "scheduler-owner.json");
  const readyPath = path.join(directory, "ready");
  const commandPath = path.join(directory, "command");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "leaseChild.ts")], {
    env: {
      ...withoutWakatimeCredential(process.env),
      LLV_WAKATIME_LEASE_TEST_PATH: filename,
      LLV_WAKATIME_LEASE_TEST_READY: readyPath,
      LLV_WAKATIME_LEASE_TEST_COMMAND: commandPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForFile(readyPath);
    const contender = acquireWakatimeSchedulerLease(filename);
    fs.writeFileSync(commandPath, "exit-without-release\n", { mode: 0o600 });
    const exitCode = await child.exited;
    const successor = acquireWakatimeSchedulerLease(filename);

    expect(contender).toBeNull();
    expect(exitCode).toBe(0);
    expect(successor).not.toBeNull();
    expect(successor?.isHeld()).toBe(true);
    successor?.release();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
