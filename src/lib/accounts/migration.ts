import type { ConversationMigration } from "@/lib/types";

/**
 * Frontend adapter for the account-migration coordinator (issue #40).
 *
 * The backend coordinator (Terra) and its durable schemas (Sol's frozen
 * technical contract) are not merged in this branch — every route below is
 * frozen but may return `null`/404 until then. So this module is deliberately
 * **tolerant**: `parse*` functions accept `unknown`, validate structurally, and
 * return `null` on anything unexpected. When the annotations are absent (today's
 * reality) every projection collapses to "no migration", so the UI renders
 * exactly as it does now. This is the seam the backend merges against — all
 * wire field names and enum strings live here and nowhere else.
 */

// ── Frozen enums (Sol technical contract) ────────────────────────────────────

/** Raw per-session operation phases from the coordinator state machine. */
export type SessionMigrationPhase =
  | "requested"
  | "waiting-turn"
  | "preparing"
  | "successor-starting"
  | "verifying"
  | "committed"
  | "failed-recoverable"
  | "rolled-back";

/** The four user-visible card states the raw phases collapse to (Fable P4),
    plus `rolled-back` which shows no ribbon (the session left the intent). */
export type CardMigrationState = "pending" | "switching" | "failed" | "done" | "rolled-back";

/** Engine-wide intent lifecycle (Fable GET /api/accounts projection). */
export type EngineMigrationState = "draining" | "stopped" | "complete";

/** Author of a migration intent. Cards are origin-blind; origin only prefixes
    the banner and drives the panel/audit trail. */
export type MigrationOrigin = "manual" | "auto";

/** Quota window that bound the effective-remaining minimum. */
export type QuotaWindow = "session" | "weekly";

// ── UI-facing DTOs (what the Accounts panel binds to) ─────────────────────────

export interface MigrationCounts {
  done: number;
  waitingTurn: number;
  inFlight: number;
  failed: number;
  total: number;
}

/** Pre-migration scope counts shown in the confirm step: how many move now
    (idle) vs after their current turn (busy). */
export interface PreviewCounts {
  total: number;
  idle: number;
  busy: number;
}

export interface MigrationReason {
  window: QuotaWindow;
  fromPercent: number;
  toPercent: number;
}

/** Per-engine `migration` block on GET /api/accounts while an intent exists. */
export interface EngineMigration {
  intentId: string;
  targetId: string;
  targetLabel: string;
  revision: number;
  origin: MigrationOrigin;
  reason: MigrationReason | null;
  state: EngineMigrationState;
  counts: MigrationCounts;
  startedAt: string | null;
}

export type AutoBalanceState = "disabled" | "idle" | "waiting-fresh" | "cooldown" | "draining";

export interface AutoBalanceOutcome {
  at: string;
  kind: "switched" | "failed" | "skipped";
  fromId: string | null;
  fromPercent: number | null;
  toId: string | null;
  toPercent: number | null;
  window: QuotaWindow | null;
  detail: string | null;
}

/** Per-engine `autoBalance` block on GET /api/accounts. */
export interface AutoBalance {
  enabled: boolean;
  thresholdPercent: number;
  state: AutoBalanceState;
  cooldownUntil: string | null;
  lastCheckAt: string | null;
  lastOutcome: AutoBalanceOutcome | null;
}

/** Per-account effective remaining capacity (the min across quota windows). */
export interface AccountEffective {
  percent: number;
  window: QuotaWindow;
  freshness: "fresh" | "stale" | "unavailable";
}

/** Preview returned by POST …/active with `mode:"preview"` before any mutation. */
export interface MigrationPreview {
  targetId: string;
  targetLabel: string;
  counts: PreviewCounts;
  /** Optimistic-concurrency token echoed back on confirm. */
  previewRevision: number;
}

// ── Card-state projection (Fable §3 phase → visible state) ────────────────────

const PHASE_TO_CARD: Record<SessionMigrationPhase, CardMigrationState> = {
  requested: "switching",
  "waiting-turn": "pending",
  preparing: "switching",
  "successor-starting": "switching",
  verifying: "switching",
  committed: "done",
  "failed-recoverable": "failed",
  "rolled-back": "rolled-back",
};

/** Collapses a live per-session annotation to its visible card state, or `null`
    when there is no annotation / an unknown phase (render nothing). */
export function cardMigrationState(migration: ConversationMigration | null | undefined): CardMigrationState | null {
  if (!migration) return null;
  return PHASE_TO_CARD[migration.phase as SessionMigrationPhase] ?? null;
}

/** A card in `pending` still delivers to the live predecessor pane, but its
    interrupt/kill controls must survive; `switching` freezes them (a signal
    would race the coordinator). Held-send only applies during `switching`. */
export function migrationFreezesControls(state: CardMigrationState | null): boolean {
  return state === "switching";
}

/** True while the composer's next send should be held for the successor. */
export function migrationHoldsSends(state: CardMigrationState | null): boolean {
  return state === "switching";
}

/** What selecting an account should do, given the preview result. Every switch
    surface starts with a preview and continues through a durable migration intent.
    `recoverable-error` keeps preview failures visible for retry. Empty scope uses
    the revision-fenced migration intent path and adopts the target durably. */
export type AccountSelectOutcome = "migrate" | "confirm" | "recoverable-error";
export function accountSelectOutcome(preview: MigrationPreview | null): AccountSelectOutcome {
  if (preview === null) return "recoverable-error";
  return preview.counts.total > 0 ? "confirm" : "migrate";
}

// ── Banner projection ─────────────────────────────────────────────────────────

export interface BannerModel {
  /** `migrate.banner` primary line params. */
  targetLabel: string;
  done: number;
  total: number;
  /** Secondary count chips, each an i18n key + n. */
  waitingTurn: number;
  failed: number;
  /** Prefix the banner with the localized "Auto" tag. */
  auto: boolean;
  /** Auto-intent trigger reason for the reason sub-line, when present. */
  reason: MigrationReason | null;
  /** `draining` shows Stop; terminal states show a one-line notice instead. */
  state: EngineMigrationState;
  /** Whether the whole intent has drained (banner announces completion once). */
  complete: boolean;
}

/** Projects the per-engine migration block to a banner model, or `null` when no
    intent exists. Pure so the announcement/derived state is unit-testable. */
export function bannerModel(migration: EngineMigration | null): BannerModel | null {
  if (!migration) return null;
  const { counts } = migration;
  return {
    targetLabel: migration.targetLabel,
    done: counts.done,
    total: counts.total,
    waitingTurn: counts.waitingTurn,
    failed: counts.failed,
    auto: migration.origin === "auto",
    reason: migration.reason,
    state: migration.state,
    complete: migration.state === "complete",
  };
}

// ── Auto-balance status-line projection ───────────────────────────────────────

export type AutoBalanceLineKind =
  | "hidden"
  | "idle"
  | "waitingFresh"
  | "cooldown"
  | "draining"
  | "switched";

export interface AutoBalanceLine {
  kind: AutoBalanceLineKind;
  /** i18n params for the chosen line's message key. */
  params: Record<string, string | number>;
}

const MINUTE_MS = 60_000;

/** Local HH:MM formatting shared by cooldown/idle lines; injected clock keeps
    it testable. */
function hhmm(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Resolves the single auto-balance status line (Fable §8.4). Returns `hidden`
 * when the control should show only its description (disabled, or enabled with
 * nothing to report). `nowMs`/`locale` are injected so the projection is pure.
 */
export function autoBalanceLine(
  auto: AutoBalance | null,
  nowMs: number,
  locale: string,
): AutoBalanceLine {
  if (!auto || !auto.enabled) return { kind: "hidden", params: {} };
  // A recorded switch outcome takes precedence: it is the durable explanation
  // the operator reads after a hands-free migration, and it survives restart.
  const outcome = auto.lastOutcome;
  if (auto.state === "draining") return { kind: "draining", params: {} };
  if (auto.state === "cooldown" && auto.cooldownUntil) {
    const remaining = Math.max(1, Math.ceil((new Date(auto.cooldownUntil).getTime() - nowMs) / MINUTE_MS));
    return { kind: "cooldown", params: { n: remaining } };
  }
  if (auto.state === "waiting-fresh") return { kind: "waitingFresh", params: {} };
  if (outcome && outcome.kind === "switched" && outcome.toId && outcome.fromId) {
    return {
      kind: "switched",
      params: {
        to: outcome.toId,
        from: outcome.fromId,
        pct: Math.round(outcome.fromPercent ?? 0),
        window: outcome.window ?? "session",
        time: outcome.at ? hhmm(outcome.at, locale) : "",
      },
    };
  }
  if (auto.state === "idle") {
    return { kind: "idle", params: { time: auto.lastCheckAt ? hhmm(auto.lastCheckAt, locale) : "" } };
  }
  return { kind: "hidden", params: {} };
}

// ── Tolerant parsers ──────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseCounts(raw: unknown): MigrationCounts {
  const record = asRecord(raw) ?? {};
  return {
    done: num(record.done),
    waitingTurn: num(record.waitingTurn),
    inFlight: num(record.inFlight),
    failed: num(record.failed),
    total: num(record.total),
  };
}

function parseReason(raw: unknown): MigrationReason | null {
  const record = asRecord(raw);
  if (!record) return null;
  const window = record.window === "weekly" ? "weekly" : record.window === "session" ? "session" : null;
  if (!window) return null;
  return { window, fromPercent: num(record.fromPercent), toPercent: num(record.toPercent) };
}

const ENGINE_STATES = new Set<EngineMigrationState>(["draining", "stopped", "complete"]);

/** Parses the per-engine `migration` block; `null` when absent or invalid. */
export function parseEngineMigration(raw: unknown): EngineMigration | null {
  const record = asRecord(raw);
  if (!record) return null;
  const intentId = str(record.intentId);
  const targetId = str(record.targetId);
  if (!intentId || !targetId) return null;
  const state = ENGINE_STATES.has(record.state as EngineMigrationState) ? (record.state as EngineMigrationState) : "draining";
  return {
    intentId,
    targetId,
    targetLabel: str(record.targetLabel) ?? targetId,
    revision: num(record.revision),
    origin: record.origin === "auto" ? "auto" : "manual",
    reason: parseReason(record.reason),
    state,
    counts: parseCounts(record.counts),
    startedAt: str(record.startedAt),
  };
}

const AUTO_STATES = new Set<AutoBalanceState>(["disabled", "idle", "waiting-fresh", "cooldown", "draining"]);

function parseOutcome(raw: unknown): AutoBalanceOutcome | null {
  const record = asRecord(raw);
  if (!record) return null;
  const at = str(record.at);
  if (!at) return null;
  const kind = record.kind === "failed" ? "failed" : record.kind === "skipped" ? "skipped" : "switched";
  const window = record.window === "weekly" ? "weekly" : record.window === "session" ? "session" : null;
  return {
    at,
    kind,
    fromId: str(record.fromId),
    fromPercent: typeof record.fromPercent === "number" ? record.fromPercent : null,
    toId: str(record.toId),
    toPercent: typeof record.toPercent === "number" ? record.toPercent : null,
    window,
    detail: str(record.detail),
  };
}

/** Parses the per-engine `autoBalance` block; `null` when absent or invalid. */
export function parseAutoBalance(raw: unknown): AutoBalance | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.enabled !== "boolean") return null;
  const state = AUTO_STATES.has(record.state as AutoBalanceState) ? (record.state as AutoBalanceState) : "idle";
  return {
    enabled: record.enabled,
    thresholdPercent: num(record.thresholdPercent, 25),
    state: record.enabled ? state : "disabled",
    cooldownUntil: str(record.cooldownUntil),
    lastCheckAt: str(record.lastCheckAt),
    lastOutcome: parseOutcome(record.lastOutcome),
  };
}

/** Parses a per-account `effective` capacity block; `null` when unknown. */
export function parseEffective(raw: unknown): AccountEffective | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.percent !== "number" || !Number.isFinite(record.percent)) return null;
  const window = record.window === "weekly" ? "weekly" : "session";
  const freshness = record.freshness === "fresh" ? "fresh" : record.freshness === "stale" ? "stale" : "unavailable";
  return { percent: record.percent, window, freshness };
}

/** The canonical result of a per-card recovery call: whether the coordinator
    accepted it, plus a secret-free error string for the actionable failure line
    (finding 3 — recovery failures must be surfaced, not swallowed). */
export interface ConversationMigrationResult {
  ok: boolean;
  /** Public failure detail from the route, safe to show; null on success. */
  error: string | null;
}

/**
 * Per-conversation recovery against the frozen route
 * `POST /api/conversations/{conversationId}/migration` (Sol contract): `retry`
 * re-runs the migration for one conversation against the supplied intent
 * revision; `rollback` (the card's "Keep on «A»") removes the session from the
 * intent and leaves the predecessor authoritative. Keyed by the stable Viewer
 * `conversationId` — never the transcript path, which changes on succession.
 * The result is returned (not swallowed) so the card can show an actionable,
 * announced failure; the ribbon still reconciles from the next `/api/files`
 * poll on success.
 */
export async function postConversationMigration(
  conversationId: string,
  action: "retry" | "rollback",
  expectedRevision?: number,
): Promise<ConversationMigrationResult> {
  if (!conversationId.startsWith("conversation_")) return { ok: false, error: null };
  if (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0) return { ok: false, error: null };
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/migration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, expectedRevision }),
    });
    if (response.ok) return { ok: true, error: null };
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { ok: false, error: str(body?.error) };
  } catch {
    return { ok: false, error: null };
  }
}

/**
 * Parses a preview response from POST …/active `mode:"preview"`.
 *
 * The route is the canonical migration seam; whether the coordinator echoes a
 * rich target-aware DTO (`{ targetId, targetLabel, counts,
 * previewRevision }`) or the leaner counts-and-revision shape, the client
 * already knows which account it asked to preview, so `fallback` supplies the
 * target identity/label the response may omit. That is what lets the confirm
 * step render with the requested target identity. `null` represents a genuinely
 * failed preview and the caller presents a recoverable retry.
 */
export function parseMigrationPreview(
  raw: unknown,
  fallback?: { targetId: string; targetLabel?: string },
): MigrationPreview | null {
  const record = asRecord(raw);
  if (!record) return null;
  const intent = asRecord(record.intent);
  const targetId = str(record.targetId ?? intent?.targetId) ?? fallback?.targetId ?? null;
  if (!targetId) return null;
  const counts = asRecord(record.counts ?? intent?.counts) ?? record;
  return {
    targetId,
    targetLabel: str(record.targetLabel ?? intent?.targetLabel) ?? fallback?.targetLabel ?? targetId,
    counts: { total: num(counts.total), idle: num(counts.idle), busy: num(counts.busy) },
    previewRevision: num(record.previewRevision ?? record.revision ?? intent?.revision),
  };
}
