/* Context-window rotation policy (operator decision, two-axis contract).
 *
 * THE one place window sizes and rotation thresholds live — product
 * configuration, not scattered literals. The threshold is expressed as a
 * FRACTION of the model's window: it stays meaningful across window sizes, so
 * adding a model needs only its window, while every absolute number below is
 * explicit and reviewable. Reference case, operator-stated: the Claude Opus
 * orchestrator has a nominal 1,000,000-token window and rotates at
 * 500,000 tokens — exactly the fraction applied to its window.
 *
 * A model with no entry has NO window invented for it: callers report the
 * usage they can prove and say plainly that the threshold is unknown.
 *
 * Crossing a threshold changes WORDS in get_orchestrator's payload and
 * nothing else — see `./health`, whose recommendation carries no action.
 */

export const ROTATION_THRESHOLD_FRACTION = 0.5;

export interface ContextWindowPolicy {
  /** Nominal context window, tokens. */
  windowTokens: number;
  /** Absolute rotation threshold: `windowTokens * ROTATION_THRESHOLD_FRACTION`. */
  rotationThresholdTokens: number;
  /** Which policy row matched, for the payload's own audit trail. */
  policy: string;
}

interface ContextWindowRule {
  policy: string;
  matches(engine: string, model: string): boolean;
  windowTokens: number;
}

/** First match wins; more specific rows come first. */
const CONTEXT_WINDOW_RULES: readonly ContextWindowRule[] = [
  {
    /* The operator's reference case: Opus-class orchestrators. `opus` is this
       repo's latest-Opus alias (see `@/lib/agent/models`), and dated Opus model
       ids carry the substring too. */
    policy: "claude-opus-1m",
    matches: (engine, model) => engine === "claude" && model.toLowerCase().includes("opus"),
    windowTokens: 1_000_000,
  },
  {
    /* Every other managed Claude model: the standard published window. */
    policy: "claude-standard-200k",
    matches: (engine) => engine === "claude",
    windowTokens: 200_000,
  },
  /* No Codex row on purpose: Codex windows vary by account tier and are not
     knowable here. Absent means unknown, never a guess. */
];

/** The window policy for a model, or null when none is configured — in which
    case NO window may be assumed anywhere downstream. */
export function contextWindowPolicyFor(engine: string | null, model: string | null): ContextWindowPolicy | null {
  if (!engine) return null;
  const rule = CONTEXT_WINDOW_RULES.find((candidate) => candidate.matches(engine, model ?? ""));
  if (!rule) return null;
  return {
    windowTokens: rule.windowTokens,
    rotationThresholdTokens: Math.round(rule.windowTokens * ROTATION_THRESHOLD_FRACTION),
    policy: rule.policy,
  };
}
