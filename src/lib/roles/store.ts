import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { ROLE_DEFAULTS } from "./defaults";
import type { RoleDefinition, RoleId, RoleOverride, RoleOverridesFile } from "./types";

export const ROLE_OVERRIDES_SCHEMA_VERSION = 1;

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
  const override = value as RoleOverride;
  if (override.promptScaffold !== undefined && (typeof override.promptScaffold !== "string" || override.promptScaffold.length > 12_000)) return false;
  if (override.config !== undefined) {
    if (!override.config || typeof override.config !== "object" || Array.isArray(override.config)) return false;
    const { engine, model, effort } = override.config;
    if (engine !== undefined && engine !== "claude" && engine !== "codex") return false;
    if (model !== undefined && (typeof model !== "string" || model.length > 128)) return false;
    if (effort !== undefined && (typeof effort !== "string" || effort.length > 32)) return false;
  }
  return true;
}

export function loadRoleOverrides(): RoleOverridesFile {
  try {
    const raw = JSON.parse(fs.readFileSync(overridesFile(), "utf8")) as Partial<RoleOverridesFile>;
    if (raw.schemaVersion !== ROLE_OVERRIDES_SCHEMA_VERSION || !raw.overrides || typeof raw.overrides !== "object" || Array.isArray(raw.overrides)) {
      return { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides: {} };
    }
    const overrides: Partial<Record<RoleId, RoleOverride>> = {};
    for (const [id, override] of Object.entries(raw.overrides)) {
      if (isRoleId(id) && isOverride(override)) overrides[id] = override;
    }
    return { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides };
  } catch {
    return { schemaVersion: ROLE_OVERRIDES_SCHEMA_VERSION, overrides: {} };
  }
}

export function saveRoleOverrides(overrides: Partial<Record<RoleId, RoleOverride>>): void {
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
