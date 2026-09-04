/** Curated model choices shown by the viewer's agent-launch surfaces. */
export type AgentModelOption = {
  id: string;
  label: string;
  /** Compact face label for the composer runtime pill (issue #390 §3.1); the
      full `label` stays in menu rows and accessible names. */
  shortLabel: string;
  use: "implement" | "review" | "general";
};

export const CODEX_ASTRA_MODEL = "gpt-6-astra";
export const CODEX_SOL_MODEL = "gpt-5.6-sol";
export const CODEX_TERRA_MODEL = "gpt-5.6-terra";
export const CODEX_LUNA_MODEL = "gpt-5.6-luna";

const CODEX_IMAGE_INPUT_MODELS = new Set([
  CODEX_ASTRA_MODEL,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  CODEX_LUNA_MODEL,
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

/** Current app-server model/list image modalities, used for pre-spawn admission. */
export function codexModelSupportsImages(model: string | null | undefined): boolean {
  if (!model?.trim()) return true;
  return CODEX_IMAGE_INPUT_MODELS.has(model.trim());
}

export const ENGINE_MODELS: Record<"claude" | "codex", readonly AgentModelOption[]> = {
  claude: [
    { id: "opus", label: "Opus 5", shortLabel: "Opus 5", use: "review" },
    { id: "fable", label: "Fable", shortLabel: "Fable", use: "general" },
    { id: "sonnet", label: "Sonnet", shortLabel: "Sonnet", use: "implement" },
    { id: "haiku", label: "Haiku", shortLabel: "Haiku", use: "general" },
  ],
  codex: [
    // Astra leads the list because it is the account's own default, and the
    // head is what runtimeProfile falls back to for a conversation on an
    // uncatalogued model — it agrees with defaultModelFor below. Its `review`
    // use is shared with Sol on purpose: the account describes Astra as its
    // most capable model, and Sol keeps the role it already held, having been
    // left in the list with no upgrade target.
    { id: CODEX_ASTRA_MODEL, label: "GPT-6-Astra", shortLabel: "6-Astra", use: "review" },
    { id: CODEX_SOL_MODEL, label: "GPT-5.6-Sol", shortLabel: "5.6-Sol", use: "review" },
    { id: CODEX_TERRA_MODEL, label: "GPT-5.6-Terra", shortLabel: "5.6-Terra", use: "implement" },
    { id: CODEX_LUNA_MODEL, label: "GPT-5.6-Luna", shortLabel: "5.6-Luna", use: "general" },
  ],
};

export type LaunchModelValidation = { model: string } | { error: string };

/** Validate a fresh-launch model against the catalog rendered by the Viewer.
    Resume and migration paths deliberately do not call this helper. */
export function validateLaunchModel(engine: "claude" | "codex", model: string): LaunchModelValidation {
  const requested = model.trim();
  const validIds = ENGINE_MODELS[engine].map((option) => option.id);
  if (validIds.includes(requested)) return { model: requested };
  return {
    error: `invalid ${engine} model id ${JSON.stringify(requested)}; valid ${engine} model ids: ${validIds.join(", ")}`,
  };
}

/** A fresh Codex conversation starts on the architecture/review profile —
    the model the account itself reports as default. */
export function defaultModelFor(engine: "claude" | "codex"): string {
  return engine === "codex" ? CODEX_ASTRA_MODEL : "opus";
}

const CLAUDE_MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ClaudeLaunchModel = (typeof CLAUDE_MODEL_FAMILIES)[number];

/**
 * Claude transcripts preserve provider model provenance, including dated ids
 * that the installed CLI may reject as launch arguments. Resume and migration
 * succession share this bounded family projection. Unknown ids intentionally
 * omit `--model`, allowing native resume semantics to choose a supported model.
 */
export function normalizeClaudeLaunchModel(value: string | null | undefined): ClaudeLaunchModel | null {
  if (typeof value !== "string") return null;
  const model = value.trim().toLowerCase();
  if (!model || model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) return null;
  for (const family of CLAUDE_MODEL_FAMILIES) {
    if (model === family || new RegExp(`(?:^|[-_.])${family}(?:[-_.]|$)`).test(model)) return family;
  }
  return null;
}

/** Claude launch families the provider meters on the flagship tier's own
    weekly window (issue #1358). Opus and Fable both belong there: the bucket
    Anthropic reports as `seven_day_opus` is the top-tier weekly, and a Fable
    spawn is gated by it even when the general week is comfortable. */
const CLAUDE_FLAGSHIP_FAMILIES: ReadonlySet<ClaudeLaunchModel> = new Set(["fable", "opus"]);

/** Whether a Claude spawn of `model` draws on the flagship weekly window. An
    unknown or absent model resolves to the launch default, which is flagship
    class, so "no model chosen" is gated conservatively. */
export function claudeModelGatedByFlagshipWeekly(model: string | null | undefined): boolean {
  const family = normalizeClaudeLaunchModel(model);
  if (family === null) return true;
  return CLAUDE_FLAGSHIP_FAMILIES.has(family);
}

const CLAUDE_TIER_DISPLAY: Record<string, string> = { fable: "Fable", mythos: "Mythos", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

/** Display name of a provider tier bucket (`opus` → "Opus"); unknown tiers
    are capitalised as spelled so a new bucket still reads as a name. */
export function claudeTierDisplayName(tier: string): string {
  const key = tier.trim().toLowerCase();
  if (CLAUDE_TIER_DISPLAY[key]) return CLAUDE_TIER_DISPLAY[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : tier;
}

/** True when a model id is a valid codex launch model: a `gpt-*` id, printable
    and within the CLI length bound. Shared by the API's pipeline validator and
    the builder's client-side pre-check so a valid-looking submission never 400s
    on a bound the client failed to mirror. */
export function isCodexLaunchModel(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const model = value.trim();
  return model.startsWith("gpt-") && model.length <= 128 && !/[\u0000-\u001f\u007f]/.test(model);
}

/** Model ids travel to a shell-quoted CLI argument. Keep them bounded and printable. */
export function modelFromBody(body: { model?: unknown }): { model: string | null; error?: string } {
  if (body.model === undefined || body.model === null || body.model === "") return { model: null };
  if (typeof body.model !== "string") return { model: null, error: "model must be a string" };
  const model = body.model.trim();
  if (!model) return { model: null };
  if (model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) {
    return { model: null, error: "model must be a printable id up to 128 characters" };
  }
  return { model };
}
