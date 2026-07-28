import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { withBootstrapMcpHealthProbeAdmission } from "./bootstrapMcpHealthProbeAdmission";
import { RuntimeHostFence } from "./host";

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

test("bootstrap admission cannot replace the canonical runtime host owner", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-owner-"));
  const socketPath = path.join(sandbox, "runtime-host.sock");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fs.writeFileSync(socketPath, "owned-by-runtime-host");
  fence.acquire();
  let called = false;

  try {
    await expect(withBootstrapMcpHealthProbeAdmission(socketPath, async () => {
      called = true;
    })).rejects.toThrow("runtime host singleton fence is held");
    expect(called).toBe(false);
    expect(fs.readFileSync(socketPath, "utf8")).toBe("owned-by-runtime-host");
  } finally {
    fence.release();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("bootstrap cleanup preserves a successor canonical socket", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-socket-race-"));
  const socketPath = path.join(sandbox, "runtime-host.sock");
  const originalLstat = fs.lstatSync.bind(fs);
  const originalRename = fs.renameSync.bind(fs);
  const successor: { server: ReturnType<typeof Bun.listen> | null } = { server: null };
  let armed = false;
  let replaced = false;
  const installSuccessor = () => {
    if (replaced) return;
    replaced = true;
    fs.unlinkSync(socketPath);
    successor.server = Bun.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.end("successor");
        },
        data() {},
      },
    });
  };
  const lstat = spyOn(fs, "lstatSync").mockImplementation(((filename: fs.PathLike, options?: unknown) => {
    const identity = originalLstat(filename, options as never);
    if (armed && filename === socketPath) installSuccessor();
    return identity;
  }) as typeof fs.lstatSync);
  const rename = spyOn(fs, "renameSync").mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (armed && oldPath === socketPath) installSuccessor();
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync);
  let cleanupError: unknown;

  try {
    try {
      await withBootstrapMcpHealthProbeAdmission(socketPath, async () => {
        armed = true;
      });
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(Error);
    expect(String(cleanupError)).toContain("socket changed during bootstrap probe");
    expect(await readListener(socketPath)).toBe("successor");
  } finally {
    lstat.mockRestore();
    rename.mockRestore();
    successor.server?.stop(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("bootstrap operation failure releases its fence and socket", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-operation-failure-"));
  const socketPath = path.join(sandbox, "runtime-host.sock");
  try {
    await expect(withBootstrapMcpHealthProbeAdmission(socketPath, async () => {
      throw new Error("forced bootstrap operation failure");
    })).rejects.toThrow("forced bootstrap operation failure");
    expect(fs.existsSync(socketPath)).toBe(false);
    await expect(withBootstrapMcpHealthProbeAdmission(socketPath, async () => "recovered")).resolves.toBe("recovered");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("bootstrap listen failure releases its fence", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-bootstrap-listen-failure-"));
  const socketPath = path.join(sandbox, `${"s".repeat(120)}.sock`);
  let called = false;
  try {
    await expect(withBootstrapMcpHealthProbeAdmission(socketPath, async () => {
      called = true;
    })).rejects.toThrow();
    expect(called).toBe(false);
    const successor = new RuntimeHostFence(`${socketPath}.lock`);
    successor.acquire();
    successor.release();
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
