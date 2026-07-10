import { listRoles } from "@/lib/roles/registry";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/store";
import { isEngineEffort } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

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

function defaultParameterValue(parameter: ReturnType<typeof listRoles>[number]["parameters"][number]): string | number {
  if (parameter.kind === "integer") return parameter.min ?? 1;
  return parameter.options?.[0] ?? "";
}

/** Production adapter for the shared issue-35 registry. */
export const pipelineRoleLookup: PipelineRoleLookup = (roleId) => {
  const definition = listRoles().find((candidate) => candidate.id === roleId);
  if (!definition) return null;
  const parameters = Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, defaultParameterValue(parameter)]));
  const scaffold = definition.promptScaffold.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => String(parameters[key] ?? ""));
  /* A near-limit override scaffold plus appended fences must still fit the
     store's persistence cap, or the created pipeline could never load back.
     Fences are never truncated; the scaffold body yields the room instead. */
  const fences = definition.safetyFences.length
    ? `\n\nSafety fences:\n${definition.safetyFences.map((fence) => `- ${fence}`).join("\n")}`
    : "";
  return {
    ...definition.config,
    access: definition.capabilities.includes("read-only") ? "read-only" : "read-write",
    promptScaffold: `${scaffold.slice(0, MAX_SCAFFOLD_LENGTH - fences.length)}${fences}`,
  };
};

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
  const registry = lookup === undefined ? installedLookup : lookup;
  const builder = registry?.("builder") ?? null;
  if (!builder) return { error: "Builder role is unavailable in the role registry" };
  const roleId = rawRoleId ? rawRoleId as PipelineRoleId : null;
  const registered = roleId ? registry?.(roleId) ?? null : null;
  const value = (override: unknown, fallback: string | null | undefined): string | null => {
    if (override === null) return null;
    if (typeof override === "string") return override.trim() || null;
    return fallback ?? null;
  };
  const engine = stage.engine ?? registered?.engine ?? builder.engine;
  const model = value(stage.model, registered?.model ?? builder.model);
  const effort = value(stage.effort, registered?.effort ?? builder.effort);
  if (model && engine === "claude" && !normalizeClaudeLaunchModel(model)) {
    return { error: "stage model is not supported by claude; provide a compatible model override" };
  }
  if (model && engine === "codex" && !model.startsWith("gpt-")) {
    return { error: "stage model is not supported by codex; provide a compatible model override" };
  }
  if (effort && !isEngineEffort(engine, effort)) {
    return { error: `stage effort is not supported by ${engine}` };
  }
  return {
    role: {
      roleId,
      engine,
      model,
      effort,
      access: kind === "review-loop" ? "read-only" : stage.access ?? registered?.access ?? builder.access ?? "read-write",
      promptScaffold: roleId && typeof registered?.promptScaffold === "string"
        ? registered.promptScaffold.trim() || null
        : null,
    },
  };
}
