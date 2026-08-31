import type {
  RuntimeHostGenerationIdentity,
  ViewerDeploymentStatus,
} from "@/lib/runtime/contracts";

import type {
  RuntimeHostHandoffIntent,
  RuntimeHostReleaseRecord,
  RuntimeHostRollbackIntent,
  RuntimeHostRollbackTarget,
} from "./hostRelease";

export function runtimeHostRollbackTargetFromHandoff(
  intent: RuntimeHostHandoffIntent,
): RuntimeHostRollbackTarget | null {
  if (!intent.previousRelease || !intent.successorRelease) return null;
  return {
    version: 1,
    active: intent.successorRelease,
    previous: intent.previousRelease,
    predecessorId: intent.predecessorId,
    recordedAt: intent.recordedAt,
  };
}

function matches(
  generation: RuntimeHostGenerationIdentity,
  release: RuntimeHostReleaseRecord,
): boolean {
  return generation.image === release.image
    && generation.revision === release.revision
    && generation.container === release.container;
}

export function runtimeHostRollbackDeploymentUpdate(
  status: ViewerDeploymentStatus,
  target: RuntimeHostRollbackTarget,
): Pick<ViewerDeploymentStatus, "phase" | "terminal" | "error"> | null {
  if (status.terminal
    || status.phase !== "host-handoff"
    || status.candidate?.image !== target.active.image
    || status.candidate.revision !== target.active.revision) return null;
  return {
    phase: "failed",
    terminal: true,
    error: `runtime-host handoff rolled back to ${target.previous.revision} after the successor failed serving readiness`,
  };
}

export async function requestRuntimeHostRollback(
  target: RuntimeHostRollbackTarget,
  ports: {
    writeIntent(intent: RuntimeHostRollbackIntent): void;
    writeRelease(release: RuntimeHostReleaseRecord): void;
    enablePreviousRestart(container: string): Promise<void>;
    startPrevious(container: string): Promise<void>;
    now?(): string;
  },
): Promise<void> {
  if (target.active.container === target.previous.container
    || target.active.image === target.previous.image && target.active.revision === target.previous.revision) {
    throw new Error("runtime-host rollback target does not name a distinct previous generation");
  }
  const requestedAt = (ports.now ?? (() => new Date().toISOString()))();
  ports.writeIntent({ ...target, phase: "requested", requestedAt });
  /* The retained process can claim its generation as soon as dockerd starts
     it, including when this caller disappears after the start request. */
  ports.writeRelease(target.previous);
  await ports.enablePreviousRestart(target.previous.container);
  await ports.startPrevious(target.predecessorId);
}

/** Runs in the retained predecessor before it waits on the singleton fence.
    It consumes only an intent naming this exact immutable generation. */
export async function resumeRuntimeHostRollback(
  generation: RuntimeHostGenerationIdentity,
  ports: {
    readIntent(): RuntimeHostRollbackIntent | null;
    disableActiveRestart(container: string): Promise<void>;
    stopActive(container: string): Promise<void>;
  },
): Promise<boolean> {
  const intent = ports.readIntent();
  if (!intent || !matches(generation, intent.previous)) return false;
  if (intent.active.container === generation.container) {
    throw new Error("runtime-host rollback would stop the recovery generation");
  }
  await ports.disableActiveRestart(intent.active.container);
  await ports.stopActive(intent.active.container);
  return true;
}

/** Runs after the retained predecessor owns the fence. The failed successor
    has no remaining restart authority before it is removed. */
export async function completeRuntimeHostRollback(
  generation: RuntimeHostGenerationIdentity,
  ports: {
    readIntent(): RuntimeHostRollbackIntent | null;
    removeFailed(container: string): Promise<void>;
    clearTarget?(): void;
    clearIntent(): void;
  },
): Promise<boolean> {
  const intent = ports.readIntent();
  if (!intent || !matches(generation, intent.previous)) return false;
  if (intent.active.container === generation.container) {
    throw new Error("runtime-host rollback cleanup targets the recovery generation");
  }
  await ports.removeFailed(intent.active.container);
  ports.clearTarget?.();
  ports.clearIntent();
  return true;
}
