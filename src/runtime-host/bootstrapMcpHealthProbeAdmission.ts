import fs from "node:fs";
import path from "node:path";

import type { RuntimeSocketRequest, RuntimeSocketResponse } from "@/lib/runtime/contracts";

import { RuntimeHostFence } from "./runtimeHostFence";
import { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { serveRuntimeHost, type RuntimeHostSocketHandler } from "./socket";

function admissionHandler(admissions: McpHealthProbeAdmissions): RuntimeHostSocketHandler {
  return {
    async handle(request: RuntimeSocketRequest): Promise<RuntimeSocketResponse> {
      if (request.method === "snapshot") {
        return { id: request.id, ok: true, result: { deployments: [] } };
      }
      if (request.method !== "mcp-health-probe-admission") {
        return { id: request.id, ok: false, error: "runtime request method is unsupported" };
      }
      return {
        id: request.id,
        ok: true,
        result: admissions.consume(request.params?.capability),
      };
    },
  };
}

async function closeServer(server: ReturnType<typeof serveRuntimeHost>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

/**
 * Own one bootstrap probe admission at the canonical runtime-host seam.
 *
 * Bootstrap runs before the long-lived runtime host exists, so it temporarily
 * acquires the same singleton fence and serves capability redemption plus the
 * empty deployment snapshot needed by `deployment_status`. The capability is
 * minted in this process and never comes from adapter input.
 */
export async function withBootstrapMcpHealthProbeAdmission<T>(
  socketPath: string,
  operation: (capability: string) => Promise<T>,
): Promise<T> {
  if (!path.isAbsolute(socketPath)) throw new Error("runtime host socket must be absolute");
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  fence.acquire();
  const admissions = new McpHealthProbeAdmissions();
  let server: ReturnType<typeof serveRuntimeHost> | null = null;
  let socketIdentity: { dev: number; ino: number } | null = null;
  try {
    server = serveRuntimeHost(socketPath, admissionHandler(admissions));
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error("runtime host socket is invalid");
    socketIdentity = { dev: stat.dev, ino: stat.ino };
    const capability = admissions.issue();
    try {
      return await operation(capability);
    } finally {
      admissions.revoke(capability);
    }
  } finally {
    try {
      if (server) await closeServer(server);
    } finally {
      try {
        if (socketIdentity) fence.removeOwnedSocket(socketPath, socketIdentity);
      } finally {
        fence.release();
      }
    }
  }
}
