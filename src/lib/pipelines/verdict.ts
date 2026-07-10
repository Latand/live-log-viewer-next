import type { StageVerdict } from "./types";

const MAX_FINDINGS = 50;
const MAX_FINDING_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 32_000;
const ALLOWED_KEYS = new Set(["status", "findings", "confidence"]);

export type ParsedStageVerdict = { verdict: StageVerdict; output: string };

export function stageVerdictFrom(value: unknown): StageVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.has(key))) return null;
  if (record.status !== "pass" && record.status !== "fail" && record.status !== "needs_decision") return null;
  const verdict: StageVerdict = { status: record.status };
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings) || record.findings.length > MAX_FINDINGS) return null;
    const findings: string[] = [];
    for (const finding of record.findings) {
      if (typeof finding !== "string") return null;
      const trimmed = finding.trim();
      if (!trimmed || trimmed.length > MAX_FINDING_CHARS) return null;
      findings.push(trimmed);
    }
    verdict.findings = findings;
  }
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      return null;
    }
    verdict.confidence = record.confidence;
  }
  return verdict;
}
/** Completion authority is the final fenced JSON block in a completed turn. */
export function parseStageVerdict(text: string): ParsedStageVerdict | null {
  const matches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const suffix = text.slice(last.index + last[0].length).trim();
  if (suffix) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(last[1] ?? "");
  } catch {
    return null;
  }
  const verdict = stageVerdictFrom(raw);
  if (!verdict) return null;
  return { verdict, output: text.slice(0, last.index).trim().slice(0, MAX_OUTPUT_CHARS) };
}
