import fs from "node:fs";

import { parseReview, VERDICT_LINE_RE } from "@/lib/review";
import { tailRecords } from "@/lib/scanner/activity";
import { recordValue, recordsValue, stringValue } from "@/lib/scanner/json";
import type { FileEntry } from "@/lib/types";

import { normalizeFindings } from "./store";
import type { FlowEngine, ReviewVerdict, Round } from "./types";

/**
 * How a round's verdict is obtained: from the findings artifact file when the
 * headless reviewer wrote one, or parsed out of the reviewer transcript's
 * last assistant message as the fallback.
 */

export interface ParsedFindings {
  verdict: ReviewVerdict;
  findingsCount: number;
  content: string;
}

type TranscriptEntry = Pick<FileEntry, "path" | "root" | "size" | "mtime">;

export function lastAssistantMessage(entry: TranscriptEntry): { text: string; ts: number } | null {
  const records = tailRecords(entry.path, entry.size, entry.mtime * 1000);
  for (const obj of records.reverse()) {
    const ts = Date.parse(String(obj.timestamp ?? "")) || entry.mtime * 1000;
    if (entry.root === "codex-sessions") {
      const payload = recordValue(obj.payload) ?? {};
      const type = stringValue(payload.type);
      if (type === "task_complete") {
        const text = stringValue(payload.last_agent_message)?.trim();
        if (text) return { text, ts };
      }
      if (type === "agent_message") return { text: stringValue(payload.message) ?? "", ts };
      if (type === "message" && payload.role === "assistant") {
        const text = recordsValue(payload.content)
          .map((part) => stringValue(part.text) ?? stringValue(part.input_text) ?? "")
          .join("\n")
          .trim();
        if (text) return { text, ts };
      }
    }
    if (entry.root === "claude-projects" && obj.type === "assistant") {
      const text = recordsValue(recordValue(obj.message)?.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text) ?? "")
        .join("\n")
        .trim();
      if (text) return { text, ts };
    }
  }
  return null;
}

function transcriptEntryFromPath(transcriptPath: string, engine: FlowEngine | null): TranscriptEntry | null {
  try {
    const stat = fs.statSync(transcriptPath);
    return {
      path: transcriptPath,
      root: engine === "claude" || (!engine && transcriptPath.includes("/.claude/projects/"))
        ? "claude-projects"
        : "codex-sessions",
      size: stat.size,
      mtime: stat.mtimeMs / 1_000,
    };
  } catch {
    return null;
  }
}

export function parseFindings(text: string): ParsedFindings | null {
  const verdict = text.match(VERDICT_LINE_RE)?.[1] as ReviewVerdict | undefined;
  if (!verdict) return null;
  const review = parseReview(text, null);
  return {
    verdict,
    findingsCount: review?.findings.length ?? 0,
    content: normalizeFindings(verdict, text),
  };
}

export function readFindingsFile(round: Round): ParsedFindings | null {
  if (!round.findingsPath) return null;
  try {
    return parseFindings(fs.readFileSync(round.findingsPath, "utf8"));
  } catch {
    return null;
  }
}

export function fallbackReviewFromTranscript(
  round: Round,
  entriesByPath: Map<string, FileEntry>,
  engine: FlowEngine | null = round.reviewerRole?.engine ?? null,
): ParsedFindings | null {
  if (!round.reviewerPath) return null;
  const entry = entriesByPath.get(round.reviewerPath) ?? transcriptEntryFromPath(round.reviewerPath, engine);
  if (!entry) return null;
  const message = lastAssistantMessage(entry);
  if (!message) return null;
  return parseFindings(message.text);
}
