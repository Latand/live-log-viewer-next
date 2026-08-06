export function compactPath(value: string): string {
  return value.replace(/(?:\/[^\s)]+){3,}/g, (match) => {
    if (match.length <= 40) return match;
    const parts = match.split("/").filter(Boolean);
    return parts.length >= 2 ? ".../" + parts.slice(-2).join("/") : match;
  });
}

export function cleanTitle(value: string, maxLength = 160): string {
  const stripped = value
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const compacted = compactPath(stripped).replace(/\s+/g, " ").trim();
  return compacted.length > maxLength ? compacted.slice(0, maxLength - 1).trimEnd() + "…" : compacted;
}

export function shortTitle(value: string, maxLength = 32): string {
  const cleaned = cleanTitle(value, maxLength + 20);
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 1).trimEnd() + "…" : cleaned;
}

const GENERIC_SESSION_TITLES = new Set([
  "codex session",
  "claude session",
  "codex",
  "claude",
]);

export const SPAWN_TITLE_REQUIRED_ERROR = "title is required for every new spawn";

function genericSessionTitleKey(value: string): string {
  return cleanTitle(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

export function isGenericSessionTitle(value: string | null | undefined): boolean {
  return typeof value === "string" && GENERIC_SESSION_TITLES.has(genericSessionTitleKey(value));
}

/** Validate a durable title without rewriting its meaningful punctuation. */
export function durableSemanticTitle(value: string | null | undefined, maxLength = 160): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const cleaned = cleanTitle(trimmed, maxLength);
  if (!trimmed || !/[\p{L}\p{N}]/u.test(cleaned) || isGenericSessionTitle(trimmed)) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength - 1).trimEnd() + "…" : trimmed;
}

export function semanticTitle(value: string | null | undefined, maxLength = 160): string | null {
  const durable = durableSemanticTitle(value, maxLength);
  return durable ? cleanTitle(durable, maxLength) : null;
}

export function firstPromptLine(value: string | null | undefined, maxLength = 60): string | null {
  const firstLine = value?.split(/\r?\n/, 1)[0] ?? "";
  return semanticTitle(firstLine, maxLength);
}

export function derivedSpawnTitle(role: string | null | undefined, prompt: string | null | undefined, fallback = "New task"): string {
  const semanticRole = typeof role === "string" ? cleanTitle(role, 40) || "agent" : "agent";
  const semanticPrompt = firstPromptLine(prompt, 60) ?? semanticTitle(fallback, 60) ?? "New task";
  return cleanTitle(`${semanticRole} · ${semanticPrompt}`, 120);
}
