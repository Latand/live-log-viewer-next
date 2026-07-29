import type { RoleDefinition, RoleParameter, RoleParamValues } from "./types";

/** Resolve the declared omission-time value shared by role drafts and runners. */
export function defaultRoleParameterValue(parameter: RoleParameter): string | number {
  if (parameter.default !== undefined) return parameter.default;
  if (parameter.kind === "integer") return parameter.min ?? 1;
  if (parameter.kind === "select") return parameter.options?.[0] ?? "";
  return "";
}

/** Build the parameter state shown when a draft selects a role. */
export function defaultRoleParameterValues(role: Pick<RoleDefinition, "parameters">): RoleParamValues {
  return Object.fromEntries(role.parameters.map((parameter) => [
    parameter.key,
    defaultRoleParameterValue(parameter),
  ]));
}
