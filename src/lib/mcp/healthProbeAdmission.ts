import crypto from "node:crypto";
import {
  fstatSync,
  readSync,
  writeSync,
} from "node:fs";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

export const MCP_HEALTH_PROBE_CAPABILITY_ENV = "LLV_MCP_HEALTH_PROBE_CAPABILITY";
export const MCP_HEALTH_PROBE_ADMISSION_FD = 3;

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 16 * 1024;
const ADMISSION_TIMEOUT_MS = 3_000;
const IO_RETRY_MS = 5;
type HealthAdmissionClient = { admitMcpHealthProbe(capability: string): Promise<boolean> };

function retryableIoError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
}

async function waitForIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, IO_RETRY_MS));
}

async function writeFrame(fd: number, frame: Buffer, deadline: number): Promise<boolean> {
  let offset = 0;
  while (offset < frame.length && Date.now() < deadline) {
    try {
      const bytesWritten = writeSync(fd, frame, offset, frame.length - offset);
      if (bytesWritten === 0) await waitForIo();
      else offset += bytesWritten;
    } catch (error) {
      if (!retryableIoError(error)) return false;
      await waitForIo();
    }
  }
  return offset === frame.length;
}

async function readFrame(fd: number, deadline: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (Date.now() < deadline) {
    const chunk = Buffer.allocUnsafe(4 * 1024);
    try {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) return null;
      const received = chunk.subarray(0, bytesRead);
      const newline = received.indexOf(0x0a);
      const accepted = newline < 0 ? received : received.subarray(0, newline);
      chunks.push(accepted);
      size += accepted.length;
      if (size > MAX_RESPONSE_BYTES) return null;
      if (newline >= 0) return Buffer.concat(chunks, size).toString("utf8");
    } catch (error) {
      if (!retryableIoError(error)) return null;
      await waitForIo();
    }
  }
  return null;
}

function inheritedHealthAdmissionClient(): HealthAdmissionClient {
  return {
    async admitMcpHealthProbe(capability) {
      const fd = MCP_HEALTH_PROBE_ADMISSION_FD;
      try {
        const type = fstatSync(fd);
        if (!type.isSocket()) return false;
        const request: RuntimeSocketRequest = {
          id: crypto.randomUUID(),
          method: "mcp-health-probe-admission",
          params: { capability },
        };
        const deadline = Date.now() + ADMISSION_TIMEOUT_MS;
        const sent = await writeFrame(fd, Buffer.from(JSON.stringify(request) + "\n"), deadline);
        if (!sent) return false;
        const frame = await readFrame(fd, deadline);
        if (frame === null) return false;
        const response = JSON.parse(frame) as RuntimeSocketResponse;
        return response.id === request.id && response.ok === true && response.result === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Redeem a runtime-host-minted health capability over descriptor 3 inherited
 * from the host-owned probe chain. Environment values carry the capability
 * and cannot select the issuer.
 */
export async function admittedMcpHealthProbe(
  capability: unknown,
  client?: HealthAdmissionClient | null,
): Promise<boolean> {
  if (typeof capability !== "string" || !CAPABILITY_PATTERN.test(capability)) return false;
  const host = client === undefined ? inheritedHealthAdmissionClient() : client;
  if (!host?.admitMcpHealthProbe) return false;
  try {
    return await host.admitMcpHealthProbe(capability);
  } catch {
    return false;
  }
}
