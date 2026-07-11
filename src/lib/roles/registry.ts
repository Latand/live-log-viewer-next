import { isEngineEffort } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { BUILDER_APPLY_FIXES_CONFIG, BUILDER_FRONTEND_CONFIG } from "./paramConfig";
import { loadRoleDefinitions } from "./store";
import type { ResolvedRole, RoleConfig, RoleDefinition, RoleId, RoleParamValues } from "./types";

type ExplicitRoleConfig = Partial<RoleConfig>;
type RoleResolution = { ok: true; value: ResolvedRole } | { ok: false; error: string };
type SpawnRoleResolution = { ok: true; value: { config: RoleConfig; scaffold: string; role: RoleId } | null } | { ok: false; error: string };

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 2_000 ? text : null;
}

/**
 * Canonical role-parameter validation: unknown keys, select options, integer
 * bounds, and text length are always enforced. `requireRequired` gates the
 * missing-required check so contexts where a parameter is optional (pipeline
 * stages resolve absent params to registry defaults) can reuse the same value
 * checks without forcing spawn-time required fields.
 */
export function validateRoleParams(
  definition: RoleDefinition,
  raw: unknown,
  { requireRequired = true }: { requireRequired?: boolean } = {},
): { ok: true; value: RoleParamValues } | { ok: false; error: string } {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) return { ok: false, error: "roleParams must be an object" };
  const source = (raw ?? {}) as Record<string, unknown>;
  const byKey = new Map(definition.parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(source)) {
    if (!byKey.has(key)) return { ok: false, error: `unknown role parameter: ${key}` };
  }
  const values: RoleParamValues = {};
  for (const parameter of definition.parameters) {
    const input = source[parameter.key];
    if (input === undefined || input === "") {
      if (parameter.required && requireRequired) return { ok: false, error: `missing required role parameter: ${parameter.key}` };
      values[parameter.key] = parameter.kind === "integer" ? parameter.min ?? 1 : parameter.options?.[0] ?? "";
      continue;
    }
    if (parameter.kind === "integer") {
      if (!Number.isInteger(input) || typeof input !== "number" || (parameter.min !== undefined && input < parameter.min) || (parameter.max !== undefined && input > parameter.max)) {
        return { ok: false, error: `invalid role parameter: ${parameter.key}` };
      }
      values[parameter.key] = input;
      continue;
    }
    const value = boundedText(input);
    if (!value || (parameter.kind === "select" && !parameter.options?.includes(value))) return { ok: false, error: `invalid role parameter: ${parameter.key}` };
    values[parameter.key] = value;
  }
  return { ok: true, value: values };
}

function renderScaffold(template: string, params: RoleParamValues): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => String(params[key] ?? ""));
}

/**
 * The rendered scaffold body — parameter substitution plus any role-specific
 * guidance (Builder's domain=frontend contract) — with the safety-fence block
 * kept separate so a length-capped caller (the pipeline lookup) can trim the
 * body without ever cutting a fence. This is the single source of the frontend
 * guidance; the pipeline reuses it, so a re-render can't drop it.
 */
export function roleScaffoldBody(definition: RoleDefinition, params: RoleParamValues): string {
  const frontendGuidance = definition.id === "builder" && params.domain === "frontend"
    ? "\n\nUI/frontend implementation guidance: follow the approved interaction and visual contract, preserve accessible semantics, responsive behavior, and English/Ukrainian parity."
    : "";
  return renderScaffold(definition.promptScaffold, params) + frontendGuidance;
}

/** The trailing safety-fence block for a role, or "" when it declares none. */
export function roleFenceBlock(definition: RoleDefinition): string {
  if (!definition.safetyFences.length) return "";
  return `\n\nSafety fences:\n${definition.safetyFences.map((fence) => `- ${fence}`).join("\n")}`;
}

function promptWithFences(definition: RoleDefinition, params: RoleParamValues): string {
  return roleScaffoldBody(definition, params) + roleFenceBlock(definition);
}

export function configForParams(definition: RoleDefinition, params: RoleParamValues): RoleConfig {
  if (definition.id !== "builder") return definition.config;
  if (params.domain === "frontend") return BUILDER_FRONTEND_CONFIG;
  if (params.mode === "apply-fixes") return BUILDER_APPLY_FIXES_CONFIG;
  return definition.config;
}

function resolveConfig(definition: RoleDefinition, params: RoleParamValues, explicit: ExplicitRoleConfig): { ok: true; value: RoleConfig } | { ok: false; error: string } {
  const config = { ...configForParams(definition, params), ...explicit };
  if (config.engine !== "claude" && config.engine !== "codex") return { ok: false, error: "engine must be claude or codex" };
  if (!config.model || config.model.length > 128) return { ok: false, error: "model must be a printable id up to 128 characters" };
  if (config.engine === "claude" && !normalizeClaudeLaunchModel(config.model)) return { ok: false, error: "model is not supported by claude" };
  if (config.engine === "codex" && !config.model.startsWith("gpt-")) return { ok: false, error: "model is not supported by codex" };
  if (!isEngineEffort(config.engine, config.effort)) return { ok: false, error: `effort for ${config.engine} must be one of: ${config.engine === "codex" ? "low, medium, high, xhigh" : "low, medium, high, xhigh, max"}` };
  return { ok: true, value: config };
}

export function resolveRole(role: string, params: unknown = {}, explicit: ExplicitRoleConfig = {}, definitions: RoleDefinition[] = loadRoleDefinitions()): RoleResolution {
  const definition = definitions.find((candidate) => candidate.id === role);
  if (!definition) return { ok: false, error: "unknown role" };
  const parsedParams = validateRoleParams(definition, params);
  if (!parsedParams.ok) return parsedParams;
  const config = resolveConfig(definition, parsedParams.value, explicit);
  if (!config.ok) return config;
  return {
    ok: true,
    value: {
      definition,
      config: config.value,
      params: parsedParams.value,
      prompt: promptWithFences(definition, parsedParams.value),
      requiresDeploymentConfirmation: definition.id === "deployer",
    },
  };
}

export function listRoles(): RoleDefinition[] {
  return loadRoleDefinitions();
}

/** Resolve a role-shaped spawn body before the route creates a CLI spec. */
export function resolveSpawnRole(body: { role?: unknown; roleParams?: unknown; confirm?: unknown; engine?: unknown; model?: unknown; effort?: unknown }): SpawnRoleResolution {
  if (body.role === undefined || body.role === null || body.role === "") return { ok: true, value: null };
  if (typeof body.role !== "string") return { ok: false, error: "role must be a string" };
  const base = resolveRole(body.role, body.roleParams);
  if (!base.ok) return base;
  const explicit: ExplicitRoleConfig = {};
  if (body.engine !== undefined) {
    if (body.engine !== "claude" && body.engine !== "codex") return { ok: false, error: "engine must be claude or codex" };
    if (body.engine !== base.value.config.engine && body.model === undefined) return { ok: false, error: "model is required when overriding a role engine" };
    explicit.engine = body.engine;
  }
  if (typeof body.model === "string" && body.model.trim()) explicit.model = body.model.trim();
  if (typeof body.effort === "string" && body.effort.trim()) explicit.effort = body.effort.trim();
  const resolved = resolveRole(body.role, body.roleParams, explicit);
  if (!resolved.ok) return resolved;
  if (resolved.value.requiresDeploymentConfirmation && body.confirm !== "deploy") {
    return { ok: false, error: "deployer requires confirm: deploy" };
  }
  return { ok: true, value: { config: resolved.value.config, scaffold: resolved.value.prompt, role: resolved.value.definition.id } };
}
