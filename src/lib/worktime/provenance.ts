import type { OperatorEventProvenance } from "./types";

const EVENT_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function parseOperatorEventProvenance(value: unknown): OperatorEventProvenance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !EVENT_ID.test(candidate.id)) return null;
  if (candidate.origin !== "composer" && candidate.origin !== "realtime" && candidate.origin !== "api-human") return null;
  if (candidate.relation !== "direct" && candidate.relation !== "copy") return null;
  return { id: candidate.id, origin: candidate.origin, relation: candidate.relation };
}
