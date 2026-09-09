import { NextRequest, NextResponse } from "next/server";

import { executeSpawnRequest, productionSpawnCommandDependencies, type SpawnCommandDependencies } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { commitTaskMembership, recordLaunchIdentity, type MembershipInput, type MembershipResult } from "@/lib/tasks/membership";
import { mutateTasks } from "@/lib/tasks/store";
import type { ApiError } from "@/lib/types";

/**
 * Task membership before execution for Viewer launches (#1586).
 *
 * A launch that carries a client attempt key commits its task membership
 * first: the explicit task of a band-local «+ Agent», or one new placeholder
 * titled from the prompt for a global launch, keyed by the attempt so a replay
 * after a crash or a lost response resolves to the same task. Only then does
 * the spawn command run. A task store that cannot be written refuses the launch
 * instead of starting an agent outside every task. The receipt's launch and
 * conversation identity is recorded onto the same assignment afterwards; if
 * that second write is lost, the attempt key still finds the membership.
 *
 * Agent-initiated spawns (capability header, no attempt key) are admitted by
 * the spawn command's own lineage rules and reach the board through the
 * scanner's admission pass.
 */

export interface SpawnMembershipPorts {
  /** Commits membership under the task-file lock before any actuation. */
  commit: (input: MembershipInput) => MembershipResult;
  /** Fills the launch/conversation identity the receipt named onto the recorded assignment. */
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
  let taskIds: string[] = [];
  if (launch) {
    let committed: MembershipResult;
    try {
      committed = membership.commit({
        project: launch.taskId ? "" : membership.projectForCwd(launch.cwd),
        origin: { kind: "launch", key: launch.clientAttemptId },
        title: launch.title ?? launch.promptText,
        identity: { clientAttemptId: launch.clientAttemptId, engine: launch.engine },
        ...(launch.taskId ? { explicitTaskIds: [launch.taskId] } : {}),
      });
    } catch (error) {
      return NextResponse.json({ error: `task membership could not be recorded: ${error instanceof Error ? error.message : String(error)}` }, { status: 503 });
    }
    if (!committed.ok) return NextResponse.json({ error: committed.error }, { status: committed.status });
    taskIds = committed.taskIds;
  }
  const response = await execute(req, dependencies);
  if (launch && taskIds.length && response.ok) {
    try {
      const receipt = (await response.clone().json()) as Partial<SpawnResponse>;
      if (typeof receipt.launchId === "string" && typeof receipt.conversationId === "string") {
        membership.recordIdentity(taskIds, { clientAttemptId: launch.clientAttemptId, launchId: receipt.launchId, conversationId: receipt.conversationId, engine: launch.engine });
      }
    } catch {
      /* The receipt stays authoritative for the client; the attempt key keeps
         the membership reachable for the identity fill on retry. */
    }
  }
  return response;
}
