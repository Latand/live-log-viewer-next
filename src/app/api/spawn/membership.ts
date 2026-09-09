import type { NextRequest, NextResponse } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";
import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import type { ApiError } from "@/lib/types";

/**
 * Task membership before execution for Viewer launches (#1586).
 *
 * Every launch commits its membership inside the registry's receipt
 * reservation (`src/lib/tasks/launchMembership.ts`), with the reserved launch
 * and conversation identity, after every admission check and before any
 * actuation. What only the HTTP body knows is the explicit task of a band-local
 * «+ Agent»: the command's `registry` dependency is wrapped so that the
 * reservation for this request's attempt carries that task as its explicit
 * target. The registry then validates the target and commits the membership in
 * the same step it uses for every other launch; a missing target or an
 * unwritable store aborts the reservation with its own status, mapped by the
 * command, so no agent starts outside every task.
 */

export interface ParsedLaunch {
  clientAttemptId: string;
  taskId: string | null;
}

export function parseLaunchBody(value: unknown): ParsedLaunch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const clientAttemptId = typeof body.clientAttemptId === "string" ? body.clientAttemptId.trim() : "";
  if (!clientAttemptId) return null;
  const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : null;
  return { clientAttemptId, taskId };
}

/**
 * The registry the spawn command sees: identical, except that the reservation
 * for this request's attempt names the request's explicit task. Any other call
 * is forwarded as is.
 */
export function admittedRegistry(base: AgentRegistry, launch: ParsedLaunch): AgentRegistry {
  if (!launch.taskId) return base;
  const taskIds = [launch.taskId];
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== "beginSpawnRequest") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (input: SpawnRequest): SpawnBeginResult => {
        if (input.clientAttemptId !== launch.clientAttemptId) return target.beginSpawnRequest(input);
        return target.beginSpawnRequest({ ...input, taskIds });
      };
    },
  });
}

export function admittedDependencies(dependencies: SpawnCommandDependencies, launch: ParsedLaunch): SpawnCommandDependencies {
  let wrapped: AgentRegistry | null = null;
  return {
    ...dependencies,
    registry: () => {
      if (!wrapped) wrapped = admittedRegistry(dependencies.registry(), launch);
      return wrapped;
    },
  };
}

export type SpawnExecutor = (req: NextRequest, dependencies: SpawnCommandDependencies) => Promise<NextResponse<SpawnResponse | ApiError>>;

export async function executeAdmittedSpawnRequest(
  req: NextRequest,
  dependencies: SpawnCommandDependencies = productionSpawnCommandDependencies,
  execute: SpawnExecutor = executeSpawnRequest,
): Promise<NextResponse<SpawnResponse | ApiError>> {
  let launch: ParsedLaunch | null = null;
  try {
    launch = parseLaunchBody(await req.clone().json());
  } catch {
    launch = null;
  }
  return execute(req, launch?.taskId ? admittedDependencies(dependencies, launch) : dependencies);
}
