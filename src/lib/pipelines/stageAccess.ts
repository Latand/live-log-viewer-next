import path from "node:path";

import { MAX_STAGE_OUTPUT_PATH_LENGTH } from "./limits";
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

/** One exact repository-relative Git path. Globs and traversal are excluded so
    a read-only stage cannot widen its declared-output exception. */
export function normalizeStageOutputPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\/+$/u, "");
  if (!normalized || normalized.length > MAX_STAGE_OUTPUT_PATH_LENGTH) return null;
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return null;
  if (normalized.startsWith(":") || /[\\*?[\]\u0000-\u001f\u007f]/u.test(normalized)) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (segments[0]!.toLowerCase() === ".git") return null;
  return normalized;
}

export function pathIsDeclaredOutput(candidate: string, outputs: readonly string[]): boolean {
  return outputs.some((output) => candidate === output || candidate.startsWith(`${output}/`));
}
