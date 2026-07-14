"use client";

import { en } from "@/lib/i18n/en";
import type { MessageKey, TFunction } from "@/lib/i18n";
import type { RoleParameter } from "@/lib/roles/types";

/**
 * UI-layer localization for the role catalog and reasoning tiers (issue #221
 * §1). The registry itself stays English — its names/labels/scaffolds feed the
 * PROMPTS sent to agents — so the localized display strings live in the i18n
 * dictionaries under `roleCopy.*`/`effortTier.*` and fall back to the raw
 * registry value whenever a key is missing (a custom role, a new option, a new
 * tier). One mapping, used by every builder surface: role selects, param
 * fields, stage chips, and the runtime pickers.
 */

const known = (key: string): key is MessageKey => key in en;

function copy(t: TFunction, key: string, fallback: string): string {
  return known(key) ? t(key) : fallback;
}

/** Localized display name for a catalog role (select options, descriptions). */
export function roleName(t: TFunction, role: { id: string; name: string }): string {
  return copy(t, `roleCopy.${role.id}.name`, role.name);
}

/** Localized role name straight from a stored role id (stage chips, stage
    rows) — falls back to the raw id for an unknown/legacy role. */
export function roleNameById(t: TFunction, roleId: string): string {
  return copy(t, `roleCopy.${roleId}.name`, roleId);
}

export function roleDescription(t: TFunction, role: { id: string; description: string }): string {
  return copy(t, `roleCopy.${role.id}.description`, role.description);
}

export function roleParamLabel(t: TFunction, roleId: string, parameter: RoleParameter): string {
  return copy(t, `roleCopy.${roleId}.param.${parameter.key}.label`, parameter.label);
}

export function roleParamDescription(t: TFunction, roleId: string, parameter: RoleParameter): string {
  return copy(t, `roleCopy.${roleId}.param.${parameter.key}.description`, parameter.description);
}

/** Localized label for one select-parameter option ("plain" → «звичайний»).
    The stored VALUE stays the registry token — only the display localizes. */
export function roleParamOptionLabel(t: TFunction, roleId: string, paramKey: string, option: string): string {
  return copy(t, `roleCopy.${roleId}.param.${paramKey}.option.${option}`, option);
}

/** Localized reasoning-tier label ("high" → «високе»); raw tier for unknowns. */
export function effortTierLabel(t: TFunction, tier: string): string {
  return copy(t, `effortTier.${tier}`, tier);
}
