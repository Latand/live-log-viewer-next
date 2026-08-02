import { hardenedRedact } from "@/lib/view/compactText";

/**
 * The one lifecycle vocabulary shared by the liveness snapshot (#645) and the
 * durable event journal with its relay digests (#686). Both surfaces consume
 * these states and event types; neither maintains a competing status model, so
 * an orchestrator reading a snapshot and an agent reading a digest are always
 * talking about the same thing.
 */
export const LIFECYCLE_STATES = [
  /** Admitted, no host evidence yet. */
  "starting",
  /** A host is alive and the turn is progressing. */
  "running",
  /** A host is alive and idle — the agent is awaiting input. */
  "waiting",
  /** The turn can no longer progress on its own: a silent transcript under a
      live host, or an open turn whose host is gone (the zombie). */
  "stalled",
  /** Work finished with a pass verdict. */
  "completed",
  /** Work finished with a fail verdict or a hard error. */
  "failed",
  /** Parked for an operator decision. */
  "blocked",
  /** The host exited and the turn was already settled. */
  "gone",
] as const;

export type LifecycleState = typeof LIFECYCLE_STATES[number];

/** Turn evidence as both surfaces report it, straight from the transcript. */
export type LifecycleTurnState = "busy" | "idle" | "unknown";

export const LIFECYCLE_EVENT_TYPES = [
  "stage_started",
  "stage_resumed",
  "stage_paused",
  "stage_completed",
  "stage_failed",
  "stage_blocked",
  "review_verdict",
  "repair_ready",
  "deploy_ready",
  "deploy_succeeded",
  "deploy_failed",
  "delivery_held",
  "delivery_queued",
  "delivery_delivered",
  "delivery_expired",
  "agent_stalled",
  "agent_gone",
  "agent_resumed",
] as const;

export type LifecycleEventType = typeof LIFECYCLE_EVENT_TYPES[number];

/** Every event type maps onto exactly one lifecycle state — that mapping is the
    reason there is only one vocabulary rather than two parallel ones. */
export const LIFECYCLE_STATE_FOR_EVENT: Record<LifecycleEventType, LifecycleState> = {
  stage_started: "running",
  stage_resumed: "running",
  stage_paused: "waiting",
  stage_completed: "completed",
  stage_failed: "failed",
  stage_blocked: "blocked",
  review_verdict: "completed",
  repair_ready: "waiting",
  deploy_ready: "waiting",
  deploy_succeeded: "completed",
  deploy_failed: "failed",
  delivery_held: "waiting",
  delivery_queued: "waiting",
  delivery_delivered: "completed",
  delivery_expired: "failed",
  agent_stalled: "stalled",
  agent_gone: "gone",
  agent_resumed: "running",
};

/**
 * Terminal, high-signal events. They bypass the routine digest rate limit
 * because the operator (or the waiting agent) cannot make its next decision
 * without them: a review verdict, a stage that reached a terminal state, a
 * deploy outcome, and a delivery that was held or expired instead of landing.
 */
export const TERMINAL_HIGH_SIGNAL_EVENT_TYPES: ReadonlySet<LifecycleEventType> = new Set<LifecycleEventType>([
  "stage_completed",
  "stage_failed",
  "stage_blocked",
  "review_verdict",
  "deploy_succeeded",
  "deploy_failed",
  "delivery_held",
  "delivery_expired",
]);

export function isTerminalHighSignalEvent(type: LifecycleEventType): boolean {
  return TERMINAL_HIGH_SIGNAL_EVENT_TYPES.has(type);
}

export function isLifecycleEventType(value: unknown): value is LifecycleEventType {
  return typeof value === "string" && (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(value);
}

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === "string" && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** Hard cap for anything that reaches a journal summary or a relay digest. */
export const LIFECYCLE_SUMMARY_MAX_LENGTH = 200;

/** Fenced blocks are command output, diffs, verdict JSON and pasted logs — the
    exact material that must never reach another agent's context, so the first
    meaningful line is taken from outside every fence. */
const FENCE = /^\s*(?:```|~~~)/;
/** A line has to carry a letter or digit to be a "meaningful" result line;
    separators, bullets and bare punctuation do not qualify. */
const MEANINGFUL = /[\p{L}\p{N}]/u;

/**
 * Bounds and redacts one operator-safe line for a journal summary or a digest
 * item. Everything sensitive is removed before the bound, never after: secrets
 * are redacted, fenced blocks are dropped whole, and only the first meaningful
 * prose line survives. Raw long outputs can never enter through here.
 */
export function operatorSafeSummary(value: string | null | undefined, limit = LIFECYCLE_SUMMARY_MAX_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const redacted = hardenedRedact(value);
  let fenced = false;
  for (const rawLine of redacted.split(/\r?\n/)) {
    if (FENCE.test(rawLine)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || !MEANINGFUL.test(line)) continue;
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  }
  return "";
}
