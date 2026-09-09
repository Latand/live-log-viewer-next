import type { NextRequest, NextResponse } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";
import { SpawnParentError } from "@/lib/agent/spawnParent";
import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { commitTaskMembership, type MembershipInput, type MembershipResult } from "@/lib/tasks/membership";
import type { ApiError } from "@/lib/types";

/**
 * Task membership before execution for Viewer launches (#1586).
 *
 * Every launch commits its membership inside the registry's receipt
 * reservation (`src/lib/tasks/launchMembership.ts`), with the reserved launch
 * and conversation identity, after every admission check and before any
 * actuation. What only the HTTP body knows is the explicit task of a band-local
 * «+ Agent»: the command's `registry` dependency is wrapped so that, at that
 * same reservation step, the explicit target is committed first under the
 * client attempt key; the registry's own admission then resolves the held
 * membership and fills the identity. A missing target or an unwritable store
 * aborts the reservation with its own status, so no agent starts outside every
 * task. The placeholder project is the launch's validated explicit project when
 * it has one, else the project the scanner derives for the launch directory.
 */

export interface SpawnMembershipPorts {
  /** Commits membership under the task-file lock. */
  commit: (input: MembershipInput) => MembershipResult;
  /** Project key the scanner will derive for a launch directory. */
  projectForCwd: (cwd: string) => string;
}

export const productionMembershipPorts: SpawnMembershipPorts = {
  commit: (input) => commitTaskMembership(input),
  projectForCwd: (cwd) => projectInfoFromCwd(cwd)?.project ?? "other",
};

export interface ParsedLaunch {
  clientAttemptId: string;
  taskId: string | null;
  engine: "claude" | "codex" | null;
  cwd: string;
  promptText: string;
  title: string | null;
}

export function parseLaunchBody(value: unknown): ParsedLaunch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const clientAttemptId = typeof body.clientAttemptId === "string" ? body.clientAttemptId.trim() : "";
  if (!clientAttemptId) return null;
  const taskId = typeof body.taskId === "string" && body.taskId.trim() ? body.taskId.trim() : null;
  const engine = body.engine === "claude" || body.engine === "codex" ? body.engine : null;
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const promptText = typeof body["prompt"] === "string" ? body["prompt"] : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
  return { clientAttemptId, taskId, engine, cwd, promptText, title };
}

/** Thrown out of the reservation when membership cannot be recorded. It is a
    `SpawnParentError`, the admission error class the command already maps to
    `{ error, status }`, so the client sees the refusal's own status and no
    agent is actuated. */
export class TaskMembershipError extends SpawnParentError {
  constructor(message: string, status: number) {
    super(message, status);
    this.name = "TaskMembershipError";
  }
}

/**
 * The registry the spawn command sees: identical, except that reserving the
 * launch receipt for this request's attempt first commits the explicit task
 * membership (or the placeholder in the launch's own project). Any other call
 * is forwarded as is.
 */
export function admittedRegistry(base: AgentRegistry, launch: ParsedLaunch, membership: SpawnMembershipPorts): AgentRegistry {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== "beginSpawnRequest") {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (input: SpawnRequest): SpawnBeginResult => {
        if (input.clientAttemptId !== launch.clientAttemptId) return target.beginSpawnRequest(input);
        let committed: MembershipResult;
        try {
          committed = membership.commit({
            project: launch.taskId ? "" : input.explicitProject?.trim() || membership.projectForCwd(input.cwd || launch.cwd),
            origin: { kind: "launch", key: launch.clientAttemptId },
            title: launch.title ?? launch.promptText,
            identity: { clientAttemptId: launch.clientAttemptId, engine: launch.engine },
            ...(launch.taskId ? { explicitTaskIds: [launch.taskId] } : {}),
          });
        } catch (error) {
          throw new TaskMembershipError(`task membership could not be recorded: ${error instanceof Error ? error.message : String(error)}`, 503);
        }
        if (!committed.ok) throw new TaskMembershipError(committed.error, committed.status);
        return target.beginSpawnRequest(input);
      };
    },
  });
}

export function admittedDependencies(dependencies: SpawnCommandDependencies, launch: ParsedLaunch, membership: SpawnMembershipPorts): SpawnCommandDependencies {
  let wrapped: AgentRegistry | null = null;
  return {
    ...dependencies,
    registry: () => {
      if (!wrapped) wrapped = admittedRegistry(dependencies.registry(), launch, membership);
      return wrapped;
    },
  };
}

export type SpawnExecutor = (req: NextRequest, dependencies: SpawnCommandDependencies) => Promise<NextResponse<SpawnResponse | ApiError>>;

export async function executeAdmittedSpawnRequest(
  req: NextRequest,
  dependencies: SpawnCommandDependencies = productionSpawnCommandDependencies,
  membership: SpawnMembershipPorts = productionMembershipPorts,
  execute: SpawnExecutor = executeSpawnRequest,
): Promise<NextResponse<SpawnResponse | ApiError>> {
  let launch: ParsedLaunch | null = null;
  try {
    launch = parseLaunchBody(await req.clone().json());
  } catch {
    launch = null;
  }
  return execute(req, launch ? admittedDependencies(dependencies, launch, membership) : dependencies);
}
