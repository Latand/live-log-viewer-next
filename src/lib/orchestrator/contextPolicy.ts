/* Context-window rotation policy (operator decision, two-axis contract).
 *
 * Window sizes come from the scanner's model registry. The rotation threshold
 * is expressed here as a FRACTION of the registered window, so adding a model
 * window does not create a second orchestrator configuration seam. Reference
 * case, operator-stated: a registered 1,000,000-token Claude Opus window
 * rotates at 500,000 tokens — exactly the fraction applied to its window.
 *
 * A model with no entry has NO window invented for it: callers report the
 * usage they can prove and say plainly that the threshold is unknown.
 *
 * Crossing a threshold changes WORDS in get_orchestrator's payload and
 * nothing else — see `./health`, whose recommendation carries no action.
 */

import { normalizeModelKey, registryWindow } from "../scanner/modelRegistry";

export const ROTATION_THRESHOLD_FRACTION = 0.5;

export interface ContextWindowPolicy {
  /** Nominal context window, tokens. */
  windowTokens: number;
  /** Absolute rotation threshold: `windowTokens * ROTATION_THRESHOLD_FRACTION`. */
  rotationThresholdTokens: number;
  /** Which policy row matched, for the payload's own audit trail. */
  policy: string;
}

function policyWindowName(windowTokens: number): string {
  if (windowTokens % 1_000_000 === 0) return `${windowTokens / 1_000_000}m`;
  if (windowTokens % 1_000 === 0) return `${windowTokens / 1_000}k`;
  return `${windowTokens}-tokens`;
}

/** The window policy for a model, or null when none is configured — in which
    case NO window may be assumed anywhere downstream. */
export function contextWindowPolicyFor(engine: string | null, model: string | null): ContextWindowPolicy | null {
  if (engine !== "claude" || !model) return null;
  const normalized = normalizeModelKey(model);
  if (!normalized) return null;
  const windowTokens = registryWindow(normalized.key, normalized.mode);
  if (windowTokens === null) return null;
  return {
    windowTokens,
    rotationThresholdTokens: Math.round(windowTokens * ROTATION_THRESHOLD_FRACTION),
    policy: `registry:${normalized.key}:${policyWindowName(windowTokens)}`,
  };
}
