import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { RuntimeHostFence } from "./runtimeHostFence";

const fixture = path.join(import.meta.dir, "fixtures", "runtimeHostFenceContender.ts");
const hostModule = path.join(import.meta.dir, "runtimeHostFence.ts");

async function waitForFiles(filenames: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!filenames.every((filename) => fs.existsSync(filename))) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime host fence contenders");
    await Bun.sleep(10);
  }
}

async function readListener(socketPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

test("stale fence reclamation activates exactly one process after both observe the stale owner", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-race-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  fs.writeFileSync(fenceFilename, JSON.stringify({ pid: 42, startIdentity: "stale" }), { mode: 0o600 });
  const contenders = ["A", "B"].map((contender) => Bun.spawn(
    [process.execPath, fixture, hostModule, fenceFilename, sandbox, contender],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  ));
  const outcomeFilenames = ["A", "B"].map((contender) => path.join(sandbox, `outcome-${contender}`));

  try {
    await waitForFiles(outcomeFilenames);
    const outcomes = outcomeFilenames.map((filename) => fs.readFileSync(filename, "utf8"));
    expect(outcomes.filter((outcome) => outcome === "active")).toHaveLength(1);
    const active = outcomes[0] === "active" ? "A" : "B";
    expect(await readListener(path.join(sandbox, `listener-${active}.sock`))).toBe(active);
  } finally {
    fs.writeFileSync(path.join(sandbox, "release"), "");
    await Promise.all(contenders.map((contender) => contender.exited));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("predecessor release preserves a successor fence generation", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-release-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  const predecessor = new RuntimeHostFence(fenceFilename);
  predecessor.acquire();
  fs.rmSync(fenceFilename);
  const successor = JSON.stringify({ pid: 73, startIdentity: "successor", acquisitionId: "successor-generation" });
  fs.writeFileSync(fenceFilename, successor, { mode: 0o600 });

  try {
    predecessor.release();
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe(successor);
  } finally {
    predecessor.release();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("legacy live-owner metadata remains a rolling-upgrade fence", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-legacy-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  const metadata = JSON.stringify({ pid: 42, startIdentity: "live-predecessor" });
  fs.writeFileSync(fenceFilename, metadata, { mode: 0o600 });

  try {
    expect(() => new RuntimeHostFence(fenceFilename, () => true).acquire()).toThrow("singleton fence is held");
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe(metadata);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("malformed existing fence metadata fails closed", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-fence-malformed-"));
  const fenceFilename = path.join(sandbox, "runtime-host.lock");
  fs.writeFileSync(fenceFilename, "{broken", { mode: 0o600 });

  try {
    expect(() => new RuntimeHostFence(fenceFilename, () => false).acquire()).toThrow("singleton fence is held");
    expect(fs.readFileSync(fenceFilename, "utf8")).toBe("{broken");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
