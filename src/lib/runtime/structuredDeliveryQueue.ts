import type { EngineHost, QueueEntry } from "./engineHost";
import type { RuntimeHostClient } from "./client";

export interface StructuredDeliveryEffect {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  eventSeq: number;
}

export type StructuredDeliveryTransition = "queued" | "delivering" | "delivered" | "failed";

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
  text: string;
  turnId?: string | null;
  policy?: "queue" | "steer-if-active";
  kind: "send" | "steer";
  hasImages: boolean;
  eventSeq: number;
}

function sendEffect(effect: StructuredDeliveryEffect): SendEffect | null {
  if (effect.kind !== "runtime.send" && effect.kind !== "runtime.steer") return null;
  const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : "";
  const conversationId = typeof effect.payload.conversationId === "string" ? effect.payload.conversationId : "";
  const text = typeof effect.payload.text === "string" ? effect.payload.text : "";
  if (!operationId || !conversationId || !text) return null;
  const turnId = typeof effect.payload.turnId === "string" || effect.payload.turnId === null
    ? effect.payload.turnId
    : undefined;
  const policy = effect.payload.policy === "queue" || effect.payload.policy === "steer-if-active"
    ? effect.payload.policy
    : undefined;
  return {
    operationId,
    conversationId,
    text,
    kind: effect.kind === "runtime.steer" ? "steer" : "send",
    hasImages: Array.isArray(effect.payload.images) && effect.payload.images.length > 0,
    eventSeq: effect.eventSeq,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(policy ? { policy } : {}),
  };
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "structured host delivery failed").slice(0, 240);
}

export class StructuredDeliveryQueue {
  private activeDrain: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly port: StructuredDeliveryQueuePort,
    private readonly resolveHost: StructuredHostResolver,
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
    const blockedConversations = new Set<string>();
    let afterEventSeq = 0;
    while (true) {
      const rawEffects = await this.port.effects(["runtime.send", "runtime.steer"], afterEventSeq);
      if (rawEffects.length === 0) return;
      const nextCursor = Math.max(...rawEffects.map((effect) => effect.eventSeq));
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= afterEventSeq) {
        throw new Error("structured delivery effect page did not advance");
      }
      const grouped = new Map<string, SendEffect[]>();
      const effects = rawEffects
        .map(sendEffect)
        .filter((effect): effect is SendEffect => effect !== null)
        .sort((left, right) => left.eventSeq - right.eventSeq);
      for (const effect of effects) {
        if (blockedConversations.has(effect.conversationId)) continue;
        const target = grouped.get(effect.conversationId) ?? [];
        target.push(effect);
        grouped.set(effect.conversationId, target);
      }
      const results = await Promise.all([...grouped.entries()].map(async ([conversationId, target]) => ({
        conversationId,
        blocked: await this.drainTarget(target),
      })));
      for (const result of results) if (result.blocked) blockedConversations.add(result.conversationId);
      if (rawEffects.length < STRUCTURED_DELIVERY_BATCH_SIZE) return;
      afterEventSeq = nextCursor;
    }
  }

  private async drainTarget(effects: SendEffect[]): Promise<boolean> {
    for (const effect of effects) {
      if (effect.hasImages) {
        await this.port.transition(effect.operationId, "failed", { reason: "structured host image delivery is unavailable" });
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
      if (health.status !== "idle" && !maySteer) return true;
      const mustFenceTurn = effect.kind === "steer" || effect.turnId !== undefined || maySteer;
      const entry: QueueEntry = {
        id: effect.operationId,
        text: effect.text,
        ...(mustFenceTurn ? { expectedTurnId: effect.turnId ?? health.activeTurnRef } : {}),
      };
      await this.port.transition(
        effect.operationId,
        "delivering",
        entry.expectedTurnId !== undefined ? { turnId: entry.expectedTurnId } : undefined,
      );
      let receipt;
      try {
        receipt = await host.send(entry);
      } catch (error) {
        const reason = failureReason(error);
        const afterFailure = await host.health().catch(() => null);
        if (!afterFailure || afterFailure.status === "dead" || afterFailure.status === "unhosted") {
          await this.port.transition(effect.operationId, "queued", { reason });
          return true;
        }
        await this.port.transition(effect.operationId, "failed", { reason });
        continue;
      }
      if (receipt.outcome === "rejected") {
        if (receipt.reason === "stale-turn") {
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
}
