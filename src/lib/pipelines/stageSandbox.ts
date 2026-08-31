import type { EffectivePipelineRole, PipelineSandbox } from "./types";

/** Resolve the host/tool boundary independently from the stage's repository
    mutation policy. Requiring both fields at this seam makes that separation
    explicit: a read-only role still defaults to full host access. */
export function pipelineStageSandbox(stage: {
  sandbox?: PipelineSandbox;
  effectiveRole: Pick<EffectivePipelineRole, "access">;
}): PipelineSandbox {
  return stage.sandbox ?? "full";
}
