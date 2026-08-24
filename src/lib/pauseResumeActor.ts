export type PauseResumeActor =
  | { kind: "operator" }
  | { kind: "agent"; role: string | null; conversationId: string | null };

export const OPERATOR_PAUSE_RESUME_ACTOR: PauseResumeActor = { kind: "operator" };

function identityPart(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

/** Durable board-card detail for an externally requested pause or resume. */
export function pauseResumeDetail(
  action: "paused" | "resumed",
  actor: PauseResumeActor | null,
): string | null {
  if (actor === null) return null;
  if (actor.kind === "operator") return `${action} by operator`;
  const role = identityPart(actor.role) ?? "agent";
  const conversationId = identityPart(actor.conversationId);
  return `${action} by ${role}${conversationId ? ` ${conversationId}` : ""}`;
}
