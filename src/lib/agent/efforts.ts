/**
 * Reasoning tiers each engine's CLI accepts, shared by the spawn UI, the API
 * validation and the command builders. Client-safe on purpose (no node:*
 * imports) — cli.ts re-exports it for server callers.
 *
 * claude: `--effort <level>` per `claude --help`.
 * codex: `-c model_reasoning_effort=<level>`; the tier list mirrors
 * `supported_reasoning_levels` in ~/.codex/models_cache.json for current models.
 */
export type AgentEngineName = "claude" | "codex";

export const ENGINE_EFFORTS: Record<AgentEngineName, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
};

export function isEngineEffort(engine: AgentEngineName, value: string): boolean {
  return (ENGINE_EFFORTS[engine] as readonly string[]).includes(value);
}

/** Canonical low→high ordering across every tier either CLI has ever recorded. */
const EFFORT_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/* Codex reasoning scales vary per model (`supported_reasoning_levels` in
   ~/.codex/models_cache.json): gpt-5.6 sol/terra add max+ultra above xhigh,
   the rest of the 5.6 family adds max, and everything older (or unknown) runs
   the classic low…xhigh. First matching prefix wins. */
const CODEX_MODEL_SCALES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^gpt-5\.6-(sol|terra)\b/, ["low", "medium", "high", "xhigh", "max", "ultra"]],
  [/^gpt-5\.6\b/, ["low", "medium", "high", "xhigh", "max"]],
];

/** Reasoning tiers a given engine+model pair can run at, lowest first; null
    for engines without a reasoning dial (shell). Model may be the viewer's
    display-shortened id — matching is prefix-based on the codex slug, and
    claude models all share one CLI scale. */
export function effortScale(engine: string, model: string | null | undefined): readonly string[] | null {
  if (engine === "claude") return ENGINE_EFFORTS.claude;
  if (engine !== "codex") return null;
  const id = (model ?? "").trim().toLowerCase();
  for (const [re, scale] of CODEX_MODEL_SCALES) {
    if (re.test(id)) return scale;
  }
  return ENGINE_EFFORTS.codex;
}

/**
 * Meter reading of a recorded tier within its own engine+model scale: `slots`
 * is the scale length, `level` the 1-based position (lowest tier = 1, top tier
 * fills the meter). A recognized tier missing from the scale — a transcript
 * from an older or newer CLI than the table knows — clamps to the nearest end
 * and remains visible. level 0 means "hide the indicator".
 */
export function effortMeter(
  engine: string,
  model: string | null | undefined,
  effort: string | null | undefined,
): { level: number; slots: number } {
  const scale = effortScale(engine, model);
  const tier = (effort ?? "").trim().toLowerCase();
  if (!scale || !tier) return { level: 0, slots: 0 };
  const slots = scale.length;
  const idx = scale.indexOf(tier);
  if (idx >= 0) return { level: idx + 1, slots };
  const rank = EFFORT_ORDER.indexOf(tier);
  if (rank < 0) return { level: 0, slots: 0 };
  const below = scale.filter((s) => EFFORT_ORDER.indexOf(s) < rank).length;
  return { level: Math.min(Math.max(below, 1), slots), slots };
}

/** Validates the optional effort/fast fields of a spawn request body. An
    invalid effort produces a client error. Fast applies to codex and stays
    unset elsewhere. */
export function reasoningFromBody(
  engine: AgentEngineName,
  body: { effort?: unknown; fast?: unknown },
): { effort: string | null; fast: boolean | null; error?: string } {
  const rawEffort = typeof body.effort === "string" ? body.effort.trim() : "";
  if (rawEffort && !isEngineEffort(engine, rawEffort)) {
    return { effort: null, fast: null, error: `effort for ${engine} must be one of: ${ENGINE_EFFORTS[engine].join(", ")}` };
  }
  const fast = engine === "codex" && typeof body.fast === "boolean" ? body.fast : null;
  return { effort: rawEffort || null, fast };
}
