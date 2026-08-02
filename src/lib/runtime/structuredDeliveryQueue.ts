import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";

import type { RuntimeSendSettings } from "./contracts";
import type { CompactCapableHost, DeliveryReceipt, EngineHost, QueueEntry } from "./engineHost";
import { hostSupportsCompact, StructuredCompactError } from "./engineHost";
import type { RuntimeHostClient } from "./client";
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

export interface StructuredDeliveryQueuePort {
  effects(kinds?: readonly string[], afterEventSeq?: number): Promise<StructuredDeliveryEffect[]>;
  transition(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: { turnId?: string | null; reason?: string | null },
  ): Promise<void>;
  /** The durable receipt state, when the port can read it. The compact control
      needs it to tell a control it must issue from one an earlier executor
      already issued and never settled (#862). */
  status?(operationId: string): Promise<{ status: string } | null>;
}

export type StructuredHostResolver = (conversationId: string) => EngineHost | null;
export type StructuredHostRecovery = (conversationId: string) => Promise<boolean>;

const STRUCTURED_DELIVERY_BATCH_SIZE = 100;
const THREAD_READ_ATTEMPTS = 2;

export function runtimeClientDeliveryPort(client: RuntimeHostClient): StructuredDeliveryQueuePort {
  return {
    effects: (kinds, afterEventSeq) => client.effectBatch(kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      await client.transitionOperation(operationId, status, details);
    },
    status: async (operationId) => (await client.operationStatus(operationId))?.receipt ?? null,
  };
}

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
      await this.drainPass();
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
    const effects: DeliveryEffect[] = [];
    for (const rawEffect of rawEffects) {
      if (rawEffect.kind === "runtime.kill-boundary") {
        const boundary = successfulKillBoundary(rawEffect);
        if (!boundary) throw new Error(`structured kill boundary ${rawEffect.eventSeq} is invalid`);
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
      if (!operationId) throw new Error(`structured delivery effect ${rawEffect.eventSeq} is invalid`);
      await this.port.transition(operationId, "failed", { reason: "structured delivery effect is invalid" });
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
    await Promise.all([...grouped.values()].map((target) => this.drainTarget(target)));
  }

  private async drainTarget(effects: DeliveryEffect[]): Promise<boolean> {
    const killedGenerations = new Set<string>();
    const reconfigures = effects.filter(isReconfigureEffect);
    const currentReconfigure = reconfigures.reduce<StructuredReconfigureEffect | null>(
      (current, effect) => !current || effect.eventSeq > current.eventSeq ? effect : current,
      null,
    );
    for (const effect of reconfigures) {
      if (effect !== currentReconfigure) {
        await this.port.transition(effect.operationId, "failed", { reason: "superseded" });
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
          await this.port.transition(effect.operationId, "failed", { reason: "conversation-killed" });
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
        await this.port.transition(effect.operationId, "failed", {
          reason: "structured host was intentionally terminated; retry the operation",
        });
        continue;
      }
      const host = this.resolveHost(effect.conversationId);
      if (!host) {
        await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
        await this.recoverUnavailableHost(effect);
        return true;
      }
      const health = await host.health();
      if (health.status === "dead" || health.status === "unhosted") {
        await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
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
      };
      await this.port.transition(
        effect.operationId,
        "delivering",
        { turnId: deliveryFence },
      );
      if (shouldInterrupt) {
        try {
          await host.interrupt(health.activeTurnRef!);
          this.interruptAcknowledged.add(effect.operationId);
        } catch (error) {
          this.interruptAcknowledged.delete(effect.operationId);
          const reason = failureReason(error);
          const afterFailure = await host.health().catch(() => null);
          if (!afterFailure || afterFailure.status === "dead" || afterFailure.status === "unhosted") {
            await this.port.transition(effect.operationId, "queued", { reason });
            return true;
          }
          await this.port.transition(effect.operationId, "queued", { reason: "interrupt-auto-retry" });
          this.retrySoon();
          return true;
        }
        const afterInterrupt = await host.health();
        if (afterInterrupt.status === "dead" || afterInterrupt.status === "unhosted") {
          this.interruptAcknowledged.delete(effect.operationId);
          await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
          return true;
        }
        if (afterInterrupt.status !== "idle") {
          await this.port.transition(effect.operationId, "queued", { reason: "interrupt-requested" });
          return true;
        }
        this.interruptAcknowledged.delete(effect.operationId);
      }
      let receipt;
      try {
        receipt = await sendWithReadRetry(host, entry);
      } catch (error) {
        const reason = failureReason(error);
        const afterFailure = await host.health().catch(() => null);
        if (!afterFailure || afterFailure.status === "dead" || afterFailure.status === "unhosted") {
          await this.port.transition(effect.operationId, "queued", { reason });
          return true;
        }
        if (isThreadReadTimeout(error)) {
          await this.port.transition(effect.operationId, "queued", { reason: "delivery-auto-retry" });
          this.retrySoon();
          return true;
        }
        await this.port.transition(effect.operationId, "failed", { reason });
        continue;
      }
      if (receipt.outcome === "rejected") {
        if (receipt.reason === "stale-turn") {
          if (effect.kind === "send" && effect.policy !== "steer-if-active") {
            await this.port.transition(effect.operationId, "queued", { reason: receipt.reason });
            return true;
          }
          await this.port.transition(effect.operationId, "failed", { reason: receipt.reason });
          continue;
        }
        await this.port.transition(effect.operationId, "queued", { reason: receipt.reason });
        return true;
      }
      await this.port.transition(effect.operationId, "delivered", { turnId: receipt.turnId });
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
   * It never reports the group blocked for an in-flight compaction: the
   * remaining control effects — kill above all — must still run.
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
    /* An unreadable receipt is not evidence of anything. Treat it as unknown
       and fall through to the host checks rather than aborting a drain pass
       that other conversations share. */
    const durable = await this.port.status?.(effect.operationId).catch(() => null);
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
    const host = this.resolveHost(effect.conversationId);
    /* Controls sort ahead of sends, and a compaction can hold that slot for
       minutes, so an unavailable host must start the same recovery a send would
       — otherwise every message queued behind this control waits on a host
       nobody asked to come back. */
    if (!host) {
      await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
      await this.recoverUnavailableHost(effect);
      return { blocked: true, terminated: false };
    }
    if (!hostSupportsCompact(host)) {
      await this.port.transition(effect.operationId, "failed", { reason: "unsupported-capability" });
      return { blocked: false, terminated: false };
    }
    const health = await host.health();
    if (health.status === "dead" || health.status === "unhosted") {
      await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
      await this.recoverUnavailableHost(effect);
      return { blocked: true, terminated: false };
    }
    /* Admission fenced the durable turn axis; this re-reads the live host, so a
       turn that started in between fails the control instead of racing it. */
    if (health.status !== "idle" || health.activeTurnRef) {
      await this.port.transition(effect.operationId, "failed", { reason: "busy-turn" });
      return { blocked: false, terminated: false };
    }
    /* Durable marker first: a restart that finds the receipt in `delivering`
       knows the control may already have reached the engine and terminalizes it
       as unverified instead of compacting the thread a second time. */
    await this.port.transition(effect.operationId, "delivering");
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
      await this.port.transition(effect.operationId, "delivered", {
        reason: outcome.compactionId ? `compaction:${outcome.compactionId}` : null,
      });
    } catch (error) {
      if (error instanceof StructuredCompactError && error.phase === "unverified") {
        await this.terminalizeUnverified(effect.operationId, failureReason(error));
        return;
      }
      await this.port.transition(effect.operationId, "failed", { reason: failureReason(error) });
    }
  }

  /**
   * Terminalizes a compaction whose outcome nothing proved. `uncertain` is a
   * newer transition than the rest of this channel, so a runtime-host from
   * before #862 rejects it; the operation must still settle rather than wedge
   * the conversation's queue behind a receipt no pass can ever clear.
   */
  private async terminalizeUnverified(operationId: string, reason: string): Promise<void> {
    try {
      await this.port.transition(operationId, "uncertain", { reason });
    } catch {
      await this.port.transition(operationId, "failed", { reason });
    }
  }

  private async drainReconfigure(effect: StructuredReconfigureEffect): Promise<boolean> {
    const host = this.resolveHost(effect.conversationId);
    if (host) {
      const health = await host.health();
      if (health.status === "active" || health.status === "attention" || health.activeTurnRef) return true;
    }
    await this.port.transition(effect.operationId, "applying");
    try {
      const outcome = await this.reconfigure(effect, {
        isCurrent: () => this.isCurrentReconfigure(effect),
      });
      if (outcome === "pending") {
        await this.port.transition(effect.operationId, "queued", { reason: "turn-boundary" });
        this.retrySoon();
        return true;
      }
      await this.port.transition(effect.operationId, "applied");
    } catch (error) {
      await this.port.transition(effect.operationId, "failed", { reason: failureReason(error) });
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
      await this.port.transition(effect.operationId, "failed", {
        reason: "structured host recovery did not start; retry the operation",
      });
    } catch (error) {
      const reason = `structured host recovery failed: ${failureReason(error)}`.slice(0, 240);
      await this.port.transition(effect.operationId, "failed", { reason });
    }
  }

  private async drainControl(effect: ControlEffect): Promise<ControlDrainResult> {
    const host = this.resolveHost(effect.conversationId);
    if (effect.kind === "kill") {
      if (!effect.sessionKey) {
        await this.port.transition(effect.operationId, "failed", { reason: "structured host termination target is unavailable" });
        return { blocked: false, terminated: false };
      }
      if (!host) {
        try {
          if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) {
            return { blocked: true, terminated: false };
          }
          await this.port.transition(effect.operationId, "delivering");
          await this.port.transition(effect.operationId, "delivered");
          return { blocked: false, terminated: true };
        } catch (error) {
          await this.port.transition(effect.operationId, "queued", { reason: failureReason(error) });
          throw error;
        }
      }
      await this.port.transition(effect.operationId, "delivering");
      try {
        if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) {
          await this.port.transition(effect.operationId, "failed", { reason: "structured host termination is unavailable" });
          return { blocked: false, terminated: false };
        }
        await this.port.transition(effect.operationId, "delivered");
        return { blocked: false, terminated: true };
      } catch (error) {
        await this.port.transition(effect.operationId, "queued", { reason: failureReason(error) });
        throw error;
      }
    }
    if (!host) return { blocked: true, terminated: false };
    const health = await host.health();
    if (health.status === "dead" || health.status === "unhosted") {
      await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
      return { blocked: true, terminated: false };
    }
    await this.port.transition(effect.operationId, "delivering", {
      ...(effect.kind === "interrupt" ? { turnId: effect.turnId ?? health.activeTurnRef } : {}),
    });
    try {
      if (effect.kind === "answer") {
        await host.answer(effect.attentionId!, effect.resolution);
        await this.port.transition(effect.operationId, "answered");
      } else {
        const turnId = effect.turnId ?? health.activeTurnRef;
        if (!turnId || (health.activeTurnRef && health.activeTurnRef !== turnId)) {
          await this.port.transition(effect.operationId, "failed", { reason: "stale-turn" });
          return { blocked: false, terminated: false };
        }
        await host.interrupt(turnId);
        await this.port.transition(effect.operationId, "interrupted", { turnId });
      }
      return { blocked: false, terminated: false };
    } catch (error) {
      const reason = failureReason(error);
      const afterFailure = await host.health().catch(() => null);
      if (!afterFailure || afterFailure.status === "dead" || afterFailure.status === "unhosted") {
        await this.port.transition(effect.operationId, "queued", { reason });
        return { blocked: true, terminated: false };
      }
      await this.port.transition(effect.operationId, "failed", { reason });
      return { blocked: false, terminated: false };
    }
  }
}
