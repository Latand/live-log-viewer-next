import type { RuntimeSendSettings } from "./contracts";
import type { DeliveryReceipt, EngineHost, QueueEntry } from "./engineHost";
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

export type StructuredDeliveryTransition = "queued" | "delivering" | "applying" | "delivered" | "applied" | "answered" | "interrupted" | "failed";

export interface StructuredDeliveryQueuePort {
  effects(kinds?: readonly string[], afterEventSeq?: number): Promise<StructuredDeliveryEffect[]>;
  transition(
    operationId: string,
    status: StructuredDeliveryTransition,
    details?: { turnId?: string | null; reason?: string | null },
  ): Promise<void>;
}

export type StructuredHostResolver = (conversationId: string) => EngineHost | null;

const STRUCTURED_DELIVERY_BATCH_SIZE = 100;
const THREAD_READ_ATTEMPTS = 2;

export function runtimeClientDeliveryPort(client: RuntimeHostClient): StructuredDeliveryQueuePort {
  return {
    effects: (kinds, afterEventSeq) => client.effectBatch(kinds, afterEventSeq),
    transition: async (operationId, status, details) => {
      await client.transitionOperation(operationId, status, details);
    },
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

type DeliveryEffect = SendEffect | ControlEffect | StructuredReconfigureEffect;

function isControlEffect(effect: DeliveryEffect): effect is ControlEffect {
  return effect.kind === "answer" || effect.kind === "interrupt" || effect.kind === "kill";
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
  return controlEffect(effect) ?? reconfigureEffect(effect) ?? sendEffect(effect);
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

  constructor(
    private readonly port: StructuredDeliveryQueuePort,
    private readonly resolveHost: StructuredHostResolver,
    private readonly terminateHost: (
      conversationId: string,
      sessionKey: { engine: "codex" | "claude"; sessionId: string },
    ) => Promise<boolean> = async () => false,
    private readonly retrySoon: () => void = () => {},
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
        ["runtime.send", "runtime.steer", "runtime.answer", "runtime.interrupt", "runtime.kill", "runtime.reconfigure"],
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
        const blocked = await this.drainControl(effect, killedGenerations);
        if (blocked) return true;
        continue;
      }
      const host = this.resolveHost(effect.conversationId);
      if (!host) return true;
      const health = await host.health();
      if (health.status === "dead" || health.status === "unhosted") {
        await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
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

  private async drainControl(effect: ControlEffect, killedGenerations: Set<string>): Promise<boolean> {
    const host = this.resolveHost(effect.conversationId);
    if (effect.kind === "kill") {
      if (!effect.sessionKey) {
        await this.port.transition(effect.operationId, "failed", { reason: "structured host termination target is unavailable" });
        return false;
      }
      if (!host) {
        try {
          if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) return true;
          await this.port.transition(effect.operationId, "delivering");
          await this.port.transition(effect.operationId, "delivered");
          killedGenerations.add(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`);
          return false;
        } catch (error) {
          await this.port.transition(effect.operationId, "queued", { reason: failureReason(error) });
          throw error;
        }
      }
      await this.port.transition(effect.operationId, "delivering");
      try {
        if (!await this.terminateHost(effect.conversationId, effect.sessionKey)) {
          await this.port.transition(effect.operationId, "failed", { reason: "structured host termination is unavailable" });
          return false;
        }
        await this.port.transition(effect.operationId, "delivered");
        killedGenerations.add(`${effect.sessionKey.engine}:${effect.sessionKey.sessionId}`);
        return false;
      } catch (error) {
        await this.port.transition(effect.operationId, "queued", { reason: failureReason(error) });
        throw error;
      }
    }
    if (!host) return true;
    const health = await host.health();
    if (health.status === "dead" || health.status === "unhosted") {
      await this.port.transition(effect.operationId, "queued", { reason: "dead-host" });
      return true;
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
          return false;
        }
        await host.interrupt(turnId);
        await this.port.transition(effect.operationId, "interrupted", { turnId });
      }
      return false;
    } catch (error) {
      const reason = failureReason(error);
      const afterFailure = await host.health().catch(() => null);
      if (!afterFailure || afterFailure.status === "dead" || afterFailure.status === "unhosted") {
        await this.port.transition(effect.operationId, "queued", { reason });
        return true;
      }
      await this.port.transition(effect.operationId, "failed", { reason });
      return false;
    }
  }
}
