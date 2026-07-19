import { effortScale } from "./efforts";
import { ENGINE_MODELS, isCodexLaunchModel, normalizeClaudeLaunchModel, type AgentModelOption } from "./models";

export interface AgentReconfiguration {
  model: string;
  effort: string;
  fast: boolean | null;
  accountId?: string;
}

export function reconfigurationFromBody(
  engine: "claude" | "codex",
  body: { model?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown },
): { value?: AgentReconfiguration; error?: string } {
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const validModel = engine === "claude" ? normalizeClaudeLaunchModel(model) : isCodexLaunchModel(model) ? model : null;
  const known = (ENGINE_MODELS[engine] as readonly AgentModelOption[]).some((option) => option.id === validModel);
  if (!validModel || !known) return { error: `model is not supported by ${engine}` };

  const effort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (!effortScale(engine, validModel)?.includes(effort)) {
    return { error: `effort is not supported by ${engine} model ${validModel}` };
  }
  if (engine === "claude" && body.fast !== undefined && body.fast !== null) {
    return { error: "speed is only supported by codex" };
  }
  if (engine === "codex" && typeof body.fast !== "boolean") {
    return { error: "speed must be selected for codex" };
  }
  const accountId = body.accountId === undefined || body.accountId === null || body.accountId === ""
    ? undefined
    : typeof body.accountId === "string" ? body.accountId.trim() : "";
  if (accountId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(accountId)) {
    return { error: "account is invalid" };
  }
  return {
    value: {
      model: validModel,
      effort,
      fast: engine === "codex" ? body.fast as boolean : null,
      ...(accountId ? { accountId } : {}),
    },
  };
}
