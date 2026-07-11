import { createHash } from "node:crypto";
import net from "node:net";

export interface CandidatePortSelectionOptions {
  base: number;
  slots: number;
  isAvailable?(port: number): Promise<boolean>;
}

export interface BuiltCandidatePortAllocationOptions {
  base: number;
  slots: number;
  reservedPorts(): Promise<ReadonlySet<number>>;
  isAvailable(port: number): Promise<boolean>;
  removeImage(): Promise<void>;
  removeComposeSnapshot(): void | Promise<void>;
}

export function candidatePortsFromEnvironmentLists(environments: string[][]): Set<number> {
  const ports = new Set<number>();
  for (const environment of environments) {
    for (const entry of environment) {
      if (!entry.startsWith("PORT=")) continue;
      const port = Number(entry.slice("PORT=".length));
      if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
    }
  }
  return ports;
}

export function isCandidatePortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

export async function selectCandidatePort(deploymentId: string, options: CandidatePortSelectionOptions): Promise<number> {
  if (!Number.isInteger(options.base) || options.base < 1) throw new Error("candidate Viewer port base is invalid");
  if (!Number.isInteger(options.slots) || options.slots < 1 || options.base + options.slots > 65_536) {
    throw new Error("candidate Viewer port range is invalid");
  }
  const isAvailable = options.isAvailable ?? isCandidatePortAvailable;
  const firstSlot = Number.parseInt(createHash("sha256").update(deploymentId).digest("hex").slice(0, 6), 16) % options.slots;
  for (let offset = 0; offset < options.slots; offset += 1) {
    const port = options.base + ((firstSlot + offset) % options.slots);
    if (await isAvailable(port)) return port;
  }
  throw new Error("no candidate Viewer port is available");
}

export async function allocateBuiltCandidatePort(
  deploymentId: string,
  options: BuiltCandidatePortAllocationOptions,
): Promise<number> {
  try {
    const reserved = await options.reservedPorts();
    return await selectCandidatePort(deploymentId, {
      base: options.base,
      slots: options.slots,
      isAvailable: async (port) => !reserved.has(port) && await options.isAvailable(port),
    });
  } catch (allocationError) {
    const cleanupErrors: unknown[] = [];
    try { await options.removeImage(); } catch (error) { cleanupErrors.push(error); }
    try { await options.removeComposeSnapshot(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([allocationError, ...cleanupErrors], "candidate port allocation and build cleanup failed");
    }
    throw allocationError;
  }
}
