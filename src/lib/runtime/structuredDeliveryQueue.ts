import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { parseMessageOrigin, type MessageOrigin } from "./messageOrigin";
import type { RuntimeSendSettings } from "./contracts";
import { evidenceAgrees, readEvidence, readOptionalEvidence, type Evidence } from "./evidence";
import type { CompactCapableHost, DeliveryReceipt, EngineHost, HostState, QueueEntry } from "./engineHost";
import { hostSupportsCompact, StructuredCompactError } from "./engineHost";
import {
  parseStructuredImageRefs,
  structuredContent,
  type StructuredMessageContent,
} from "./structuredContent";

export interface StructuredDeliveryEffect {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  eventSeq: number;
}

export type StructuredDeliveryTransition = "queued" | "delivering" | "applying" | "delivered" | "applied" | "answered" | "interrupted" | "failed" | "uncertain";

interface StructuredOperationStatus {
  status: string;
  reason?: string | null;
  /** Immutable admission time on current receipts; `at` supports older rows. */
  admittedAt?: string;
  at?: string;
}

export interface StructuredDeliveryQueuePort {
  effects(kinds?: readonly string[], afterEventSeq?: number): Promise<StructuredDeliveryEffect[]>;
  transition(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: { turnId?: string | null; reason?: string | null },
  ): Promise<void>;
  /** The durable receipt state, when the port can read it. The compact control
      needs it to tell a control it must issue from one an earlier executor
      already issued and never settled (#862), and the message path reads the
      ownership its own `delivering` write recorded back off the reason.

      Every one of the three reads below is FAILABLE — as is the live host's
      own state, read through the same type — and none of them may be converted
      into a definite answer when it fails. An unreadable fence is not an open
      one: it blocks this pass instead of authorising it (#1131). */
  status?(operationId: string): Promise<StructuredOperationStatus | null>;
  /** Whether the durable DELIVERY RECORD has already ended this send (#1131).
      The journal cannot answer that during the outage in which it is written,
      which is exactly when it has to be honoured. */
  settled?(operationId: string): boolean | Promise<boolean>;
  /** The writer claim that currently owns this conversation's structured host —
      the durable answer to "who may write to the engine right now" (#1131).
      Recorded when a send enters delivery and compared when one is found still
      there, so a `delivering` row is called abandoned on evidence that
      ownership CHANGED rather than on its mere existence. Absent port, absent
      claim, or a read that throws: no evidence either way, which leaves the row
      with the executor that holds it rather than ending its send. */
  hostClaim?(conversationId: string): string | null | Promise<string | null>;
}

export type StructuredHostResolver = (conversationId: string) => EngineHost | null;
export type StructuredHostRecovery = (conversationId: string) => Promise<boolean>;
export type StructuredKillRefusal = (conversationId: string) => string | null | Promise<string | null>;

const STRUCTURED_DELIVERY_BATCH_SIZE = 100;
const THREAD_READ_ATTEMPTS = 2;
/** Controls carry no message reservation to settle them outside the journal,
    so the queue itself gives every accepted control a terminal ceiling. */
export const CONTROL_SETTLEMENT_WINDOW_MS = 2 * 60_000;
const TERMINAL_DELIVERY_STATUSES = new Set([
  "turn-started",
  "steered",
  "delivered",
  "applied",
  "interrupted",
  "answered",
  "rejected",
  "failed",
  "uncertain",
]);

interface SendEffect {
  operationId: string;
  conversationId: string;
  content: StructuredMessageContent;
  contentDigest: string;
  turnId?: string | null;
  policy?: "queue" | "steer-if-active" | "interrupt-active";
  kind: "send" | "steer";
  runtime?: RuntimeSendSettings;
  /** #844: the selected-card reference the operator submitted with. Replayed
      from the durable payload, never re-read from a live view. */
  selectedContext?: SelectedContextRef;
  /** #1117: authorship stamped at admission, replayed from the durable payload. */
  origin?: MessageOrigin;
  eventSeq: number;
}

/** The per-turn runtime snapshot off a durable send effect (issue #390 §10).
    A malformed field drops silently — absent settings mean today's behavior,
    and a settings blemish must never strand the message itself. */
function runtimeSendSettings(value: unknown): RuntimeSendSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const settings: RuntimeSendSettings = {};
  if (typeof body.model === "string" && body.model) settings.model = body.model;
  if (typeof body.effort === "string" && body.effort) settings.effort = body.effort;
  if (typeof body.fast === "boolean") settings.fast = body.fast;
  return Object.keys(settings).length ? settings : undefined;
}

interface ControlEffect {
  operationId: string;
  conversationId: string;
  kind: "answer" | "interrupt" | "kill";
  attentionId?: string;
  resolution?: unknown;
  turnId?: string | null;
  sessionKey?: { engine: "codex" | "claude"; sessionId: string };
  eventSeq: number;
}

/** A manual compaction (#862): a control fenced to one owned generation that
    carries no content, so nothing on it can be replayed as user input. */
interface CompactEffect {
  operationId: string;
  conversationId: string;
  kind: "compact";
  sessionKey: { engine: "codex" | "claude"; sessionId: string };
  eventSeq: number;
}

export interface StructuredReconfigureEffect {
  operationId: string;
  conversationId: string;
  kind: "reconfigure";
  sessionKey?: { engine: "codex" | "claude"; sessionId: string };
  model: string;
  effort: string;
  fast: boolean | null;
  accountId?: string;
  previousProfile?: { model: string | null; effort: string | null; fast: boolean | null };
  eventSeq: number;
}

export interface StructuredReconfigureOwnership {
  isCurrent(): Promise<boolean>;
}

export type StructuredReconfigureHandler = (
  effect: StructuredReconfigureEffect,
  ownership: StructuredReconfigureOwnership,
) => Promise<void | "applied" | "pending">;

type DeliveryEffect = SendEffect | ControlEffect | CompactEffect | StructuredReconfigureEffect;

interface ControlDrainResult {
  blocked: boolean;
  terminated: boolean;
}

interface SuccessfulKillBoundary {
  operationId: string;
  conversationId: string;
  eventSeq: number;
}

function isControlEffect(effect: DeliveryEffect): effect is ControlEffect | CompactEffect {
  return effect.kind === "answer" || effect.kind === "interrupt" || effect.kind === "kill" || effect.kind === "compact";
}

function isCompactEffect(effect: DeliveryEffect): effect is CompactEffect {
  return effect.kind === "compact";
}

function isReconfigureEffect(effect: DeliveryEffect): effect is StructuredReconfigureEffect {
  return effect.kind === "reconfigure";
}

function isRuntimeControlEffect(
  effect: DeliveryEffect,
): effect is ControlEffect | CompactEffect | StructuredReconfigureEffect {
  return isControlEffect(effect) || isReconfigureEffect(effect);
}

function controlSettlementDeadlineAt(receipt: StructuredOperationStatus | null): number | null {
  if (!receipt) return null;
  const admittedAt = Date.parse(receipt.admittedAt ?? receipt.at ?? "");
  return Number.isFinite(admittedAt) ? admittedAt + CONTROL_SETTLEMENT_WINDOW_MS : null;
}

function expiredControlSettlement(
  effect: ControlEffect | CompactEffect | StructuredReconfigureEffect,
  receipt: StructuredOperationStatus | null,
  now = Date.now(),
): { status: "failed" | "uncertain"; reason: string } | null {
  if (!receipt) return null;
  const deadlineAt = controlSettlementDeadlineAt(receipt);
  if (deadlineAt === null || now < deadlineAt) return null;
  const action = effect.kind;
  if (receipt.status === "delivering" || receipt.status === "applying") {
    return {
      status: "uncertain",
      reason: `${action} control exceeded its 2-minute settlement deadline after actuation began; verify the conversation state before retrying`,
    };
  }
  return {
    status: "failed",
    reason: `${action} control exceeded its 2-minute settlement deadline; retry from the current conversation state`,
  };
}

function sendEffect(effect: StructuredDeliveryEffect): SendEffect | null {
  if (effect.kind !== "runtime.send" && effect.kind !== "runtime.steer") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const text = typeof effect.payload.text === "string" ? effect.payload.text : "";
  const images = effect.payload.images === undefined ? [] : parseStructuredImageRefs(effect.payload.images, 16);
  if (!operationId || !conversationId || !images) return null;
  let content;
  try { content = structuredContent(text, images); } catch { return null; }
  if (typeof effect.payload.contentDigest === "string" && effect.payload.contentDigest !== content.contentDigest) return null;
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  const policy = effect.payload.policy === "queue"
    || effect.payload.policy === "steer-if-active"
    || effect.payload.policy === "interrupt-active"
    ? effect.payload.policy
    : undefined;
  const runtime = runtimeSendSettings(effect.payload.runtime);
  /* A malformed reference drops the same way malformed settings do: the
     message must never be stranded by its own provenance. */
  const selectedContext = parseSelectedContextRef(effect.payload.selectedContext);
  const origin = parseMessageOrigin(effect.payload.origin);
  return {
    operationId,
    conversationId,
    content: content.content,
    contentDigest: content.contentDigest,
    kind: effect.kind === "runtime.steer" ? "steer" : "send",
    eventSeq: effect.eventSeq,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(policy ? { policy } : {}),
    ...(runtime ? { runtime } : {}),
    ...(selectedContext ? { selectedContext } : {}),
    ...(origin ? { origin } : {}),
  };
}

function controlEffect(effect: StructuredDeliveryEffect): ControlEffect | null {
  if (effect.kind !== "runtime.answer" && effect.kind !== "runtime.interrupt" && effect.kind !== "runtime.kill") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  if (!operationId || !conversationId) return null;
  if (effect.kind === "runtime.answer") {
    const attentionId = typeof effect.payload.attentionId === "string" ? effect.payload.attentionId : "";
    if (!attentionId || !("resolution" in effect.payload)) return null;
    return { operationId, conversationId, kind: "answer", attentionId, resolution: effect.payload.resolution, eventSeq: effect.eventSeq };
  }
  if (effect.kind === "runtime.kill") {
    const key = effect.payload.sessionKey;
    if (!key || typeof key !== "object" || Array.isArray(key)) return null;
    const candidate = key as Record<string, unknown>;
    if ((candidate.engine !== "codex" && candidate.engine !== "claude") || typeof candidate.sessionId !== "string") return null;
    return {
      operationId,
      conversationId,
      kind: "kill",
      sessionKey: { engine: candidate.engine, sessionId: candidate.sessionId },
      eventSeq: effect.eventSeq,
    };
  }
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  return { operationId, conversationId, kind: "interrupt", eventSeq: effect.eventSeq, ...(turnId !== undefined ? { turnId } : {}) };
}

function compactEffect(effect: StructuredDeliveryEffect): CompactEffect | null {
  if (effect.kind !== "runtime.compact") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const key = effect.payload.sessionKey;
  if (!operationId || !conversationId || !key || typeof key !== "object" || Array.isArray(key)) return null;
  const candidate = key as Record<string, unknown>;
  if ((candidate.engine !== "codex" && candidate.engine !== "claude") || typeof candidate.sessionId !== "string") return null;
  return {
    operationId,
    conversationId,
    kind: "compact",
    sessionKey: { engine: candidate.engine, sessionId: candidate.sessionId },
    eventSeq: effect.eventSeq,
  };
}

function reconfigureEffect(effect: StructuredDeliveryEffect): StructuredReconfigureEffect | null {
  if (effect.kind !== "runtime.reconfigure") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const model = typeof effect.payload.model === "string" ? effect.payload.model : "";
  const effort = typeof effect.payload.effort === "string" ? effect.payload.effort : "";
  const fast = typeof effect.payload.fast === "boolean" || effect.payload.fast === null ? effect.payload.fast : undefined;
  const accountId = typeof effect.payload.accountId === "string" ? effect.payload.accountId : undefined;
  const key = effect.payload.sessionKey;
  const sessionKey = key && typeof key === "object" && !Array.isArray(key)
    && ((key as Record<string, unknown>).engine === "codex" || (key as Record<string, unknown>).engine === "claude")
    && typeof (key as Record<string, unknown>).sessionId === "string"
    ? key as StructuredReconfigureEffect["sessionKey"]
    : undefined;
  if (key !== undefined && !sessionKey) return null;
  const previous = effect.payload.previousProfile;
  const previousProfile = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as StructuredReconfigureEffect["previousProfile"]
    : undefined;
  if (!operationId || !conversationId || !model || !effort || fast === undefined) return null;
  return {
    operationId,
    conversationId,
    kind: "reconfigure",
    ...(sessionKey ? { sessionKey } : {}),
    model,
    effort,
    fast,
    ...(accountId ? { accountId } : {}),
    ...(previousProfile ? { previousProfile } : {}),
    eventSeq: effect.eventSeq,
  };
}

function deliveryEffect(effect: StructuredDeliveryEffect): DeliveryEffect | null {
  return controlEffect(effect) ?? compactEffect(effect) ?? reconfigureEffect(effect) ?? sendEffect(effect);
}

function successfulKillBoundary(effect: StructuredDeliveryEffect): SuccessfulKillBoundary | null {
  if (effect.kind !== "runtime.kill-boundary") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const admissionEventSeq = effect.payload.admissionEventSeq;
  if (!operationId || !conversationId
    || !Number.isSafeInteger(admissionEventSeq)
    || admissionEventSeq !== effect.eventSeq) return null;
  return { operationId, conversationId, eventSeq: effect.eventSeq };
}

/**
 * Written when a send was handed to the engine and the executor could not learn
 * what became of it. Both say the same thing to a reader and to the receipt:
 * actuation started, the outcome is unknown, and re-sending the same
 * instruction may deliver it twice.
 *
 * They are also what makes the journal's own words exact for a message effect:
 * `failed` is written only where the send never reached the engine, and
 * `uncertain` wherever it may have. Settlement reads that distinction back —
 * it is the difference between telling a caller a resend is safe and telling
 * them to verify the recipient first.
 */
export const DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR =
  "delivery was started by an earlier executor; whether it reached the recipient is unverified";
export const DELIVERY_UNVERIFIED_AFTER_ACTUATION =
  "delivery was started and the structured host did not answer; whether it reached the recipient is unverified";
/**
 * Written when the durable delivery record has already ended this send.
 *
 * That happens while the runtime host is unreachable: a caller asks what became
 * of an accepted send, the settlement cannot ask the journal, and past the
 * deadline it answers `failed` rather than leaving `queued` as the last word.
 * Delivering the effect once the socket comes back would put the instruction in
 * front of the recipient long after the sender was told it had not arrived, so
 * the settled record fences it here (#1131).
 */
export const DELIVERY_FENCED_BY_SETTLEMENT =
  "delivery was settled before this executor reached it; whether it reached the recipient is unverified";

/**
 * Who took a send into delivery, written where the durable row can carry it.
 *
 * A `delivering` row is the fence that stops a send from being written to the
 * engine twice, and it used to be read as proof of an ABANDONED executor on its
 * own. It is not: a send another executor is actuating right now looks exactly
 * the same, and terminalizing it drops work that is still going somewhere —
 * during a release succession, where two executors are briefly alive over one
 * journal, that is the ordinary case rather than the rare one.
 *
 * So the executor stamps itself and the writer claim it is delivering under
 * onto the transition, and a later executor calls the row abandoned only when
 * that ownership has actually CHANGED: a different executor whose claim on the
 * host is no longer the current one can no longer write to the engine at all,
 * so nothing is left to settle the row but this pass. The receipt reason is the
 * carrier — the journal already persists it per transition, and inventing a
 * durable column for one token would be a schema for a fact one string holds.
 *
 * The comparison has three outcomes, not two, and the third is the one that
 * bites: a claim that cannot be READ is not a claim that has moved. A transient
 * gap in the projection used to read as a handover and terminalize a send
 * another executor was actuating at that moment, so only an explicitly named
 * differing claim proves abandonment now; unreadable evidence leaves the row
 * where it is.
 *
 * That has to hold at the WRITE too, and it is where the rule was still
 * escaping: the stamp used to be omitted whenever the claim could not be read,
 * so a claim projection that was unavailable for the one moment this row was
 * written produced a row carrying no ownership at all — and an unstamped row
 * read as abandoned, which is the same unreadable evidence deciding the same
 * question, one step earlier. The executor identity is always recorded now, and
 * the claim beside it is recorded as UNKNOWN when it could not be read. An
 * unknown recorded claim is nothing to compare against, so it leaves the row
 * with its executor exactly as an unreadable current claim does.
 *
 * The absorbing rule is untouched by any of it: no branch here sends anything
 * again and no branch returns the row to `queued`. Ownership only decides
 * whether this pass ends the send as unverified or leaves it to its owner —
 * and a send left to an owner that never comes back is still ended by the
 * settlement deadline a receipt query applies, so leaving it can delay an
 * answer but can never withhold one.
 */
const DELIVERING_OWNERSHIP_PREFIX = "delivering-owner:";

/** The recorded claim of a row whose writer could not read one. Not a claim any
    projection can ever produce — claims are `<owner>:<epoch>` — so it can never
    be mistaken for one that matches or one that differs. */
const UNKNOWN_HOST_CLAIM = "?";

interface DeliveringOwnership {
  executorId: string;
  /** The claim the row was written under, or null when it was unreadable then. */
  hostClaim: string | null;
}

function deliveringOwnershipReason(executorId: string, hostClaim: Evidence<string | null>): string {
  const recorded = hostClaim.readable ? hostClaim.value ?? UNKNOWN_HOST_CLAIM : UNKNOWN_HOST_CLAIM;
  return `${DELIVERING_OWNERSHIP_PREFIX}${executorId}@${recorded}`;
}

/** Ownership off a durable reason, or null where the row carries none — a row
    written before this evidence existed, or by a path that recorded none. */
function deliveringOwnership(reason: string | null | undefined): DeliveringOwnership | null {
  if (typeof reason !== "string" || !reason.startsWith(DELIVERING_OWNERSHIP_PREFIX)) return null;
  const recorded = reason.slice(DELIVERING_OWNERSHIP_PREFIX.length);
  const separator = recorded.indexOf("@");
  if (separator < 1) return null;
  const hostClaim = recorded.slice(separator + 1);
  if (!hostClaim) return null;
  return {
    executorId: recorded.slice(0, separator),
    hostClaim: hostClaim === UNKNOWN_HOST_CLAIM ? null : hostClaim,
  };
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "structured host delivery failed").slice(0, 240);
}

function isThreadReadTimeout(error: unknown): boolean {
  return /thread\/read.*timed out|request timed out:\s*thread\/read/i.test(failureReason(error));
}

async function sendWithReadRetry(host: EngineHost, entry: QueueEntry): Promise<DeliveryReceipt> {
  for (let attempt = 1; attempt <= THREAD_READ_ATTEMPTS; attempt += 1) {
    try {
      return await host.send(entry);
    } catch (error) {
      if (attempt === THREAD_READ_ATTEMPTS || !isThreadReadTimeout(error)) throw error;
    }
  }
  throw new Error("structured delivery retry budget exhausted");
}

export class StructuredDeliveryQueue {
  private activeDrain: Promise<void> | null = null;
  private rerun = false;
  private readonly targetErrors = new Map<string, string>();
  private lastPassError: string | null = null;
  /** This executor's identity, minted per instance and never persisted beyond
      the `delivering` rows it writes. A successor instance — in this process or
      in the one that replaced it — is a different executor by construction,
      which is what a recovered row has to be able to tell (#1131). */
  private readonly executorId = crypto.randomUUID();
  private readonly interruptAcknowledged = new Set<string>();
  private readonly successfulKillBoundaries = new Map<string, SuccessfulKillBoundary>();
  /** Compactions whose engine control is issued and whose evidence has not
      arrived. The effect stays pending in the journal meanwhile, so every later
      drain pass must find it here and leave it alone (#862). */
  private readonly activeCompactions = new Map<string, Promise<void>>();
  /** The conversations those compactions belong to. Reads block on this rather
      than on a whole-group barrier, so an unfinished compaction holds messages
      without holding kill, interrupt, or answer. */
  private readonly compactingConversations = new Set<string>();

  constructor(
    private readonly port: StructuredDeliveryQueuePort,
    private readonly resolveHost: StructuredHostResolver,
    private readonly terminateHost: (
      conversationId: string,
      sessionKey: { engine: "codex" | "claude"; sessionId: string },
    ) => Promise<boolean> = async () => false,
    private readonly retrySoon: () => void = () => {},
    private readonly recoverHost: StructuredHostRecovery | null = null,
    private readonly reconfigure: StructuredReconfigureHandler = async () => {
      throw new Error("structured host reconfigure is unavailable");
    },
    /** Why this conversation's turn is severed, when evidence says it is
        (#1281). Null means "not shown to be severed", which is what every
        caller here treats as a reason to keep waiting — and so is a read that
        could not be made at all, which {@link readSeveredHostReason} keeps
        separate rather than letting it out as a thrown drain pass (#1131). */
    private readonly severedHostReason: (conversationId: string) => Promise<string | null> = async () => null,
    /** Refuses historical branch kills during recovery before host resolution. */
    private readonly killRefusal: StructuredKillRefusal = () => null,
  ) {}

  drain(): Promise<void> {
    if (this.activeDrain) {
      this.rerun = true;
      return this.activeDrain;
    }
    this.activeDrain = this.drainUntilSettled().finally(() => {
      this.activeDrain = null;
    });
    return this.activeDrain;
  }

  lastTargetError(conversationId: string): string | null {
    return this.targetErrors.get(conversationId) ?? this.lastPassError;
  }

  /** Guarantees a drain pass whose journal read starts after this request. */
  async drainAfterAdmission(): Promise<void> {
    const precedingDrain = this.activeDrain;
    /* The preceding drain owner reports its own failure. This barrier still
       evaluates the journal state created by the completed admission. */
    if (precedingDrain) await precedingDrain.catch(() => undefined);
    await this.drain();
  }

  private async drainUntilSettled(): Promise<void> {
    do {
      this.rerun = false;
      try {
        await this.drainPass();
      } catch (error) {
        this.lastPassError = failureReason(error);
        throw error;
      }
    } while (this.rerun);
  }

  private async drainPass(): Promise<void> {
    const rawEffects: StructuredDeliveryEffect[] = [];
    let afterEventSeq = 0;
    while (true) {
      const page = await this.port.effects(
        ["runtime.send", "runtime.steer", "runtime.answer", "runtime.interrupt", "runtime.kill", "runtime.kill-boundary", "runtime.reconfigure", "runtime.compact"],
        afterEventSeq,
      );
      if (page.length === 0) break;
      rawEffects.push(...page);
      const nextCursor = Math.max(...page.map((effect) => effect.eventSeq));
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterEventSeq) {
        throw new Error("structured delivery effect page did not advance");
      }
      if (page.length < STRUCTURED_DELIVERY_BATCH_SIZE) break;
      afterEventSeq = nextCursor;
    }
    if (rawEffects.length === 0) return;
    const grouped = new Map<string, DeliveryEffect[]>();
    const targetPreparations = new Map<string, Array<() => Promise<void>>>();
    const prepareTarget = (conversationId: string, prepare: () => Promise<void>) => {
      const preparations = targetPreparations.get(conversationId) ?? [];
      preparations.push(prepare);
      targetPreparations.set(conversationId, preparations);
    };
    const effects: DeliveryEffect[] = [];
    for (const rawEffect of rawEffects) {
      if (rawEffect.kind === "runtime.kill-boundary") {
        const boundary = successfulKillBoundary(rawEffect);
        if (!boundary) {
          const conversationId = typeof rawEffect.payload.conversationId === "string"
            ? rawEffect.payload.conversationId
            : `effect-${rawEffect.eventSeq}`;
          prepareTarget(conversationId, async () => {
            throw new Error(`structured kill boundary ${rawEffect.eventSeq} is invalid`);
          });
          continue;
        }
        const current = this.successfulKillBoundaries.get(boundary.conversationId);
        if (!current || boundary.eventSeq > current.eventSeq) {
          this.successfulKillBoundaries.set(boundary.conversationId, boundary);
        }
        continue;
      }
      const effect = deliveryEffect(rawEffect);
      if (effect) {
        effects.push(effect);
        continue;
      }
      const operationId = typeof rawEffect.payload.operationId === "string" ? rawEffect.payload.operationId : "";
      const conversationId = typeof rawEffect.payload.conversationId === "string"
        ? rawEffect.payload.conversationId
        : `effect-${rawEffect.eventSeq}`;
      prepareTarget(conversationId, async () => {
        if (!operationId) throw new Error(`structured delivery effect ${rawEffect.eventSeq} is invalid`);
        await this.transitionUnlessSettled(operationId, "failed", { reason: "structured delivery effect is invalid" });
      });
    }
    effects.sort((left, right) => {
      const leftControl = isControlEffect(left);
      const rightControl = isControlEffect(right);
      const leftReconfigure = isReconfigureEffect(left);
      const rightReconfigure = isReconfigureEffect(right);
      return Number(rightControl) - Number(leftControl)
        || Number(rightReconfigure) - Number(leftReconfigure)
        || (leftReconfigure && rightReconfigure
          ? right.eventSeq - left.eventSeq
          : left.eventSeq - right.eventSeq);
    });
    for (const effect of effects) {
      const target = grouped.get(effect.conversationId) ?? [];
      target.push(effect);
      grouped.set(effect.conversationId, target);
    }
    const conversationIds = new Set([...grouped.keys(), ...targetPreparations.keys()]);
    const targets: Array<[string, () => Promise<boolean>]> = [...conversationIds].map((conversationId) => [
      conversationId,
      async () => {
        for (const prepare of targetPreparations.get(conversationId) ?? []) await prepare();
        return this.drainTarget(grouped.get(conversationId) ?? []);
      },
    ]);
    const outcomes = await Promise.allSettled(
      targets.map(async ([conversationId, drain]) => {
        try {
          return await drain();
        } catch (error) {
          this.targetErrors.set(conversationId, failureReason(error));
          console.error("[structured delivery] conversation drain failed", {
            conversationId,
            error: failureReason(error),
          });
          throw error;
        }
      }),
    );
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled" && outcome.value === false) {
        this.targetErrors.delete(targets[index]![0]);
      }
    });
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failures.length === outcomes.length && failures.length > 0) {
      const reason = failures.at(-1)!.reason;
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `structured delivery failed for every target: ${failureReason(reason)}`,
      );
    }
    if (failures.length > 0) this.retrySoon();
  }

  private async drainTarget(effects: DeliveryEffect[]): Promise<boolean> {
    const openEffects: DeliveryEffect[] = [];
    const durableStatuses = new Map<string, StructuredOperationStatus | null>();
    for (const effect of effects) {
      const durable = await this.readStatus(effect.operationId);
      if (!durable.readable) return this.fenceUnavailable();
      if (durable.value && TERMINAL_DELIVERY_STATUSES.has(durable.value.status)) continue;
      const expired = isRuntimeControlEffect(effect)
        ? expiredControlSettlement(effect, durable.value)
        : null;
      if (expired) {
        await this.transitionUnlessSettled(effect.operationId, expired.status, { reason: expired.reason });
        continue;
      }
      /* A blocked hostless control may produce no journal or host event of its
         own. Keep one bounded retry alive so a later pass observes the deadline
         even when the rest of the runtime stays completely quiet. */
      if (isRuntimeControlEffect(effect) && controlSettlementDeadlineAt(durable.value) !== null) {
        this.retrySoon();
      }
      durableStatuses.set(effect.operationId, durable.value);
      openEffects.push(effect);
    }
    effects = openEffects;
    const killedGenerations = new Set<string>();
    const reconfigures = effects.filter(isReconfigureEffect);
    const currentReconfigure = reconfigures.reduce<StructuredReconfigureEffect | null>(
      (current, effect) => !current || effect.eventSeq > current.eventSeq ? effect : current,
      null,
    );
    for (const effect of reconfigures) {
      if (effect !== currentReconfigure) {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "superseded" });
      }
    }
    for (const effect of effects) {
      /* #862: a compaction in flight holds back everything that would write to
         the thread — messages and reconfigures — but never another control.
         Kill is the operator's safety valve and interrupt/answer are how a turn
         is reached at all; leaving them inert for the length of a compaction
         would be a worse failure than the one the barrier prevents. Controls
         sort ahead of these, so by here every one of them has already run. */
      if (!isControlEffect(effect) && this.compactingConversations.has(effect.conversationId)) return true;
      if (isReconfigureEffect(effect)) {
        if (effect !== currentReconfigure) continue;
        if (effect.sessionKey
          ? killedGenerations.has(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`)
          : killedGenerations.size > 0) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "conversation-killed" });
          continue;
        }
        const blocked = await this.drainReconfigure(effect);
        if (blocked) return true;
        continue;
      }
      if (isControlEffect(effect)) {
        const result = isCompactEffect(effect)
          ? await this.drainCompact(effect)
          : await this.drainControl(effect);
        if (result.blocked) return true;
        if (result.terminated && effect.kind === "kill") {
          if (effect.sessionKey) {
            killedGenerations.add(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`);
          }
          const current = this.successfulKillBoundaries.get(effect.conversationId);
          if (!current || effect.eventSeq > current.eventSeq) {
            this.successfulKillBoundaries.set(effect.conversationId, {
              operationId: effect.operationId,
              conversationId: effect.conversationId,
              eventSeq: effect.eventSeq,
            });
          }
        }
        continue;
      }
      const killBoundary = this.successfulKillBoundaries.get(effect.conversationId);
      if (killBoundary && effect.eventSeq <= killBoundary.eventSeq) {
        await this.transitionUnlessSettled(effect.operationId, "failed", {
          reason: "structured host was intentionally terminated; retry the operation",
        });
        continue;
      }
      /* An executor already handed this effect to the engine. Delivering it
         again would be a SECOND instruction on a channel that carries
         deployment control, so this pass never writes it — the durable
         `delivering` row IS the fence, and it holds across a Viewer restart, a
         runtime-host restart, and a socket that was gone for hours.
         What it settles depends on WHO holds it, and that is a question with
         THREE answers rather than two. An executor that still owns the writer
         claim on this host can answer for the send, so its row is left where it
         is. One whose claim has explicitly moved on cannot write to the engine
         and cannot settle the row either, so this pass ends it unverified. And
         where the claim cannot be read at all the row is left alone too: a gap
         in the claim projection says nothing about who is delivering, and the
         receipt deadline ends the send anyway if its owner never comes back.

         The fence itself is a failable read, and a fence that could not be read
         is not an open one. It used to become `null` here and fall straight
         through to the engine call, so a send an executor was already
         delivering could be delivered a SECOND time by whichever pass caught
         the journal at a bad moment. */
      const durable = durableStatuses.get(effect.operationId) ?? null;
      if (durable?.status === "delivering") {
        if (await this.deliveringOwnerDisposition(effect.conversationId, durable.reason) !== "abandoned") continue;
        await this.terminalizeUnverified(effect.operationId, DELIVERY_UNVERIFIED_BY_EARLIER_EXECUTOR);
        continue;
      }
      /* And the same fence from the other store: a receipt query already ended
         this send — the only answer available while the runtime host was
         unreachable — so actuating it now would deliver an instruction the
         sender was told had not arrived (#1131). Asked under the effect's OWN
         operation id, which is what makes a deliberate retry a different send:
         it is admitted as a new operation, so the settled record of the attempt
         it replaces does not fence it. Unreadable for the same reason as above:
         a record that cannot be read has not said this send is unsettled. */
      const settled = await this.readSettled(effect.operationId);
      if (!settled.readable) return this.fenceUnavailable();
      if (settled.value) {
        await this.terminalizeUnverified(effect.operationId, DELIVERY_FENCED_BY_SETTLEMENT);
        continue;
      }
      const host = this.resolveHost(effect.conversationId);
      if (!host) {
        if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
        await this.recoverUnavailableHost(effect);
        return true;
      }
      /* The live host's state, and the fence that decides whether this message
         may be handed over at all. Unreadable is not idle and not dead: it
         proves neither that the host can take the message nor that recovery is
         owed one, so the pass writes nothing and comes back. */
      const state = await this.readHealth(host);
      if (!state.readable) return this.fenceUnavailable();
      const health = state.value;
      if (health.status === "dead" || health.status === "unhosted") {
        if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
        await this.recoverUnavailableHost(effect);
        return true;
      }
      const maySteer = health.status === "active"
        && (effect.kind === "steer" || effect.policy === "steer-if-active");
      const replacementIsActive = effect.policy === "interrupt-active"
        && (health.status === "active" || health.status === "attention")
        && Boolean(health.activeTurnRef);
      const shouldInterrupt = replacementIsActive
        && (effect.turnId === undefined || effect.turnId === health.activeTurnRef)
        && !this.interruptAcknowledged.has(effect.operationId);
      if (health.status !== "idle" && !maySteer && !shouldInterrupt) return true;
      if (health.status === "idle") this.interruptAcknowledged.delete(effect.operationId);
      const deliveryFence = shouldInterrupt
        ? effect.turnId ?? health.activeTurnRef
        : effect.policy === "interrupt-active"
          ? effect.turnId ?? null
          : effect.turnId !== undefined
            ? effect.turnId
            : health.activeTurnRef;
      const entry: QueueEntry = {
        id: effect.operationId,
        content: effect.content,
        contentDigest: effect.contentDigest,
        text: effect.content.text,
        images: effect.content.images,
        expectedTurnId: effect.policy === "interrupt-active" ? null : deliveryFence,
        ...(effect.runtime ? { runtime: effect.runtime } : {}),
        ...(effect.selectedContext ? { selectedContext: effect.selectedContext } : {}),
        ...(effect.origin ? { origin: effect.origin } : {}),
      };
      /* Always stamped, claim or no claim: the executor identity is what tells
         a row this instance is actuating right now from one it dropped, and
         omitting the whole stamp because the claim read failed produced an
         unstamped row that a later pass read as abandonment. An unreadable
         claim is recorded as unknown instead, which proves nothing to anybody
         and is exactly what it should prove. */
      const claim = await this.readHostClaim(effect.conversationId);
      if (!await this.transitionUnlessSettled(
        effect.operationId,
        "delivering",
        { turnId: deliveryFence, reason: deliveringOwnershipReason(this.executorId, claim) },
      )) continue;
      if (shouldInterrupt) {
        try {
          await host.interrupt(health.activeTurnRef!);
          this.interruptAcknowledged.add(effect.operationId);
        } catch (error) {
          this.interruptAcknowledged.delete(effect.operationId);
          const reason = failureReason(error);
          /* Nothing was handed to the engine yet — the interrupt that would
             have cleared the way for it is what failed — so both branches only
             put the message back in the queue it came from, and an unreadable
             state is grouped with the one that waits rather than retries. No
             branch here converts it into a claim about the host. */
          const afterFailure = await this.readHealth(host);
          if (!afterFailure.readable
            || afterFailure.value.status === "dead"
            || afterFailure.value.status === "unhosted") {
            await this.transitionUnlessSettled(effect.operationId, "queued", { reason });
            return true;
          }
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "interrupt-auto-retry" });
          this.retrySoon();
          return true;
        }
        /* The interrupt was issued; whether the turn it ended left the host
           idle is the question this read answers. Unreadable answers nothing,
           so the message is not handed over on it: the row stays `delivering`
           and this instance's own next pass ends it as unverified rather than
           sending after an interrupt whose outcome nothing established. */
        const afterInterruptState = await this.readHealth(host);
        if (!afterInterruptState.readable) return this.fenceUnavailable();
        const afterInterrupt = afterInterruptState.value;
        if (afterInterrupt.status === "dead" || afterInterrupt.status === "unhosted") {
          this.interruptAcknowledged.delete(effect.operationId);
          if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) continue;
          return true;
        }
        if (afterInterrupt.status !== "idle") {
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "interrupt-requested" });
          return true;
        }
        this.interruptAcknowledged.delete(effect.operationId);
      }
      let receipt;
      try {
        receipt = await sendWithReadRetry(host, entry);
      } catch (error) {
        const reason = failureReason(error);
        /* The one resend below is allowed only where the host is READ to be
           alive, so an unreadable state is grouped with the host being gone:
           the grouping that resends nothing. It costs a drain pass on a
           conversation whose host may be fine, and buys never issuing a second
           delivery on evidence nobody could read. */
        const afterFailure = await this.readHealth(host);
        const hostIsGone = !afterFailure.readable
          || afterFailure.value.status === "dead"
          || afterFailure.value.status === "unhosted";
        if (!hostIsGone && isThreadReadTimeout(error)) {
          /* The one resend this path issues, and the host dedupes it by
             queue-entry id: it reads the thread back and returns the confirmed
             receipt rather than writing a second message. Its own operation is
             retried, so this is the one failure after actuation that may go
             back to `queued`. */
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "delivery-auto-retry" });
          this.retrySoon();
          return true;
        }
        /* The message was handed to the engine and the engine did not answer.
           It may have been taken — whether the host then died or is still
           standing, the only thing that could say is the confirmed-delivery
           record this call failed to get — so it must not go back to `queued`,
           which says the send was never executed and is what let a later resend
           look safe on a send the recipient had already received (#1131), and
           it must not settle `failed`, which the receipt reads as fenced and
           answers `resend: "safe"`. A resend is issued under a NEW request id,
           so nothing on the host side would dedupe it against this attempt.
           `uncertain` is absorbing — the journal refuses every transition out
           of it and clears the outbox row in the same transaction — so no
           drain and no fresh request can produce a second delivery, and the
           receipt says the fate is unknown instead of inventing one. That is
           what keeps `failed` on a message effect meaning "never reached the
           engine": the distinction settlement reads to decide whether a resend
           is safe. The cost is that a precondition the host refused by throwing
           reads as unverified too; one verification is the cheaper error. */
        await this.terminalizeUnverified(effect.operationId, `${DELIVERY_UNVERIFIED_AFTER_ACTUATION}: ${reason}`);
        /* A host that is gone takes the rest of this conversation's queue with
           it; a live one keeps draining behind the send it could not answer. */
        if (hostIsGone) return true;
        continue;
      }
      if (receipt.outcome === "rejected") {
        if (receipt.reason === "stale-turn") {
          if (effect.kind === "send" && effect.policy !== "steer-if-active") {
            await this.transitionUnlessSettled(effect.operationId, "queued", { reason: receipt.reason });
            return true;
          }
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: receipt.reason });
          continue;
        }
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason: receipt.reason });
        return true;
      }
      await this.transitionUnlessSettled(effect.operationId, "delivered", { turnId: receipt.turnId });
    }
    return false;
  }

  /**
   * Executes a durable compact receipt (#862). The pass never waits for the
   * compaction itself: it issues the control, records the conversation as
   * compacting so no message can slip past an unfinished compaction, and lets
   * the evidence terminalize the receipt out of band. Duplicate execution is
   * impossible because the operation is registered in flight before the control
   * is issued and the outbox row is only cleared by the terminal transition.
   *
   * It never reports the group blocked, in any branch: compact is the first
   * control that can occupy this slot for minutes, and a kill sorted behind it
   * must still run in the same pass. Messages are held by the per-conversation
   * barrier instead, which is read only for non-control effects.
   */
  private async drainCompact(effect: CompactEffect): Promise<ControlDrainResult> {
    if (this.activeCompactions.has(effect.operationId)) return { blocked: false, terminated: false };
    /* A second compaction admitted for a thread that is already compacting is
       left pending, untouched. The operator's second request is legitimate once
       the first lands — journal admission cannot refuse it, because a
       compaction is not a turn — but issuing both would compact the thread
       twice and settle both receipts on one piece of evidence. The `retrySoon`
       fired when the first settles brings this effect back. Holding it does not
       block the group: kill must still get through. */
    if (this.compactingConversations.has(effect.conversationId)) return { blocked: false, terminated: false };
    /* An unreadable receipt is not evidence of anything, and this control is a
       second COMPACTION if the row it cannot read is already `delivering` — the
       same duplicate actuation the message path is fenced against. The pass
       issues nothing and comes back; the group is not reported blocked, because
       a kill sorted behind this effect must still run. */
    const status = await this.readStatus(effect.operationId);
    if (!status.readable) {
      this.retrySoon();
      return { blocked: false, terminated: false };
    }
    const durable = status.value;
    if (durable?.status === "delivering") {
      /* An earlier executor issued this control and never settled it — a Viewer
         restart, or a terminal transition that never landed. This process
         cannot know whether the thread was compacted, and issuing the control
         again could compact it twice, so the receipt terminalizes unverified. */
      await this.terminalizeUnverified(
        effect.operationId,
        "compaction was issued by an earlier executor; its outcome is unverified",
      );
      return { blocked: false, terminated: false };
    }
    /* A conversation the operator deliberately terminated must not be brought
       back to compact it. A compact admitted between a kill's admission and its
       execution is still pending afterwards — kill admission does not move the
       session's host axis — and the recovery below would otherwise respawn the
       host purely to run this control. Sends are fenced the same way. */
    const killBoundary = this.successfulKillBoundaries.get(effect.conversationId);
    if (killBoundary && effect.eventSeq <= killBoundary.eventSeq) {
      await this.transitionUnlessSettled(effect.operationId, "failed", {
        reason: "structured host was intentionally terminated; retry the operation",
      });
      return { blocked: false, terminated: false };
    }
    const host = this.resolveHost(effect.conversationId);
    /* Controls sort ahead of sends, and a compaction can hold that slot for
       minutes, so an unavailable host must start the same recovery a send would
       — otherwise every message queued behind this control waits on a host
       nobody asked to come back. The group is not reported blocked: recovery is
       asynchronous, and a kill behind this effect must not wait a whole pass
       for it. */
    if (!host) {
      if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) {
        return { blocked: false, terminated: false };
      }
      await this.recoverUnavailableHost(effect);
      return { blocked: false, terminated: false };
    }
    if (!hostSupportsCompact(host)) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "unsupported-capability" });
      return { blocked: false, terminated: false };
    }
    /* Same fence as the message path, and the same answer to an unreadable
       one: a compaction is issued against a host this pass could read as idle,
       never against one it could not read at all. */
    const state = await this.readHealth(host);
    if (!state.readable) {
      this.retrySoon();
      return { blocked: false, terminated: false };
    }
    const health = state.value;
    if (health.status === "dead" || health.status === "unhosted") {
      if (!await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" })) {
        return { blocked: false, terminated: false };
      }
      await this.recoverUnavailableHost(effect);
      return { blocked: false, terminated: false };
    }
    /* Admission fenced the durable turn axis; this re-reads the live host, so a
       turn that started in between fails the control instead of racing it. */
    if (health.status !== "idle" || health.activeTurnRef) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "busy-turn" });
      return { blocked: false, terminated: false };
    }
    /* Durable marker first: a restart that finds the receipt in `delivering`
       knows the control may already have reached the engine and terminalizes it
       as unverified instead of compacting the thread a second time. */
    if (!await this.transitionUnlessSettled(effect.operationId, "delivering")) {
      return { blocked: false, terminated: false };
    }
    /* Marked before the run exists: a compaction that settles immediately would
       otherwise clear the barrier before it was ever raised. */
    this.compactingConversations.add(effect.conversationId);
    const run = this.runCompaction(host, effect).finally(() => {
      this.activeCompactions.delete(effect.operationId);
      this.compactingConversations.delete(effect.conversationId);
      this.retrySoon();
    });
    this.activeCompactions.set(effect.operationId, run);
    void run.catch(() => undefined);
    return { blocked: false, terminated: false };
  }

  private async runCompaction(host: CompactCapableHost, effect: CompactEffect): Promise<void> {
    try {
      const outcome = await host.compact({
        operationId: effect.operationId,
        threadId: effect.sessionKey.sessionId,
      });
      /* The receipt records which compaction closed it: the only durable place
         the lifecycle evidence survives alongside the operation. */
      await this.transitionUnlessSettled(effect.operationId, "delivered", {
        reason: outcome.compactionId ? `compaction:${outcome.compactionId}` : null,
      });
    } catch (error) {
      if (error instanceof StructuredCompactError && error.phase === "unverified") {
        await this.terminalizeUnverified(effect.operationId, failureReason(error));
        return;
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: failureReason(error) });
    }
  }

  /**
   * The five failable reads this queue decides on, each keeping whether it
   * could be read at all.
   *
   * A port method that is not wired answers as a completed read: the fence does
   * not exist in that deployment, which is a fact about the configuration. Only
   * an attempted read that threw is unreadable, and the callers above never let
   * one of those authorise anything.
   */
  private readStatus(operationId: string): Promise<Evidence<StructuredOperationStatus | null>> {
    const read = this.port.status?.bind(this.port);
    return readOptionalEvidence(read && (() => read(operationId)), null, "delivery journal status is unavailable");
  }

  private readSettled(operationId: string): Promise<Evidence<boolean>> {
    const read = this.port.settled?.bind(this.port);
    return readOptionalEvidence(read && (() => read(operationId)), false, "durable delivery record is unavailable");
  }

  private async transitionUnlessSettled(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: { turnId?: string | null; reason?: string | null },
  ): Promise<boolean> {
    try {
      await this.port.transition(operationId, status, details);
      return true;
    } catch (error) {
      const durable = await this.readStatus(operationId);
      if (durable.readable && durable.value && TERMINAL_DELIVERY_STATUSES.has(durable.value.status)) {
        return false;
      }
      throw error;
    }
  }

  private readHostClaim(conversationId: string): Promise<Evidence<string | null>> {
    const read = this.port.hostClaim?.bind(this.port);
    return readOptionalEvidence(read && (() => read(conversationId)), null, "host claim projection is unavailable");
  }

  /**
   * The live host's own state, which is a read like any other.
   *
   * It decides whether a message may be handed over at all, whether a control
   * may be issued, and — after an actuation that threw — whether the host is
   * gone. It used to be read bare, so a throw took the whole pass down with it,
   * or converted at the call site with `.catch(() => null)` into the host being
   * GONE, which is a fact nothing read. Being gone is what lets a control be
   * issued a second time, so that conversion was the same duplicate-actuation
   * hazard as an unreadable journal fence one step further along.
   */
  private readHealth(host: EngineHost): Promise<Evidence<HostState>> {
    return readEvidence(() => host.health(), "structured host state is unavailable");
  }

  /**
   * Whether the evidence says this conversation's turn is severed, when a
   * control has no host left to resolve (#1281).
   *
   * The liveness decision behind it already refuses to answer `severed` from
   * anything it could not read — that is the whole of what it is for — so a
   * null here means only "not shown to be severed". The read reaching it can
   * still fail, though: it goes to the registry snapshot and to a transcript on
   * disk, and letting that failure out would abort the drain pass for every
   * other conversation sharing it. Unreadable joins `unknown` on the side that
   * settles nothing, which is the same answer both this fence and the liveness
   * decision give the question separately.
   */
  private readSeveredHostReason(conversationId: string): Promise<Evidence<string | null>> {
    return readEvidence(
      () => this.severedHostReason(conversationId),
      "structured host liveness evidence is unavailable",
    );
  }

  /**
   * What the drain does with a fence it could not read: nothing, and again
   * shortly.
   *
   * Reporting the group blocked leaves the effect exactly as it was — no
   * transition, no engine write, nothing durable to undo — and the scheduled
   * retry brings the pass back once the store answers. A send whose executor
   * never returns is ended by the receipt deadline meanwhile, so a fence that
   * stays unreadable delays an answer without ever withholding one.
   */
  private fenceUnavailable(): boolean {
    this.retrySoon();
    return true;
  }

  /**
   * What a `delivering` row's recorded ownership proves about its executor.
   *
   * Three answers, because two were one too few. The row says actuation began;
   * whether the executor that began it is still there is a separate question,
   * and an unreadable answer to that question is not a `no`.
   *
   * - `live`: a DIFFERENT executor wrote the row and the writer claim it wrote
   *   under is still the claim that owns the host. It can still write to the
   *   engine, so the row is its to settle.
   * - `abandoned`: the host is owned by a DIFFERENT, explicitly named claim, so
   *   the recorded executor can no longer write to the engine and nothing but
   *   this pass is left to end the row. A row this executor wrote itself is
   *   abandoned too: no other pass of this instance can be actuating it, so
   *   finding it here means an earlier pass of ours dropped it.
   * - `unproven`: the two claims could not be COMPARED — the row carries no
   *   ownership at all, it was written under a claim its writer could not read,
   *   or the claim now cannot be read. That is a gap in the evidence and not a
   *   handover, so the row stays with the executor that holds it. Nothing is
   *   withheld by waiting: an owner that never comes back leaves the send to
   *   the receipt deadline, which ends it from the durable record alone, and no
   *   branch here sends anything again.
   *
   * A row carrying no ownership used to be `abandoned` — every row looked like
   * that before this evidence existed, and terminalizing them was how the
   * evidence was rolled out. It is `unproven` now, because the only rows that
   * can still look like that are ones whose writer could not read the claim,
   * which is the projection gap this fence exists for.
   */
  private async deliveringOwnerDisposition(
    conversationId: string,
    reason: string | null | undefined,
  ): Promise<"live" | "abandoned" | "unproven"> {
    const owner = deliveringOwnership(reason);
    if (!owner) return "unproven";
    if (owner.executorId === this.executorId) return "abandoned";
    switch (evidenceAgrees(await this.readHostClaim(conversationId), owner.hostClaim)) {
      case "matches": return "live";
      case "differs": return "abandoned";
      default: return "unproven";
    }
  }

  /**
   * Terminalizes an operation whose outcome nothing proved — a send an executor
   * took and could not answer for, a compaction an earlier one issued. `uncertain` is a
   * newer transition than the rest of this channel, so a runtime-host from
   * before #862 rejects it; the operation must still settle rather than wedge
   * the conversation's queue behind a receipt no pass can ever clear.
   */
  private async terminalizeUnverified(operationId: string, reason: string): Promise<void> {
    try {
      await this.transitionUnlessSettled(operationId, "uncertain", { reason });
    } catch {
      await this.transitionUnlessSettled(operationId, "failed", { reason });
    }
  }

  private async drainReconfigure(effect: StructuredReconfigureEffect): Promise<boolean> {
    const host = this.resolveHost(effect.conversationId);
    if (host) {
      /* A switch is applied at a turn boundary, and an unreadable state is not
         one: it cannot show the host busy, and treating it as idle would apply
         the switch across a turn that may be running. */
      const state = await this.readHealth(host);
      if (!state.readable) { this.retrySoon(); return true; }
      const health = state.value;
      if (health.status === "active" || health.status === "attention" || health.activeTurnRef) return true;
    }
    if (!await this.transitionUnlessSettled(effect.operationId, "applying")) return false;
    try {
      const outcome = await this.reconfigure(effect, {
        isCurrent: () => this.isCurrentReconfigure(effect),
      });
      if (outcome === "pending") {
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "turn-boundary" });
        this.retrySoon();
        return true;
      }
      await this.transitionUnlessSettled(effect.operationId, "applied");
    } catch (error) {
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason: failureReason(error) });
    }
    return false;
  }

  private async isCurrentReconfigure(effect: StructuredReconfigureEffect): Promise<boolean> {
    let latest = effect;
    let afterEventSeq = 0;
    while (true) {
      const page = await this.port.effects(["runtime.reconfigure"], afterEventSeq);
      for (const raw of page) {
        const candidate = reconfigureEffect(raw);
        if (candidate?.conversationId === effect.conversationId && candidate.eventSeq > latest.eventSeq) {
          latest = candidate;
        }
      }
      if (page.length < STRUCTURED_DELIVERY_BATCH_SIZE) break;
      const nextCursor = Math.max(...page.map((item) => item.eventSeq));
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterEventSeq) {
        throw new Error("structured reconfigure ownership page did not advance");
      }
      afterEventSeq = nextCursor;
    }
    return latest.operationId === effect.operationId && latest.eventSeq === effect.eventSeq;
  }

  private async recoverUnavailableHost(effect: Pick<DeliveryEffect, "conversationId" | "operationId">): Promise<void> {
    if (!this.recoverHost) return;
    try {
      if (await this.recoverHost(effect.conversationId)) {
        this.rerun = true;
        return;
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", {
        reason: "structured host recovery did not start; retry the operation",
      });
    } catch (error) {
      const reason = `structured host recovery failed: ${failureReason(error)}`.slice(0, 240);
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
    }
  }

  private async drainControl(effect: ControlEffect): Promise<ControlDrainResult> {
    if (effect.kind === "kill") {
      const refusal = await this.killRefusal(effect.conversationId);
      if (refusal) {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason: refusal });
        return { blocked: false, terminated: false };
      }
      const host = this.resolveHost(effect.conversationId);
      if (!effect.sessionKey) {
        await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "structured host termination target is unavailable" });
        return { blocked: false, terminated: false };
      }
      if (!host) {
        try {
          if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) {
            return { blocked: true, terminated: false };
          }
          if (!await this.transitionUnlessSettled(effect.operationId, "delivering")) {
            return { blocked: false, terminated: true };
          }
          await this.transitionUnlessSettled(effect.operationId, "delivered");
          return { blocked: false, terminated: true };
        } catch (error) {
          await this.transitionUnlessSettled(effect.operationId, "queued", { reason: failureReason(error) });
          throw error;
        }
      }
      if (!await this.transitionUnlessSettled(effect.operationId, "delivering")) {
        return { blocked: false, terminated: false };
      }
      try {
        if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "structured host termination is unavailable" });
          return { blocked: false, terminated: false };
        }
        await this.transitionUnlessSettled(effect.operationId, "delivered");
        return { blocked: false, terminated: true };
      } catch (error) {
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason: failureReason(error) });
        throw error;
      }
    }
    const host = this.resolveHost(effect.conversationId);
    if (!host) {
      /* Holding the control was right while a host might still come back to
         answer it, and wrong once nothing can: the effect stays pending, the
         group never drains, and every message queued behind it waits on a turn
         no process is running (#1281). Evidence of a severed turn settles it
         instead — an interrupt has nothing left to interrupt, and an attention
         nothing left to answer. Evidence is also all it is: `unknown` and a
         read that could not be made both leave the control held, which is what
         this queue does with every other unreadable fence (#1131). */
      const severed = await this.readSeveredHostReason(effect.conversationId);
      if (!severed.readable) {
        this.retrySoon();
        return { blocked: true, terminated: false };
      }
      if (!severed.value) return { blocked: true, terminated: false };
      await this.transitionUnlessSettled(
        effect.operationId,
        effect.kind === "interrupt" ? "interrupted" : "failed",
        { reason: `structured host is severed: ${severed.value}`.slice(0, 240) },
      );
      return { blocked: false, terminated: false };
    }
    /* An answer and an interrupt are engine writes like a message, so the same
       rule holds one step earlier: a state that could not be read authorises
       neither the control nor the `dead-host` requeue that would reissue it. */
    const state = await this.readHealth(host);
    if (!state.readable) {
      this.retrySoon();
      return { blocked: true, terminated: false };
    }
    const health = state.value;
    if (health.status === "dead" || health.status === "unhosted") {
      await this.transitionUnlessSettled(effect.operationId, "queued", { reason: "dead-host" });
      return { blocked: true, terminated: false };
    }
    if (!await this.transitionUnlessSettled(effect.operationId, "delivering", {
      ...(effect.kind === "interrupt" ? { turnId: effect.turnId ?? health.activeTurnRef } : {}),
    })) return { blocked: false, terminated: false };
    try {
      if (effect.kind === "answer") {
        await host.answer(effect.attentionId!, effect.resolution);
        await this.transitionUnlessSettled(effect.operationId, "answered");
      } else {
        const turnId = effect.turnId ?? health.activeTurnRef;
        if (!turnId || (health.activeTurnRef && health.activeTurnRef !== turnId)) {
          await this.transitionUnlessSettled(effect.operationId, "failed", { reason: "stale-turn" });
          return { blocked: false, terminated: false };
        }
        await host.interrupt(turnId);
        await this.transitionUnlessSettled(effect.operationId, "interrupted", { turnId });
      }
      return { blocked: false, terminated: false };
    } catch (error) {
      const reason = failureReason(error);
      /* The control was issued and threw. `queued` here says it never reached
         the engine and hands it to a later pass to issue AGAIN, which is only
         honest where the host is read to be gone — a departed host answered
         nothing and kept nothing. An unreadable state is not that proof, and
         converting it into one let an answer or an interrupt be delivered a
         second time to a host that was alive the whole time. It settles like
         any other control this host refused instead. */
      const afterFailure = await this.readHealth(host);
      if (afterFailure.readable
        && (afterFailure.value.status === "dead" || afterFailure.value.status === "unhosted")) {
        await this.transitionUnlessSettled(effect.operationId, "queued", { reason });
        return { blocked: true, terminated: false };
      }
      await this.transitionUnlessSettled(effect.operationId, "failed", { reason });
      return { blocked: false, terminated: false };
    }
  }
}
