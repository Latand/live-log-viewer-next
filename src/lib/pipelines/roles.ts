import { configForParams, listRoles, roleFenceBlock, roleScaffoldBody, validateRoleParams } from "@/lib/roles/registry";
import { MAX_SCAFFOLD_LENGTH } from "@/lib/roles/store";
import { isEngineEffort } from "@/lib/agent/efforts";
import { isCodexLaunchModel, normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { PIPELINE_DISALLOWED_ROLE_IDS, type EffectivePipelineRole, type PipelineRoleId, type PipelineStage, type PipelineStageKind } from "./types";

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

/** Adapter seam for #35. The role registry can register its resolver at startup.
    Optional operator-chosen parameter values override registry defaults when the
    role's prompt scaffold is substituted. */
export type PipelineRoleLookup = (roleId: string, params?: Record<string, string | number>) => PipelineRoleDefaults | null;

let installedLookup: PipelineRoleLookup | null = null;

function defaultParameterValue(parameter: ReturnType<typeof listRoles>[number]["parameters"][number]): string | number {
  if (parameter.kind === "integer") return parameter.min ?? 1;
  return parameter.options?.[0] ?? "";
}

/** Production adapter for the shared issue-35 registry. */
export const pipelineRoleLookup: PipelineRoleLookup = (roleId, params) => {
  const definition = listRoles().find((candidate) => candidate.id === roleId);
  if (!definition) return null;
  const parameters = Object.fromEntries(
    definition.parameters.map((parameter) => {
      /* Operator overrides win over registry defaults, but only for a known,
         non-empty value; a blank field keeps the default, so the scaffold token
         stays intact. */
      const chosen = params?.[parameter.key];
      const value = chosen !== undefined && chosen !== "" ? chosen : defaultParameterValue(parameter);
      return [parameter.key, value];
    }),
  );
  /* Reuse the canonical renderer so a Builder domain=frontend stage gets the
     same frontend guidance resolveRole emits — a hand-rolled substitution here
     dropped it, weakening the Opus scaffold. Fences stay separate so a near-limit
     body can be trimmed to the store cap without ever cutting a fence. */
  const body = roleScaffoldBody(definition, parameters);
  const fences = roleFenceBlock(definition);
  return {
    /* Parameter-aware runtime: Builder domain=frontend → Claude/Opus,
       mode=apply-fixes → Terra, matching the registry so an omitted override
       does not silently fall back to the base Sol config. */
    ...configForParams(definition, parameters),
    access: definition.capabilities.includes("read-only") ? "read-only" : "read-write",
    promptScaffold: `${body.slice(0, MAX_SCAFFOLD_LENGTH - fences.length)}${fences}`,
  };
};

export function setPipelineRoleLookup(lookup: PipelineRoleLookup | null): void {
  installedLookup = lookup;
}

/**
 * Canonical value-validation for a pipeline stage's role params, so a create
 * POST cannot freeze a scaffold with a bogus select option, an out-of-range
 * integer, an unknown key, or over-long text — the same rules the shared role
 * registry enforces. `requireRequired` is off: a pipeline stage resolves absent
 * params to registry defaults (a reviewer needs no explicit diffSource — it
 * reviews the stage's own branch), matching how role-less stages already work.
 * Returns an error string for the caller to surface as a 400, or null when ok.
 */
export function validatePipelineRoleParams(roleId: string, params: Record<string, string | number> | undefined): string | null {
  if (!params) return null;
  const definition = listRoles().find((candidate) => candidate.id === roleId);
  if (!definition) return null; // an unknown roleId is already rejected upstream
  const result = validateRoleParams(definition, params, { requireRequired: false });
  return result.ok ? null : result.error;
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
  if (rawRoleId && PIPELINE_DISALLOWED_ROLE_IDS.includes(rawRoleId as PipelineRoleId)) {
    return { error: `role ${rawRoleId} is not allowed in a pipeline (it requires interactive deploy confirmation)` };
  }
  const roleParams = ref && ref.params && typeof ref.params === "object" && !Array.isArray(ref.params) ? ref.params : undefined;
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
  const registered = roleId ? registry?.(roleId, roleParams) ?? null : null;
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
  /* Mirrors the store's isEffectiveRole bounds so a bad override fails the
     create with a 400 instead of surfacing as a persist-time 500. */
  if (model && engine === "codex" && !isCodexLaunchModel(model)) {
    return { error: "stage model is not supported by codex; provide a compatible model override" };
  }
  if (effort && !isEngineEffort(engine, effort)) {
    return { error: `stage effort is not supported by ${engine}` };
  }
  /* The store refuses to load a referenced role without a scaffold, so an
     empty resolution must fail the create instead of persisting a record
     that can never load back. */
  const promptScaffold = roleId && typeof registered?.promptScaffold === "string"
    ? registered.promptScaffold.trim() || null
    : null;
  if (roleId && !promptScaffold) {
    return { error: `role ${roleId} resolves to an empty prompt scaffold` };
  }
  return {
    role: {
      roleId,
      engine,
      model,
      effort,
      access: kind === "review-loop" ? "read-only" : stage.access ?? registered?.access ?? builder.access ?? "read-write",
      promptScaffold,
    },
  };
}
