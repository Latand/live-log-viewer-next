import { expect, test } from "bun:test";

import type { AgentRegistry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";

import { deliverPipelineDecision, pipelineDecisionDeliveryStatus, terminalizePipelineDecisionDelivery } from "./decisionDelivery";

test("held decision admission returns the caller's stable operation and durable delivery identities (#852)", async () => {
  const admitted: unknown[] = [];
  const request = {
    pipelineId: "pipeline-held",
    stageId: "build",
    sourceAttempt: 1,
    targetAttempt: 2,
    conversationId: "conversation-held",
    path: "/sessions/pipeline-held.jsonl",
    input: "Continue during the low-traffic window.",
    clientMessageId: "pipeline-decision-message-held",
    operationId: "pipeline-decision-operation-held",
  };
  const result = await deliverPipelineDecision(request, {
    enqueue: async (input) => {
      admitted.push(input);
      return {
        ok: true,
        structured: true,
        target: request.conversationId,
        outcome: "held",
        operationId: request.operationId,
        deliveryId: "pipeline-decision-delivery-held",
      };
    },
    registry: () => ({
      readOnlySnapshot: () => ({ deliveryOperationOwners: {}, heldDeliveries: {} }),
    }) as unknown as AgentRegistry,
  });

  expect({ result, admitted }).toMatchObject({
    result: {
      state: "held",
      operationId: request.operationId,
      deliveryId: "pipeline-decision-delivery-held",
    },
    admitted: [{
      conversationId: request.conversationId,
      path: request.path,
      clientMessageId: request.clientMessageId,
      operationId: request.operationId,
      kind: "send",
      policy: "queue",
      text: request.input,
    }],
  });
});

test("an uncertain admission keeps the original operation in flight (#852)", async () => {
  const request = {
    pipelineId: "pipeline-uncertain-admission",
    stageId: "build",
    sourceAttempt: 1,
    targetAttempt: 2,
    conversationId: "conversation-uncertain-admission",
    path: "/sessions/pipeline-uncertain-admission.jsonl",
    input: "Continue once delivery is confirmed.",
    clientMessageId: "pipeline-decision-message-uncertain-admission",
    operationId: "pipeline-decision-operation-uncertain-admission",
  };
  const deliveryId = "pipeline-decision-delivery-uncertain-admission";
  const result = await deliverPipelineDecision(request, {
    enqueue: async () => ({
      ok: false,
      structured: true,
      outcome: "failed",
      error: "delivery outcome is unknown",
      status: 409,
      operationId: request.operationId,
      receipt: {
        operationId: request.operationId,
        idempotencyKey: request.clientMessageId,
        conversationId: request.conversationId,
        kind: "send",
        status: "uncertain",
        reason: "delivery outcome is unknown",
        at: "2026-07-31T18:00:02.000Z",
        revision: 1,
      },
    }),
    registry: () => ({
      readOnlySnapshot: () => ({
        deliveryOperationOwners: {
          [request.operationId]: {
            deliveryId,
            terminalState: null,
            createdAt: "2026-07-31T18:00:00.000Z",
          },
        },
        heldDeliveries: {},
      }),
    }) as unknown as AgentRegistry,
  });

  expect(result).toEqual({
    state: "delivering",
    operationId: request.operationId,
    deliveryId,
    at: "2026-07-31T18:00:02.000Z",
    error: "delivery outcome is unknown",
  });
});

test("a delivery claim racing terminalization stays uncertain until its runtime receipt settles (#852)", async () => {
  const operationId = "pipeline_decision_race";
  const deliveryId = "delivery-race";
  let delivery = {
    id: deliveryId,
    state: "assigned",
    attempts: 0,
    error: null as string | null,
    createdAt: "2026-07-31T18:00:00.000Z",
    assignedAt: "2026-07-31T18:00:01.000Z",
    deliveredAt: null,
  };
  let terminalState: "failed" | null = null;
  const registry = {
    readOnlySnapshot: () => ({
      deliveryOperationOwners: {
        [operationId]: { deliveryId, terminalState, createdAt: delivery.createdAt },
      },
      heldDeliveries: { [deliveryId]: delivery },
    }),
    terminalizeHeldDelivery: (_id: string, reason: string) => {
      /* Simulates beginDeliveryAttempt winning after the adapter's snapshot and
         before the registry's terminalization transaction. */
      delivery = {
        ...delivery,
        state: "failed",
        attempts: 1,
        error: `${reason}; a prior delivery attempt may have been delivered because its journal outcome is unknown`,
      };
      terminalState = "failed";
      return delivery;
    },
  } as unknown as AgentRegistry;
  const dependencies = { registry: () => registry, client: () => null };

  const terminal = await terminalizePipelineDecisionDelivery(operationId, "superseded by retry-stage", dependencies);
  const restarted = await pipelineDecisionDeliveryStatus(operationId, dependencies);
  const delivered = await pipelineDecisionDeliveryStatus(operationId, {
    registry: () => registry,
    client: () => ({
      operationStatus: async () => ({
        operationId,
        replayed: true,
        receipt: {
          operationId,
          idempotencyKey: "pipeline-decision-message",
          conversationId: "conversation_pipeline_decision",
          kind: "send",
          status: "turn-started",
          turnId: "turn-pipeline-decision",
          at: "2026-07-31T18:00:03.000Z",
          revision: 2,
        },
      }),
    }) as unknown as RuntimeHostClient,
  });

  expect({ terminal, restarted, delivered }).toMatchObject({
    terminal: { state: "delivering", operationId, deliveryId },
    restarted: { state: "delivering", operationId, deliveryId },
    delivered: { state: "delivered", operationId, deliveryId, at: "2026-07-31T18:00:03.000Z" },
  });
});

test("an uncertain runtime receipt never advertises a queued decision (#852)", async () => {
  const operationId = "pipeline_decision_uncertain";
  const deliveryId = "delivery-uncertain";
  const registry = {
    readOnlySnapshot: () => ({
      deliveryOperationOwners: {
        [operationId]: {
          deliveryId,
          terminalState: null,
          createdAt: "2026-07-31T18:00:00.000Z",
        },
      },
      heldDeliveries: {
        [deliveryId]: {
          id: deliveryId,
          state: "delivery-uncertain",
          attempts: 1,
          error: "delivery outcome is unknown",
          createdAt: "2026-07-31T18:00:00.000Z",
          assignedAt: "2026-07-31T18:00:01.000Z",
          deliveredAt: null,
        },
      },
    }),
  } as unknown as AgentRegistry;

  const status = await pipelineDecisionDeliveryStatus(operationId, {
    registry: () => registry,
    client: () => ({
      operationStatus: async () => ({
        operationId,
        replayed: true,
        receipt: {
          operationId,
          idempotencyKey: "pipeline-decision-message",
          conversationId: "conversation_pipeline_decision",
          kind: "send",
          status: "uncertain",
          reason: "delivery outcome is unknown",
          at: "2026-07-31T18:00:02.000Z",
          revision: 2,
        },
      }),
    }) as unknown as RuntimeHostClient,
  });

  expect(status).toMatchObject({
    state: "delivering",
    operationId,
    deliveryId,
    at: "2026-07-31T18:00:02.000Z",
    error: "delivery outcome is unknown",
  });
});
