import { deliverConversationMessage, migrationDeliveryOutcome } from "@/lib/delivery";
import {
  deliverHeldStructuredMessage,
  type HeldStructuredMessageOutcome,
} from "@/lib/runtime/structuredMessageDelivery";

import type { HeldDeliveryPort } from "./coordinator";

type HeldDeliveryInput = Parameters<HeldDeliveryPort["deliver"]>[0];

export interface MigrationDeliveryPortDependencies {
  structuredDelivery?: typeof deliverHeldStructuredMessage;
  legacyDelivery?: (input: HeldDeliveryInput) => Promise<Exclude<HeldStructuredMessageOutcome, null> | "held">;
}

export function createMigrationDeliveryPort(
  dependencies: MigrationDeliveryPortDependencies = {},
): HeldDeliveryPort {
  const structuredDelivery = dependencies.structuredDelivery ?? deliverHeldStructuredMessage;
  const legacyDelivery = dependencies.legacyDelivery ?? (async ({ delivery, path, clientMessageId }) => {
    if (delivery.payloadKind === "runtime-images") return "delivery-uncertain";
    const result = await deliverConversationMessage({
      pid: null,
      path,
      text: delivery.text,
      images: [],
      clientMessageId,
      reservedDeliveryId: delivery.id,
    });
    return migrationDeliveryOutcome(result);
  });
  const deliverStructured = ({ delivery, path, clientMessageId }: HeldDeliveryInput) => structuredDelivery({
    conversationId: delivery.conversationId,
    runtimeConversationId: delivery.runtimeConversationId,
    path,
    deliveryId: delivery.id,
    clientMessageId,
    text: delivery.text,
    command: delivery.command,
    ...(delivery.runtimeImages.length ? { imageRefs: delivery.runtimeImages } : {}),
  });
  return {
    async deliver(input) {
      const outcome = await deliverStructured(input);
      return outcome ?? legacyDelivery(input);
    },
    async reconcileUncertain(input) {
      return await deliverStructured(input) ?? "delivery-uncertain";
    },
  };
}
