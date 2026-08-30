import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { testEndpoint } from "./testEndpoint";

const [role, hostModule, procModule, fenceFilename, sandbox] = process.argv.slice(2);
if (!role || !hostModule || !procModule || !fenceFilename || !sandbox) {
  throw new Error("legacy runtime host fence fixture arguments are required");
}

const releaseFilename = path.join(sandbox, "release");
const waitForRelease = async (): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(releaseFilename)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture release");
    await Bun.sleep(10);
  }
};

if (role === "owner") {
  fs.writeFileSync(fenceFilename, JSON.stringify({
    pid: process.pid,
    startIdentity: "legacy-owner-start",
  }), { mode: 0o600 });
  const listenerFilename = testEndpoint(sandbox, "listener-owner");
  const server = net.createServer((socket) => socket.end("owner"));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenerFilename, resolve);
    });
    fs.writeFileSync(path.join(sandbox, "owner-ready"), "");
    await waitForRelease();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
} else if (role === "contender") {
  const { procBackend } = await import(pathToFileURL(procModule).href);
  const { RuntimeHostFence } = await import(pathToFileURL(hostModule).href);
  procBackend.processIdentity = () => null;
  const fence = new RuntimeHostFence(fenceFilename);
  let server: net.Server | null = null;
  try {
    fence.acquire();
    const listenerFilename = testEndpoint(sandbox, "listener-contender");
    server = net.createServer((socket) => socket.end("contender"));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(listenerFilename, resolve);
    });
    fs.writeFileSync(path.join(sandbox, "contender-outcome"), "active");
    await waitForRelease();
  } catch (error) {
    fs.writeFileSync(
      path.join(sandbox, "contender-outcome"),
      `blocked:${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fence.release();
  }
} else {
  throw new Error("legacy runtime host fence fixture role is invalid");
}
