import { CODEX_SOL_MODEL } from "@/lib/agent/models";

import type { EffectivePipelineRole, PipelineRoleId, PipelineStage, PipelineStageKind } from "./types";

export const PIPELINE_ROLE_IDS: readonly PipelineRoleId[] = [
  "orchestrator",
  "reviewer",
  "verifier",
  "builder",
  "architect",
  "cleaner",
  "prod-auditor",
  "deployer",
];

export type PipelineRoleDefaults = {
  engine: "claude" | "codex";
  model: string | null;
  effort: string | null;
  access?: "read-only" | "read-write";
  promptScaffold?: string | null;
};

/** Adapter seam for #35. The role registry can register its resolver at startup. */
export type PipelineRoleLookup = (roleId: string) => PipelineRoleDefaults | null;

let installedLookup: PipelineRoleLookup | null = null;

export function setPipelineRoleLookup(lookup: PipelineRoleLookup | null): void {
  installedLookup = lookup;
}

export function resolvePipelineRole(
  stage: Pick<PipelineStage, "role" | "engine" | "model" | "effort" | "access">,
  kind: PipelineStageKind,
  lookup?: PipelineRoleLookup | null,
): { role?: EffectivePipelineRole; error?: string } {
  const ref = stage.role;
  if (ref !== undefined && (!ref || typeof ref !== "object" || Array.isArray(ref))) {
    return { error: "stage role must be an object" };
  }
  const rawRoleId = ref && typeof ref.roleId === "string" ? ref.roleId.trim() : "";
  if (ref && !rawRoleId) return { error: "stage roleId is required when role is present" };
  if (rawRoleId && !PIPELINE_ROLE_IDS.includes(rawRoleId as PipelineRoleId)) return { error: `unknown pipeline role: ${rawRoleId}` };
  if (stage.engine !== undefined && stage.engine !== "claude" && stage.engine !== "codex") {
    return { error: "stage engine must be claude or codex" };
  }
  if (stage.access !== undefined && stage.access !== "read-only" && stage.access !== "read-write") {
    return { error: "stage has an invalid access value" };
  }
  if (kind === "review-loop" && stage.access === "read-write") {
    return { error: "review-loop stages require read-only access" };
  }
  const roleId = rawRoleId ? rawRoleId as PipelineRoleId : null;
  const registered = roleId ? (lookup === undefined ? installedLookup : lookup)?.(roleId) ?? null : null;
  const value = (override: unknown, fallback: string | null | undefined): string | null => {
    if (override === null) return null;
    if (typeof override === "string") return override.trim() || null;
    return fallback ?? null;
  };
  return {
    role: {
      roleId,
      engine: stage.engine ?? registered?.engine ?? "codex",
      model: value(stage.model, registered?.model ?? CODEX_SOL_MODEL),
      effort: value(stage.effort, registered?.effort ?? "high"),
      access: kind === "review-loop" ? "read-only" : stage.access ?? registered?.access ?? "read-write",
      promptScaffold: roleId && typeof registered?.promptScaffold === "string"
        ? registered.promptScaffold.trim() || null
        : null,
    },
  };
}
