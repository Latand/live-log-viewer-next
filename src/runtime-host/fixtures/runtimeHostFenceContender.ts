import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [moduleFilename, fenceFilename, barrierDir, contender] = process.argv.slice(2);
if (!moduleFilename || !fenceFilename || !barrierDir || !contender) {
  throw new Error("runtime host fence contender arguments are required");
}

const waitFor = (filename: string): void => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filename)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};

const waitForAsync = async (filename: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(filename)}`);
    await Bun.sleep(10);
  }
};

const observedFilename = path.join(barrierDir, `observed-${contender}`);
const outcomeFilename = path.join(barrierDir, `outcome-${contender}`);
const listenerFilename = path.join(barrierDir, `listener-${contender}.sock`);
const releaseFilename = path.join(barrierDir, "release");
const { RuntimeHostFence } = await import(pathToFileURL(moduleFilename).href);
const fence = new RuntimeHostFence(fenceFilename, () => {
  fs.writeFileSync(observedFilename, "");
  if (contender === "A") waitFor(path.join(barrierDir, "observed-B"));
  else waitFor(path.join(barrierDir, "outcome-A"));
  return false;
});

let server: net.Server | null = null;
try {
  fence.acquire();
  server = net.createServer((socket) => socket.end(contender));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(listenerFilename, resolve);
  });
  fs.writeFileSync(outcomeFilename, "active");
  await waitForAsync(releaseFilename);
} catch (error) {
  fs.writeFileSync(outcomeFilename, `blocked:${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  fence.release();
}
