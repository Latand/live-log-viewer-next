import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

import type { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";

const MAX_REQUEST_BYTES = 16 * 1024;

export type McpHealthProbeAdmissionConsumer = Pick<McpHealthProbeAdmissions, "consume">;

interface BunFfiModule {
  FFIType: { i32: number };
  dlopen(path: string, symbols: Record<string, unknown>): {
    symbols: { dup: (fd: number) => number };
  };
}

let cachedDup: ((fd: number) => number) | null = null;

function duplicateDescriptor(fd: number): number {
  if (!cachedDup) {
    const runtimeRequire = createRequire(import.meta.url);
    const ffi = runtimeRequire(`bun:${"ffi"}`) as BunFfiModule;
    const library = ffi.dlopen(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      {
        dup: {
          args: [ffi.FFIType.i32],
          returns: ffi.FFIType.i32,
        },
      },
    );
    cachedDup = (sourceFd) => library.symbols.dup(sourceFd);
  }
  return cachedDup(fd);
}

export interface McpHealthProbeAdmissionChannel {
  childFd: number;
  channel: Duplex;
  closeChildFd(): void;
  close(): void;
}

/**
 * Create an unnamed, connected Unix channel for one managed MCP child.
 *
 * The temporary pathname exists only while the two endpoints connect. The
 * child receives a duplicated raw descriptor, so Bun owns no parent-side
 * stdio watcher whose descriptor can race with later process launches.
 */
export async function createMcpHealthProbeAdmissionChannel(): Promise<McpHealthProbeAdmissionChannel> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-health-channel-"));
  const socketPath = path.join(directory, "channel.sock");
  const server = net.createServer({ pauseOnConnect: true });
  let accepted: net.Socket | null = null;
  let client: net.Socket | null = null;
  let childFd: number | null = null;
  try {
    const acceptedPromise = new Promise<net.Socket>((resolve) => {
      server.once("connection", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    client = net.createConnection(socketPath);
    const [endpoint] = await Promise.all([
      acceptedPromise,
      new Promise<void>((resolve, reject) => {
        client!.once("connect", resolve);
        client!.once("error", reject);
      }),
    ]);
    accepted = endpoint;
    const handle = (client as net.Socket & { _handle?: { fd?: unknown } })._handle;
    if (!handle || !Number.isInteger(handle.fd) || Number(handle.fd) < 0) {
      throw new Error("MCP health admission channel descriptor is unavailable");
    }
    childFd = duplicateDescriptor(Number(handle.fd));
    if (childFd < 0) throw new Error("MCP health admission channel descriptor duplication failed");
    client.destroy();
    client = null;
    fs.unlinkSync(socketPath);
    server.close();
    fs.rmdirSync(directory);

    const closeChildFd = () => {
      if (childFd === null) return;
      const fd = childFd;
      childFd = null;
      try { fs.closeSync(fd); } catch { /* already closed */ }
    };
    const close = () => {
      closeChildFd();
      if (accepted && !accepted.destroyed) accepted.destroy();
    };
    return {
      childFd,
      channel: accepted,
      closeChildFd,
      close,
    };
  } catch (error) {
    if (childFd !== null) {
      try { fs.closeSync(childFd); } catch { /* already closed */ }
    }
    client?.destroy();
    accepted?.destroy();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function serveMcpHealthProbeAdmissionChannel(
  channel: Duplex,
  admissions: McpHealthProbeAdmissionConsumer,
): () => void {
  let buffer = "";
  let handled = false;
  const finish = (response: RuntimeSocketResponse) => {
    if (handled) return;
    handled = true;
    channel.end(JSON.stringify(response) + "\n");
  };
  channel.on("data", (chunk: Buffer | string) => {
    if (handled) return;
    buffer += String(chunk);
    if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
      finish({ id: "unknown", ok: false, error: "runtime request exceeds limit" });
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    try {
      const request = JSON.parse(buffer.slice(0, newline)) as RuntimeSocketRequest;
      if (!request.id || request.method !== "mcp-health-probe-admission") {
        finish({ id: request.id || "unknown", ok: false, error: "runtime request method is unsupported" });
        return;
      }
      finish({
        id: request.id,
        ok: true,
        result: admissions.consume(request.params?.capability),
      });
    } catch {
      finish({ id: "unknown", ok: false, error: "runtime request is malformed" });
    }
  });
  const close = () => {
    if (!channel.destroyed) channel.destroy();
  };
  channel.once("error", close);
  channel.resume();
  return close;
}
