import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { isEngineEffort } from "@/lib/agent/efforts";
import { normalizeClaudeLaunchModel } from "@/lib/agent/models";

import { ROLE_DEFAULTS } from "./defaults";
import type { RoleDefinition, RoleId, RoleOverride, RoleOverridesFile } from "./types";

export const ROLE_OVERRIDES_SCHEMA_VERSION = 1;

export class RoleStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RoleStoreError";
  }
}

const overridesFile = () => statePath("role-presets.json");

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, filePath);
}

function isRoleId(value: unknown): value is RoleId {
  return ROLE_DEFAULTS.some((role) => role.id === value);
}

function isOverride(value: unknown): value is RoleOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== "config" && key !== "promptScaffold")) return false;
  const override = value as RoleOverride;
  if (override.promptScaffold !== undefined && (typeof override.promptScaffold !== "string" || override.promptScaffold.length > 12_000)) return false;
  if (override.config !== undefined) {
    if (!override.config || typeof override.config !== "object" || Array.isArray(override.config)) return false;
    if (Object.keys(override.config).some((key) => key !== "engine" && key !== "model" && key !== "effort")) return false;
    const { engine, model, effort } = override.config;
    if (engine !== undefined && engine !== "claude" && engine !== "codex") return false;
    if (model !== undefined && (typeof model !== "string" || model.length > 128)) return false;
    if (effort !== undefined && (typeof effort !== "string" || effort.length > 32)) return false;
  }
  return true;
}

function isCompatibleOverride(id: RoleId, override: RoleOverride): boolean {
  const defaults = ROLE_DEFAULTS.find((role) => role.id === id)!;
  const config = { ...defaults.config, ...override.config };
  if (config.model.length > 128 || /[\u0000-\u001f\u007f]/.test(config.model)) return false;
  if (config.engine === "claude" && !normalizeClaudeLaunchModel(config.model)) return false;
  if (config.engine === "codex" && !config.model.startsWith("gpt-")) return false;
  return isEngineEffort(config.engine, config.effort);
}

export function loadRoleOverrides(): RoleOverridesFile {
  let text: string;
  try {
    text = fs.readFileSync(overridesFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides: {} };
    throw new RoleStoreError(`could not read role override registry: ${overridesFile()}`, { cause: error });
  }
  let raw: Partial<RoleOverridesFile>;
  try {
    raw = JSON.parse(text) as Partial<RoleOverridesFile>;
  } catch (error) {
    throw new RoleStoreError("role override registry contains malformed JSON", { cause: error });
  }
  if (raw.schemaVersion !== ROLE_OVERRIDES_SCHEMA_VERSION) {
    throw new RoleStoreError(`unsupported role override schema: ${String(raw.schemaVersion)}`);
  }
  if (!raw.overrides || typeof raw.overrides !== "object" || Array.isArray(raw.overrides)) {
    throw new RoleStoreError("role override registry must contain an overrides object");
  }
  const overrides: Partial<Record<RoleId, RoleOverride>> = {};
  for (const [id, override] of Object.entries(raw.overrides)) {
    if (!isRoleId(id) || !isOverride(override) || !isCompatibleOverride(id, override)) throw new RoleStoreError(`invalid role override: ${id}`);
    overrides[id] = override;
  }
  return { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides };
}

export function saveRoleOverrides(overrides: Partial<Record<RoleId, RoleOverride>>): void {
  for (const [id, override] of Object.entries(overrides)) {
    if (!isRoleId(id) || !isOverride(override) || !isCompatibleOverride(id, override)) throw new RoleStoreError(`invalid role override: ${id}`);
  }
  atomicWriteJson(overridesFile(), { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides });
}

export function mergeRoleDefinitions(overrides: Partial<Record<RoleId, RoleOverride>>): RoleDefinition[] {
  return ROLE_DEFAULTS.map((role) => {
    const override = overrides[role.id];
    return {
      ...role,
      config: { ...role.config, ...override?.config },
      promptScaffold: override?.promptScaffold ?? role.promptScaffold,
    };
  });
}

export function loadRoleDefinitions(): RoleDefinition[] {
  return mergeRoleDefinitions(loadRoleOverrides().overrides);
}
