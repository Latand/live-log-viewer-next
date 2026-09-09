import type { NextRequest, NextResponse } from "next/server";

import type { AgentRegistry, SpawnBeginResult, SpawnRequest } from "@/lib/agent/registry";
import { SpawnParentError } from "@/lib/agent/spawnParent";
import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { commitTaskMembership, recordLaunchIdentity, type MembershipInput, type MembershipResult } from "@/lib/tasks/membership";
import { mutateTasks } from "@/lib/tasks/store";
import type { ApiError } from "@/lib/types";

/**
 * Task membership before execution for Viewer launches (#1586).
 *
 * The spawn command validates origin, caller authority and the launch body,
 * resolves the account, and only then reserves the durable launch receipt
 * through `registry.beginSpawnRequest` — the last shared step before any
 * actuation. The command's `registry` dependency is wrapped so that exactly at
 * that step, with every admission check already passed, the launch's task
 * membership is committed under the task-file lock (the explicit task of a
 * band-local «+ Agent», or one new placeholder titled from the prompt for a
 * global launch, keyed by the client attempt). A membership the store cannot
 * record aborts the reservation, so no agent starts outside every task. The
 * receipt's launch and conversation identity is written onto the same
 * assignment synchronously, still before the command actuates anything: a
 * transcript that appears later is matched by conversation id, and a crash
 * between the two synchronous writes is repaired by the scanner's admission
 * pass from the receipt's attempt key.
 *
 * Agent-initiated spawns without an attempt key are admitted by the command's
 * own lineage rules and reach a task through the scanner's admission pass.
 */

export interface SpawnMembershipPorts {
  /** Commits membership under the task-file lock. */
  commit: (input: MembershipInput) => MembershipResult;
  /** Writes the reserved launch/conversation identity onto the recorded assignment. */
  recordIdentity: (taskIds: readonly string[], identity: { clientAttemptId: string; launchId: string; conversationId: string; engine: "claude" | "codex" | null }) => void;
  /** Project key the scanner will derive for a launch directory. */
  projectForCwd: (cwd: string) => string;
}

export const productionMembershipPorts: SpawnMembershipPorts = {
  commit: (input) => commitTaskMembership(input),
  recordIdentity: (taskIds, identity) => {
    mutateTasks((tasks) => {
      const outcome = recordLaunchIdentity(tasks, taskIds, identity);
      return { tasks: outcome.changed ? outcome.tasks : undefined, result: null };
    });
  },
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
 * launch receipt for this request's attempt first commits the task membership
 * and then records the reserved identity. Any other call is forwarded as is.
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
            project: launch.taskId ? "" : membership.projectForCwd(input.cwd || launch.cwd),
            origin: { kind: "launch", key: launch.clientAttemptId },
            title: launch.title ?? launch.promptText,
            identity: { clientAttemptId: launch.clientAttemptId, engine: launch.engine },
            ...(launch.taskId ? { explicitTaskIds: [launch.taskId] } : {}),
          });
        } catch (error) {
          throw new TaskMembershipError(`task membership could not be recorded: ${error instanceof Error ? error.message : String(error)}`, 503);
        }
        if (!committed.ok) throw new TaskMembershipError(committed.error, committed.status);
        const begun = target.beginSpawnRequest(input);
        if (begun.kind !== "conflict") {
          membership.recordIdentity(committed.taskIds, { clientAttemptId: launch.clientAttemptId, launchId: begun.receipt.launchId, conversationId: begun.receipt.conversationId, engine: launch.engine });
        }
        return begun;
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
