export type ReviewSeverity = "Critical" | "High" | "Medium" | "Low" | "Info" | "P0" | "P1" | "P2" | "P3";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  title: string;
  body: string;
}

export interface ReviewCardItem {
  kind: "review";
  ts: unknown;
  verdict?: "REQUEST_CHANGES" | "APPROVE" | "COMMENT";
  findings: ReviewFinding[];
  summary: string[];
  raw: string;
}

export const RAW_DEBUG_KEEP = 24_000;
export const VERDICT_LINE_RE = /^\s*(?:VERDICT:\s*)?(REQUEST_CHANGES|APPROVE|COMMENT)\b/m;
const FINDING_ITEM_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const FINDING_HEADING_RE = /^\s*#{1,6}\s+finding\s+\d+\s*$/i;
const FINDING_FIELD_RE = /^\s*[-*]\s+\*\*(severity|file|line|title|explanation):\*\*\s*(.*)$/i;
const SEVERITY_RE = /(?:\[(P[0-3])\]|\b(Critical|High|Medium|Low|Info|P[0-3])\b)/i;
const PATH_RE =
  /((?:\.{1,2}\/|\/|~\/)?[\w@.+-][\w@.+\-/]*\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|md|json|ya?ml|toml|css|scss|html|sql|sh|env|ftl|txt))(?::(\d+))?/i;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const SECRET_VALUE_RE =
  /([\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token))\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_VALUE_RE, (_whole, key: string, sep: string, quote: string) => `${key}${sep}${quote}[redacted]`);
}

export function debugRaw(text: string): { raw: string; truncated: boolean } {
  const redacted = redactSecrets(text);
  return { raw: redacted.slice(0, RAW_DEBUG_KEEP), truncated: redacted.length > RAW_DEBUG_KEEP };
}

function normalizeSeverity(value: string): ReviewSeverity {
  const upper = value.toUpperCase();
  if (upper === "P0" || upper === "P1" || upper === "P2" || upper === "P3") return upper;
  const lower = value.toLowerCase();
  if (lower === "critical") return "Critical";
  if (lower === "high") return "High";
  if (lower === "medium") return "Medium";
  if (lower === "low") return "Low";
  return "Info";
}

export function splitTargetLine(target: string): { target: string; line?: string } {
  const match = target.match(/^(.*?):(\d+(?:-\d+)?)$/);
  if (!match) return { target };
  return { target: match[1] ?? target, line: match[2] };
}

function parseLinkedTarget(text: string): { file?: string; line?: number } {
  const markdown = text.match(MARKDOWN_LINK_RE);
  if (markdown) {
    const target = splitTargetLine((markdown[2] ?? "").replace(/^file:\/\//, ""));
    const line = target.line ? Number(target.line.split("-", 1)[0]) : undefined;
    return { file: target.target || markdown[1], line: Number.isFinite(line) ? line : undefined };
  }
  const plain = text.match(PATH_RE);
  if (!plain) return {};
  const line = plain[2] ? Number(plain[2]) : undefined;
  return { file: plain[1], line: Number.isFinite(line) ? line : undefined };
}

function findingTitle(body: string): string {
  let text = body;
  const sev = text.match(SEVERITY_RE);
  if (sev && sev.index !== undefined) {
    const after = text.slice(sev.index + sev[0].length).replace(/^[\s.:–—-]+/, "");
    if (after) text = after;
  }
  return text
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function makeFinding(body: string): ReviewFinding {
  const severity = normalizeSeverity(body.match(SEVERITY_RE)?.[1] ?? body.match(SEVERITY_RE)?.[2] ?? "Info");
  const target = parseLinkedTarget(body);
  const title = findingTitle(body) || body.slice(0, 200) || "Finding";
  return { severity, file: target.file, line: target.line, title, body: debugRaw(body).raw };
}

type StructuredFinding = Partial<Record<"severity" | "file" | "line" | "title" | "explanation", string>>;

function inlineValue(value: string): string {
  return value.trim().replace(/^`([^`]*)`$/, "$1");
}

/** Current Codex reviewers emit labelled Markdown bullets, optionally grouped
    under `### Finding N` headings. Parse that stable field contract directly so
    the flow engine and review cards share the same finding count and metadata. */
function parseStructuredFindings(text: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let current: StructuredFinding | null = null;
  let activeField: keyof StructuredFinding | null = null;
  const flush = () => {
    if (current?.severity && current.title && current.explanation) {
      const linked = current.file ? parseLinkedTarget(current.file) : {};
      const explicitLine = current.line ? Number.parseInt(current.line, 10) : undefined;
      findings.push({
        severity: normalizeSeverity(current.severity),
        file: linked.file ?? (current.file ? inlineValue(current.file) : undefined),
        line: Number.isFinite(explicitLine) ? explicitLine : linked.line,
        title: inlineValue(current.title).slice(0, 200),
        body: debugRaw(current.explanation).raw,
      });
    }
    current = null;
    activeField = null;
  };

  for (const rawLine of text.split("\n")) {
    if (FINDING_HEADING_RE.test(rawLine)) {
      flush();
      current = {};
      continue;
    }
    const field = rawLine.match(FINDING_FIELD_RE);
    if (field) {
      const key = field[1]!.toLowerCase() as keyof StructuredFinding;
      if (key === "severity" && current?.severity) flush();
      current ??= {};
      current[key] = field[2]?.trim() ?? "";
      activeField = key;
      continue;
    }
    const continuation = rawLine.trim();
    if (current && activeField === "explanation" && continuation) {
      current.explanation = `${current.explanation ?? ""}\n${continuation}`.trim();
    }
  }
  flush();
  return findings;
}

export function parseReview(text: string, ts: unknown): ReviewCardItem | null {
  const verdict = text.match(VERDICT_LINE_RE)?.[1] as ReviewCardItem["verdict"] | undefined;
  if (!verdict) return null;
  const findings = parseStructuredFindings(text);
  const hasStructuredFindings = findings.length > 0;
  const summary: string[] = [];
  let buffer: string | null = null;
  const flush = () => {
    const body = buffer?.trim();
    if (body) findings.push(makeFinding(body));
    buffer = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const item = line.match(FINDING_ITEM_RE);
    if (!hasStructuredFindings && item) {
      flush();
      buffer = item[2] ?? "";
      continue;
    }
    const trimmed = line.trim();
    if (buffer !== null) {
      if (trimmed) buffer = `${buffer}\n${trimmed}`;
      else flush();
      continue;
    }
    if (!trimmed || VERDICT_LINE_RE.test(line) || FINDING_HEADING_RE.test(line) || FINDING_FIELD_RE.test(line) || /^(findings?|summary|open questions?|tests?|residual risk)\s*:?\s*$/i.test(trimmed)) {
      continue;
    }
    if (findings.length === 0 && summary.length < 3 && trimmed.length <= 240) summary.push(trimmed);
  }
  if (!hasStructuredFindings) flush();

  const severe = findings.filter((finding) => SEVERITY_RE.test(finding.body)).length;
  const reviewish =
    Boolean(verdict) ||
    /^findings?\s*:?$/im.test(text) ||
    severe >= 2 ||
    (severe >= 1 && /\b(review|request_changes|approve|comment)\b/i.test(text));
  if (!reviewish) return null;
  return { kind: "review", ts, verdict, findings, summary, raw: debugRaw(text).raw };
}
