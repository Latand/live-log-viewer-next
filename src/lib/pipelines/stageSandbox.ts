import type { EffectivePipelineRole, PipelineAccess, PipelineSandbox } from "./types";

export type PipelineStageRuntimeProfile = {
  /** Repository mutation policy enforced by pipeline settlement. */
  access: PipelineAccess;
  /** Engine tool/network boundary applied while the stage runs. */
  sandbox: PipelineSandbox;
};

/** Freeze both independent access axes at the stage-to-host boundary. */
export function pipelineStageRuntimeProfile(stage: {
  sandbox?: PipelineSandbox;
  effectiveRole: Pick<EffectivePipelineRole, "access">;
}): PipelineStageRuntimeProfile {
  return {
    access: stage.effectiveRole.access,
    sandbox: stage.sandbox ?? "full",
  };
}

/** Resolve the host/tool boundary independently from the stage's repository
    mutation policy. Requiring both fields at this seam makes that separation
    explicit: a read-only role still defaults to full host access. */
export function pipelineStageSandbox(stage: {
  sandbox?: PipelineSandbox;
  effectiveRole: Pick<EffectivePipelineRole, "access">;
}): PipelineSandbox {
  return pipelineStageRuntimeProfile(stage).sandbox;
}
