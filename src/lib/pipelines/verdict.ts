import type { StageVerdict } from "./types";

const MAX_FINDINGS = 50;
const MAX_FINDING_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 32_000;
const ALLOWED_KEYS = new Set(["status", "findings", "confidence"]);
const PROSE_VERDICT_STATUSES = {
  APPROVE: "pass",
  REQUEST_CHANGES: "fail",
  COMMENT: "needs_decision",
  "NO FINDINGS": "pass",
} as const satisfies Record<string, StageVerdict["status"]>;
const PROSE_VERDICT_LINE_RE = /^\s*(?:VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)|(NO FINDINGS))\s*$/i;

type ProseVerdictMarker = keyof typeof PROSE_VERDICT_STATUSES;

function proseVerdictMarkers(prose: string): ProseVerdictMarker[] {
  const markers: ProseVerdictMarker[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of prose.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const token = fenceMatch[1]!;
      const marker = token[0] as "`" | "~";
      if (!fence) fence = { marker, length: token.length };
      else if (fence.marker === marker && token.length >= fence.length && !fenceMatch[2]!.trim()) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    const match = PROSE_VERDICT_LINE_RE.exec(line);
    if (match) markers.push((match[1] ?? match[2])!.toUpperCase() as ProseVerdictMarker);
  }
  return markers;
}

export type ParsedStageVerdict = { verdict: StageVerdict; output: string };
export type RejectedStageVerdict = { failureReason: string; output: string };

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
export function parseStageVerdict(text: string): ParsedStageVerdict | RejectedStageVerdict | null {
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
  const prose = text.slice(0, last.index).trim();
  const output = prose.slice(0, MAX_OUTPUT_CHARS);
  if (verdict.status === "pass" && verdict.findings?.length) {
    return {
      failureReason: 'contradictory stage verdict: status "pass" cannot include findings',
      output,
    };
  }
  for (const marker of proseVerdictMarkers(prose)) {
    if (PROSE_VERDICT_STATUSES[marker] !== verdict.status) {
      return {
        failureReason: `contradictory stage verdict: prose marker "${marker}" disagrees with JSON status "${verdict.status}"`,
        output,
      };
    }
  }
  return { verdict, output };
}
