import { activeCardMigration, cardMigrationState, migrationTargetName } from "@/lib/accounts/migration";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { ConversationMigration } from "@/lib/types";

import { isAlreadyStarted, isStageChanged, type PipelinePorts } from "./pipelinePorts";
import { pipelineEnded, stageNotStarted } from "./stagesModel";

/*
 * Account choice on the board (#1695 K6, prototype `accountChip` +
 * `openAccountPicker`), over routes that exist today:
 *
 * - A stage that has not started names the account its first turn runs on
 *   with `override-stage {account}`, guarded by the digest of the read it was
 *   chosen from (`expectedStageDigest`). The engine refuses an account the
 *   project's binding does not allow; `null` clears the pin, and the project's
 *   own selection picks the account at launch.
 * - A conversation switches with the same `reconfigure` the conversation
 *   header's account chip sends. It records the conversation's intended
 *   account, and the conversation moves with its next message (#1846); an
 *   account outside the project's accounts is allowed and recorded as the
 *   operator's choice (#1279).
 *
 * What the board may say about a pending switch comes from what reports it,
 * for every page: the conversation's migration record once the switch has
 * one, or, while a structured switch still waits behind a turn, the runtime
 * session's `pendingReconfigure` with the account it targets. Only a request
 * this page sent that neither reports yet (the answer arrived before the
 * projection, or the runtime plane is unavailable) is said to be known to this
 * page alone.
 *
 * A pending switch can be cancelled, or changed (a cancel, then a new switch
 * once the cancel is confirmed), through the conversation migration route
 * (#1705): `cancel` with the migration's revision while its record is
 * `requested` or `waiting-turn`, `withdraw` with the operation id while the
 * switch is still queued without a record. Either keeps the messages held for
 * the switch. A cancel with no answer locks this page's picker like a switch
 * with no answer: nothing is sent twice.
 */

export type AccountEngine = "claude" | "codex";

/** The stage's own pin, with an absent, `null` or blank one all meaning the project's choice. */
export function stagePin(stage: Pick<PipelineStage, "account">): string | null {
  return typeof stage.account === "string" && stage.account.trim() ? stage.account.trim() : null;
}

/* ── The project's accounts (#1279), as `GET /api/account-project-bindings?project=` answers ── */

export interface EnginePolicy {
  /** False: the project has no binding for this engine and may use every account. */
  restricted: boolean;
  allowed: ReadonlySet<string>;
}

export type ProjectPolicy =
  | { state: "loading" }
  /* The record could not be read: the server still decides every choice. */
  | { state: "unknown" }
  | { state: "known"; engines: Partial<Record<AccountEngine, EnginePolicy>> };

export function parseProjectPolicy(body: unknown): ProjectPolicy {
  const engines = (body as { engines?: Record<string, unknown> } | null)?.engines;
  if (!engines || typeof engines !== "object") return { state: "unknown" };
  const parsed: Partial<Record<AccountEngine, EnginePolicy>> = {};
  for (const engine of ["claude", "codex"] as const) {
    const raw = engines[engine] as { restricted?: unknown; allowed?: unknown } | undefined;
    if (!raw || typeof raw.restricted !== "boolean" || !Array.isArray(raw.allowed)) continue;
    const allowed = raw.allowed.flatMap((entry) => {
      const id = (entry as { accountId?: unknown } | null)?.accountId;
      return typeof id === "string" ? [id] : [];
    });
    parsed[engine] = { restricted: raw.restricted, allowed: new Set(allowed) };
  }
  return { state: "known", engines: parsed };
}

/** Where an account stands against the project's accounts: `unknown` while the record is unread. */
export function accountStanding(policy: ProjectPolicy, engine: AccountEngine, accountId: string): "inside" | "outside" | "unknown" {
  if (policy.state !== "known") return "unknown";
  const engineCase = policy.engines[engine];
  if (!engineCase) return "unknown";
  return !engineCase.restricted || engineCase.allowed.has(accountId) ? "inside" : "outside";
}

/* ── A waiting stage's account ─────────────────────────────────────────── */

export type StageAccountOutcome =
  | { kind: "saved"; account: string | null }
  /* The stage already runs on that choice: nothing was written. */
  | { kind: "same"; account: string | null }
  /* Not sent: the pipeline, or the digest that guards the write, could not be read. */
  | { kind: "unread" }
  | { kind: "missing" }
  /* The stage has started, or the pipeline ended: its first turn's account is settled. */
  | { kind: "started" }
  /* Another client changed the stage after the read; nothing was overwritten. */
  | { kind: "changed"; account: string | null }
  | { kind: "refused"; error: string }
  /* The write got no answer: it may have run. */
  | { kind: "unknown"; account: string | null };

export interface StageAccountWrite {
  pipelineId: string;
  stageId: string;
  account: string | null;
  phase: "saving" | "unconfirmed";
}

export const stageAccountKey = (pipelineId: string, stageId: string) => `${pipelineId}:${stageId}`;

class Store<T> {
  protected readonly entries = new Map<string, T>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(key: string): T | null {
    return this.entries.get(key) ?? null;
  }

  protected set(key: string, value: T | null): void {
    if (value) this.entries.set(key, value);
    else if (!this.entries.has(key)) return;
    else this.entries.delete(key);
    for (const listener of this.listeners) listener();
  }
}

export class StageAccounts extends Store<StageAccountWrite> {
  /**
   * Run the stage's first turn on `account` (`null`: the project's choice).
   * Resolves with what happened, or null while an earlier choice for the same
   * stage is still being saved.
   */
  async choose(pipelineId: string, stageId: string, account: string | null, ports: PipelinePorts): Promise<StageAccountOutcome | null> {
    const key = stageAccountKey(pipelineId, stageId);
    if (this.get(key)?.phase === "saving") return null;
    this.set(key, { pipelineId, stageId, account, phase: "saving" });
    const done = (outcome: StageAccountOutcome) => {
      this.set(key, null);
      return outcome;
    };

    const read = await ports.read(pipelineId);
    const decided = decide(read?.pipeline ?? null, stageId, account, ports);
    if (decided) return done(decided);
    const digest = read!.stageDigests[stageId];
    /* Without the stage's digest the write could not be guarded: nothing is sent. */
    if (!digest) return done({ kind: "unread" });

    const result = await ports.patch(pipelineId, { action: "override-stage", stageId, account, expectedStageDigest: digest });
    if (result.ok) return done({ kind: "saved", account });
    if (result.unknown) {
      this.set(key, { pipelineId, stageId, account, phase: "unconfirmed" });
      return { kind: "unknown", account };
    }
    if (isStageChanged(result)) {
      const again = (await ports.read(pipelineId))?.pipeline ?? null;
      ports.refresh();
      const stage = again?.stages.find((candidate) => candidate.id === stageId);
      if (!again || !stage) return done({ kind: "unread" });
      if (!stageNotStarted(again, stageId) || pipelineEnded(again)) return done({ kind: "started" });
      const now = stagePin(stage);
      return done(now === account ? { kind: "saved", account } : { kind: "changed", account: now });
    }
    if (isAlreadyStarted(result)) {
      ports.refresh();
      return done({ kind: "started" });
    }
    return done({ kind: "refused", error: result.error });
  }

  /**
   * Check a choice that got no answer by reading the stage. It settles only on
   * what the stage holds: that account (saved), or a start that settled the
   * first turn's account without it. Anything else stays unconfirmed.
   */
  async check(key: string, ports: PipelinePorts): Promise<StageAccountOutcome | null> {
    const write = this.get(key);
    if (!write || write.phase !== "unconfirmed") return null;
    const record = (await ports.read(write.pipelineId))?.pipeline ?? null;
    if (this.get(key) !== write) return null;
    const stage = record?.stages.find((candidate) => candidate.id === write.stageId);
    if (!record) return { kind: "unknown", account: write.account };
    if (!stage) {
      this.set(key, null);
      return { kind: "missing" };
    }
    ports.refresh();
    if (stagePin(stage) === write.account) {
      this.set(key, null);
      return { kind: "saved", account: write.account };
    }
    /* An override is refused once the stage has an attempt, so a started stage without the pin never took it. */
    if (!stageNotStarted(record, stage.id) || pipelineEnded(record)) {
      this.set(key, null);
      return { kind: "started" };
    }
    return { kind: "unknown", account: write.account };
  }
}

/** What a read decides before any write: null when the choice should be written. */
function decide(pipeline: Pipeline | null, stageId: string, account: string | null, ports: PipelinePorts): StageAccountOutcome | null {
  if (!pipeline) return { kind: "unread" };
  const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    ports.refresh();
    return { kind: "missing" };
  }
  if (!stageNotStarted(pipeline, stageId) || pipelineEnded(pipeline)) {
    ports.refresh();
    return { kind: "started" };
  }
  if (stagePin(stage) === account) {
    ports.refresh();
    return { kind: "same", account };
  }
  return null;
}

/* ── A conversation's account switch ───────────────────────────────────── */

/**
 * #1846: the pick an account surface on this page just made, before the
 * runtime session projects it, laid over what the board reads. It stands for
 * the conversation's intended account: the running account (a pick taken
 * back) reads as no switch at all, any other as waiting for the next message.
 * A switch a message has already engaged (a migration record waiting behind a
 * turn, or one moving) is the server's to report and is left as it is.
 */
export function withLocalPick(view: SwitchView, current: string, localPick: string | null): SwitchView {
  if (localPick === null) return view;
  if (view.kind === "switching" || (view.kind === "waiting" && view.source === "record")) return view;
  /* A view that already names this pick says more about it (known to this page only, not confirmed), except
     that a pick is never "sending": it shows as chosen before any answer. */
  if (view.kind !== "none" && view.kind !== "sending" && view.target === localPick) return view;
  return localPick === current ? { kind: "none" } : { kind: "waiting", target: localPick, source: "pick" };
}

/**
 * A pick that waits for the conversation's next message and that the runtime session projects, or that this
 * page's shared store holds (#1846): any account choice replaces it or takes it back as one reconfigure. A
 * switch known to this page alone (no runtime plane to project it) keeps the withdraw by its operation.
 */
export function isWaitingPick(view: SwitchView): boolean {
  return view.kind === "waiting" && (view.source === "runtime" || view.source === "pick");
}

/** A switch this page asked for, kept until the conversation, its migration record or its receipt settles it. */
export interface SwitchRequest {
  target: string;
  /* `sending`: no answer yet. `accepted`: the route took it. `unknown`: the request got no answer. */
  phase: "sending" | "accepted" | "unknown";
  operationId: string | null;
  /** The receipt status the route answered with, until the runtime reports the operation. */
  answeredStatus: string | null;
}

export class ConversationSwitches extends Store<SwitchRequest> {
  begin(key: string, target: string): boolean {
    if (this.get(key)) return false;
    this.set(key, { target, phase: "sending", operationId: null, answeredStatus: null });
    return true;
  }

  accept(key: string, operationId: string | null, answeredStatus: string | null): void {
    const request = this.get(key);
    if (request) this.set(key, { ...request, phase: "accepted", operationId, answeredStatus });
  }

  lost(key: string): void {
    const request = this.get(key);
    if (request) this.set(key, { ...request, phase: "unknown" });
  }

  drop(key: string): void {
    this.set(key, null);
  }
}

/** How a pending switch can be cancelled right now, if at all. */
export type CancelTarget =
  | { action: "cancel"; expectedRevision: number }
  | { action: "withdraw"; operationId: string };

const CANCELLABLE_RECORD_PHASES = new Set(["requested", "waiting-turn"]);

/**
 * The cancel a pending switch allows, from the same authorities `switchView`
 * reads: the migration record first (cancellable only while `requested` or
 * `waiting-turn`, by its revision), then a queued switch the runtime session
 * reports, then this page's own accepted request (by operation id). A switch
 * the queue is applying, or one past `waiting-turn`, has none.
 */
export function switchCancelTarget(input: {
  current: string;
  migration: ConversationMigration | null | undefined;
  request: SwitchRequest | null;
  receipt: { status: string } | null;
  pending?: RuntimePendingSwitch | null;
}): CancelTarget | null {
  const live = activeCardMigration(input.migration, input.current);
  const card = cardMigrationState(live);
  /* A failed record offers its own Retry and Keep on the conversation banner, not a cancel. */
  if (live && (card === "pending" || card === "switching" || card === "failed")) {
    return CANCELLABLE_RECORD_PHASES.has(live.phase) && Number.isInteger(live.revision)
      ? { action: "cancel", expectedRevision: live.revision! }
      : null;
  }
  const pending = input.pending ?? null;
  if (pending) {
    if (!pending.accountId || pending.accountId === input.current) return null;
    return pending.status === "applying" ? null : { action: "withdraw", operationId: pending.operationId };
  }
  const request = input.request;
  if (request?.phase !== "accepted" || !request.operationId || request.target === input.current) return null;
  const status = input.receipt?.status ?? request.answeredStatus;
  return status === null || status === "queued" || status === "pending"
    ? { action: "withdraw", operationId: request.operationId }
    : null;
}

/**
 * Which switch a cancel names, beyond the body it sends: a migration revision
 * alone repeats across a conversation's switches, so a record is named by its
 * intent, revision and target, and a queued switch by its operation.
 */
export function cancelSubject(target: CancelTarget | null, migration: ConversationMigration | null | undefined): string | null {
  if (!target) return null;
  if (target.action === "withdraw") return `operation:${target.operationId}`;
  return `record:${migration?.intentId ?? ""}:${target.expectedRevision}:${migration?.targetAccountId ?? ""}`;
}

/** A cancel of a pending switch this page sent, until it settles. */
export interface CancelRequest {
  target: string | null;
  /** The switch it cancels (`cancelSubject`). */
  subject: string;
  phase: "sending" | "unknown";
}

/**
 * The cancel this page still holds against the switch the board shows now. One
 * in flight is shown as it is. One that got no answer locks only the switch it
 * named: once the board no longer shows that switch as cancellable (rolled
 * back, started, or replaced by another), the lock ends, and nothing is
 * claimed about how it ended.
 */
export function heldCancel(cancel: CancelRequest | null, subject: string | null): CancelRequest | null {
  if (!cancel) return null;
  return cancel.phase === "sending" || cancel.subject === subject ? cancel : null;
}

export class ConversationCancels extends Store<CancelRequest> {
  /** One cancel per conversation at a time; one with no answer keeps only its own switch from a second. */
  begin(key: string, target: string | null, subject: string): boolean {
    const existing = this.get(key);
    if (existing && (existing.phase === "sending" || existing.subject === subject)) return false;
    this.set(key, { target, subject, phase: "sending" });
    return true;
  }

  lost(key: string): void {
    const cancel = this.get(key);
    if (cancel) this.set(key, { ...cancel, phase: "unknown" });
  }

  drop(key: string): void {
    this.set(key, null);
  }
}

export type CancelAnswer =
  | { kind: "cancelled" }
  /* Refused before anything was written; `retryable` when nothing about the switch was decided (the journal was unreadable). */
  | { kind: "refused"; code: string | null; error: string; retryable: boolean }
  | { kind: "unknown" };

/** `POST /api/conversations/:id/migration` with `cancel` or `withdraw`. */
export async function postSwitchCancel(conversationId: string, target: CancelTarget, fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => globalThis.fetch(input, init)): Promise<CancelAnswer> {
  let response: Response;
  try {
    response = await fetcher(`/api/conversations/${encodeURIComponent(conversationId)}/migration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target),
    });
  } catch {
    return { kind: "unknown" };
  }
  const json = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (response.ok && json) return { kind: "cancelled" };
  const error = typeof json?.error === "string" ? json.error : null;
  const code = typeof json?.code === "string" ? json.code : null;
  if (error && response.status >= 400 && response.status < 500) return { kind: "refused", code, error, retryable: false };
  /* The route answers this before it writes anything. */
  if (error && response.status === 503 && code === "RUNTIME_UNREADABLE") return { kind: "refused", code, error, retryable: true };
  return { kind: "unknown" };
}

export type SwitchAnswer =
  | { kind: "accepted"; operationId: string | null; status: string | null; outsidePool: boolean; recorded: boolean | null }
  | { kind: "refused"; error: string }
  | { kind: "unknown" };

export interface SwitchBody {
  path: string;
  conversationId: string | null;
  accountId: string;
  model: string;
  effort: string;
  fast?: boolean;
}

/**
 * `structuredControls.ts` answers this code only before it dispatches anything
 * (no runtime host client). Every other 503 there can follow a command that may
 * have reached the journal. Kept here as a literal: the client bundle must not
 * import the server module.
 */
export const RUNTIME_HOST_UNAVAILABLE_CODE = "runtime-host-unavailable";

/**
 * `POST /api/conversation-host {action: "reconfigure"}`, the request the
 * conversation header's account chip sends. Only a refusal the route gives
 * before dispatch is known: a 4xx with its error, or the 503 above. Any other
 * answer without an accepted body, and no answer at all, is unknown.
 */
export async function postConversationSwitch(body: SwitchBody, fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => globalThis.fetch(input, init)): Promise<SwitchAnswer> {
  let response: Response;
  try {
    response = await fetcher("/api/conversation-host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reconfigure", ...body }),
    });
  } catch {
    return { kind: "unknown" };
  }
  const json = (await response.json().catch(() => null)) as {
    ok?: boolean;
    operationId?: string;
    receipt?: { operationId?: string; status?: string };
    error?: string;
    accountOverride?: { outsidePool?: boolean; recorded?: boolean };
  } | null;
  if (response.ok && json?.ok) {
    return {
      kind: "accepted",
      operationId: json.operationId ?? json.receipt?.operationId ?? null,
      status: json.receipt?.status ?? null,
      outsidePool: json.accountOverride?.outsidePool === true,
      recorded: typeof json.accountOverride?.recorded === "boolean" ? json.accountOverride.recorded : null,
    };
  }
  if (typeof json?.error === "string"
    && ((response.status >= 400 && response.status < 500)
      || (response.status === 503 && (json as { code?: unknown }).code === RUNTIME_HOST_UNAVAILABLE_CODE))) {
    return { kind: "refused", error: json.error };
  }
  /* A server error after dispatch, or an answer that explains nothing: the switch may be queued. */
  return { kind: "unknown" };
}

/* `pick`: the operator's pick on this page, shared by every account surface and shown before any answer (#1846). */
export type SwitchSource = "record" | "runtime" | "page" | "pick";

/** A reconfigure the runtime session reports as queued or applying, with its operation's receipt status. */
export interface RuntimePendingSwitch {
  operationId: string;
  accountId: string | null;
  model: string;
  effort: string;
  status: string | null;
}

export type SwitchView =
  | { kind: "none" }
  | { kind: "sending"; target: string }
  /* Waits for the running turn to end. `record`: the migration says so, and holds deliveries for it.
     `runtime`: the runtime session's pending reconfigure says so. `page`: only this page's request does. */
  | { kind: "waiting"; target: string | null; source: SwitchSource }
  | { kind: "switching"; target: string | null; source: SwitchSource }
  | { kind: "failed"; target: string | null; reason: string | null }
  /* This page's request got no answer, or its receipt ended uncertain. */
  | { kind: "unknown"; target: string }
  /* A reconfigure that changes no account is pending: an account choice now would replace it. */
  | { kind: "settings"; target: null; model: string; effort: string; source: "runtime" };

export type SwitchSettlement =
  | { kind: "switched"; target: string }
  | { kind: "failed"; target: string; reason: string | null }
  | null;

const FAILED_RECEIPTS = new Set(["failed", "rejected", "interrupted"]);

/**
 * What the board may say about a conversation's account right now, and
 * whether this page's own request has settled. A switch is reported done only
 * when the conversation's account is the target.
 */
export function switchView(input: {
  current: string;
  migration: ConversationMigration | null | undefined;
  request: SwitchRequest | null;
  receipt: { status: string; reason?: string | null } | null;
  pending?: RuntimePendingSwitch | null;
}): { view: SwitchView; settle: SwitchSettlement } {
  const { current, request } = input;
  const live = activeCardMigration(input.migration, current);
  const card = cardMigrationState(live);
  const none = { kind: "none" } as const;
  if (request && request.phase !== "sending" && request.target === current) return { view: none, settle: { kind: "switched", target: request.target } };
  if (request?.phase === "sending") return { view: { kind: "sending", target: request.target }, settle: null };
  if (card === "pending") return { view: { kind: "waiting", target: migrationTargetName(live), source: "record" }, settle: null };
  if (card === "switching") return { view: { kind: "switching", target: migrationTargetName(live), source: "record" }, settle: null };
  if (card === "failed") {
    const target = migrationTargetName(live);
    return {
      view: { kind: "failed", target, reason: live?.failure ?? null },
      settle: request ? { kind: "failed", target: request.target, reason: live?.failure ?? null } : null,
    };
  }
  /* A pending reconfigure, as the runtime session projects it for every page: a switch when it names
     another account, a settings change otherwise. Either way a new account choice would replace it. */
  const pending = input.pending ?? null;
  const runtime: SwitchView | null = !pending
    ? null
    : pending.accountId && pending.accountId !== current
      ? { kind: pending.status === "applying" ? "switching" : "waiting", target: pending.accountId, source: "runtime" }
      : { kind: "settings", target: null, model: pending.model, effort: pending.effort, source: "runtime" };
  if (!request) return { view: runtime ?? none, settle: null };
  if (request.phase === "unknown") return { view: runtime ?? { kind: "unknown", target: request.target }, settle: null };
  const status = input.receipt?.status ?? request.answeredStatus;
  if (status && FAILED_RECEIPTS.has(status)) return { view: runtime ?? none, settle: { kind: "failed", target: request.target, reason: input.receipt?.reason ?? null } };
  if (status === "uncertain") return { view: runtime ?? { kind: "unknown", target: request.target }, settle: null };
  if (runtime) return { view: runtime, settle: null };
  /* Applied, but the conversation does not run on the target yet: the board waits for it to. */
  if (status === "applying" || status === "applied" || status === "delivered") return { view: { kind: "switching", target: request.target, source: "page" }, settle: null };
  return { view: { kind: "waiting", target: request.target, source: "page" }, settle: null };
}
