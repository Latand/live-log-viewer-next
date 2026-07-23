import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import {
  answerDialogKey,
  compactConversation,
  interruptConversation,
  killConversation,
  resumeConversation,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";

export const CONVERSATION_ACTIONS = ["interrupt", "kill", "resume", "compact", "dialog-key"] as const;
export type ConversationAction = typeof CONVERSATION_ACTIONS[number];

export type ConversationActionRequest = {
  operationId?: string;
  conversationId: string;
  transcriptPath: string;
  action: string;
  key?: string;
  label?: unknown;
  question?: unknown;
};

type ConversationActionBody =
  | Exclude<DeliveryOutcome, { ok: false }>
  | Omit<Extract<DeliveryOutcome, { ok: false }>, "status">
  | { ok: true; structured: true; target: string; outcome: "delivered" | "resumed"; spawned?: boolean }
  | { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } }
  | { error: string };

export type ConversationActionResult = { status: number; body: ConversationActionBody };

export interface ConversationActionDependencies {
  registry(): AgentRegistry;
  structuredEnabled(): boolean;
  dispatchStructuredControl: typeof dispatchStructuredControl;
  interruptConversation: typeof interruptConversation;
  killConversation: typeof killConversation;
  resumeConversation: typeof resumeConversation;
  compactConversation: typeof compactConversation;
  answerDialogKey: typeof answerDialogKey;
}

const productionDependencies: ConversationActionDependencies = {
  registry: agentRegistry,
  structuredEnabled: () => process.env.LLV_STRUCTURED_HOSTS === "1",
  dispatchStructuredControl,
  interruptConversation,
  killConversation,
  resumeConversation,
  compactConversation,
  answerDialogKey,
};

function failure(error: string, status: number): ConversationActionResult {
  return { status, body: { error } };
}

function deliveryResult(outcome: DeliveryOutcome): ConversationActionResult {
  if (outcome.ok) return { status: 200, body: outcome };
  const { status, ...body } = outcome;
  return { status, body };
}

export async function applyConversationAction(
  request: ConversationActionRequest,
  dependencies: ConversationActionDependencies = productionDependencies,
): Promise<ConversationActionResult> {
  if (!(CONVERSATION_ACTIONS as readonly string[]).includes(request.action)) {
    return failure("unsupported conversation action", 400);
  }
  if (request.conversationId && !request.conversationId.startsWith("conversation_")) {
    return failure("invalid conversation id", 400);
  }
  const registry = dependencies.registry();
  const byId = request.conversationId
    ? registry.conversation(request.conversationId as `conversation_${string}`)
    : null;
  const byPath = request.transcriptPath ? registry.conversationForPath(request.transcriptPath) : null;
  if (request.conversationId && !byId) return failure("viewer conversation is unknown", 404);
  if (byId && request.transcriptPath) {
    const knownPaths = new Set([
      ...byId.generations.map((generation) => generation.path),
      ...byId.continuityPaths,
    ]);
    if (!knownPaths.has(request.transcriptPath) || byPath?.id !== byId.id) {
      return failure("conversation identity does not own transcript path", 409);
    }
  }
  const conversation = byId ?? byPath;
  const transcriptPath = byId?.generations.at(-1)?.path ?? request.transcriptPath;

  if (dependencies.structuredEnabled()) {
    const structured = await dependencies.dispatchStructuredControl({
      path: transcriptPath,
      conversationId: conversation?.id ?? request.conversationId,
      action: request.action,
      operationId: request.operationId,
    });
    if (structured) return structured;
  }
  if (!transcriptPath) return failure("conversationId or transcriptPath is required", 400);

  if (request.action === "interrupt") return deliveryResult(await dependencies.interruptConversation(transcriptPath));
  if (request.action === "kill") {
    const outcome = await dependencies.killConversation(transcriptPath);
    if (outcome.ok && !outcome.target) {
      return deliveryResult({ ok: false, outcome: "failed", error: "kill resolved no registered pane", status: 409 });
    }
    return deliveryResult(outcome);
  }
  if (request.action === "resume") return deliveryResult(await dependencies.resumeConversation(transcriptPath));
  if (request.action === "compact") return deliveryResult(await dependencies.compactConversation(transcriptPath));
  return deliveryResult(await dependencies.answerDialogKey(
    transcriptPath,
    request.key ?? "",
    request.label,
    request.question,
  ));
}
