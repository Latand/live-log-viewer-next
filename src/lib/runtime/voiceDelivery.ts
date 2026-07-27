export interface RuntimeVoiceResponse {
  responseId: string;
  text: string;
}

export interface RuntimeVoiceDelivery {
  deliveryId: string;
  turnId: string;
  responses: RuntimeVoiceResponse[];
  ready: boolean;
}

export interface Utf8Chunk {
  text: string;
  nextOffset: number;
}

const MAX_ACKNOWLEDGED_VOICE_DELIVERIES = 256;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    const content = record(part);
    const type = string(content?.type);
    return type === "text" || type === "input_text" || type === "output_text"
      ? string(content?.text)
      : "";
  }).join("");
}

export function terminalVoiceResponse(
  value: unknown,
  fallbackResponseId: string,
): RuntimeVoiceResponse | null {
  const item = record(value);
  if (!item) return null;
  const message = record(item.message);
  const type = string(item.type);
  const role = string(item.role) || string(message?.role);
  const assistant = type === "agentMessage"
    || type === "agent_message"
    || type === "assistant"
    || (type === "message" && role === "assistant");
  if (!assistant) return null;
  const directText = typeof item.text === "string" ? item.text : "";
  const text = directText || contentText(item.content) || contentText(message?.content);
  if (!text) return null;
  return {
    responseId: string(item.id) || string(item.uuid) || string(message?.id) || fallbackResponseId,
    text,
  };
}

function deliveryId(turnId: string, responses: readonly RuntimeVoiceResponse[]): string {
  return `voice:${JSON.stringify([turnId, responses.map((response) => response.responseId)])}`;
}

export function normalizeVoiceDeliveries(value: unknown): RuntimeVoiceDelivery[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const delivery = record(candidate);
    const turnId = string(delivery?.turnId);
    const responses = Array.isArray(delivery?.responses)
      ? delivery.responses.flatMap((responseValue) => {
        const response = record(responseValue);
        const responseId = string(response?.responseId);
        return responseId && typeof response?.text === "string"
          ? [{ responseId, text: response.text }]
          : [];
      })
      : [];
    if (!turnId || responses.length === 0) return [];
    return [{
      deliveryId: deliveryId(turnId, responses),
      turnId,
      responses,
      ready: delivery?.ready === true,
    }];
  });
}

export function normalizeAcknowledgedVoiceDeliveryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !candidate) continue;
    const previous = ids.indexOf(candidate);
    if (previous >= 0) ids.splice(previous, 1);
    ids.push(candidate);
  }
  return ids.slice(-MAX_ACKNOWLEDGED_VOICE_DELIVERIES);
}

export function rememberAcknowledgedVoiceDelivery(
  value: readonly string[] | null | undefined,
  acknowledgedDeliveryId: string,
): string[] {
  return normalizeAcknowledgedVoiceDeliveryIds([
    ...normalizeAcknowledgedVoiceDeliveryIds(value),
    acknowledgedDeliveryId,
  ]);
}

export function appendVoiceResponse(
  value: readonly RuntimeVoiceDelivery[] | null | undefined,
  turnId: string,
  response: RuntimeVoiceResponse,
): RuntimeVoiceDelivery[] {
  const deliveries = normalizeVoiceDeliveries(value);
  const index = deliveries.findIndex((delivery) => delivery.turnId === turnId);
  const current = index >= 0 ? deliveries[index]! : {
    deliveryId: "",
    turnId,
    responses: [],
    ready: false,
  };
  const responseIndex = current.responses.findIndex((candidate) =>
    candidate.responseId === response.responseId);
  const responses = responseIndex >= 0
    ? current.responses.map((candidate, candidateIndex) =>
      candidateIndex === responseIndex ? response : candidate)
    : [...current.responses, response];
  const next = {
    deliveryId: deliveryId(turnId, responses),
    turnId,
    responses,
    ready: current.ready,
  };
  if (index < 0) return [...deliveries, next];
  return deliveries.map((delivery, deliveryIndex) =>
    deliveryIndex === index ? next : delivery);
}

export function completeVoiceTurn(
  value: readonly RuntimeVoiceDelivery[] | null | undefined,
  turnId: string,
  outcome: string,
  acknowledgedDeliveryIds?: readonly string[] | null,
): RuntimeVoiceDelivery[] {
  const deliveries = normalizeVoiceDeliveries(value);
  const index = deliveries.findIndex((delivery) => delivery.turnId === turnId);
  if (index < 0) return deliveries;
  if (outcome !== "completed") {
    return deliveries.filter((_, deliveryIndex) => deliveryIndex !== index);
  }
  if (deliveries[index]!.ready) return deliveries;
  if (normalizeAcknowledgedVoiceDeliveryIds(acknowledgedDeliveryIds)
    .includes(deliveries[index]!.deliveryId)) {
    return deliveries.filter((_, deliveryIndex) => deliveryIndex !== index);
  }
  return deliveries.map((delivery, deliveryIndex) =>
    deliveryIndex === index ? { ...delivery, ready: true } : delivery);
}

export function acknowledgeVoiceDelivery(
  value: readonly RuntimeVoiceDelivery[] | null | undefined,
  acknowledgedDeliveryId: string,
): RuntimeVoiceDelivery[] {
  const deliveries = normalizeVoiceDeliveries(value);
  return deliveries.filter((delivery) => delivery.deliveryId !== acknowledgedDeliveryId);
}

export function utf8ChunkAt(
  value: string,
  offset: number,
  maxBytes: number,
): Utf8Chunk | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > value.length) {
    throw new Error("voice delivery offset is invalid");
  }
  const firstUnit = value.charCodeAt(offset);
  const previousUnit = value.charCodeAt(offset - 1);
  if (offset > 0
    && firstUnit >= 0xdc00
    && firstUnit <= 0xdfff
    && previousUnit >= 0xd800
    && previousUnit <= 0xdbff) {
    throw new Error("voice delivery offset splits a Unicode scalar");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new Error("voice delivery chunk size is invalid");
  }
  if (offset === value.length) return null;
  let nextOffset = offset;
  let bytes = 0;
  while (nextOffset < value.length) {
    const codePoint = value.codePointAt(nextOffset)!;
    const symbolBytes = codePoint <= 0x7f ? 1
      : codePoint <= 0x7ff ? 2
      : codePoint <= 0xffff ? 3
      : 4;
    if (nextOffset > offset && bytes + symbolBytes > maxBytes) break;
    bytes += symbolBytes;
    nextOffset += codePoint > 0xffff ? 2 : 1;
  }
  return nextOffset > offset
    ? { text: value.slice(offset, nextOffset), nextOffset }
    : null;
}
