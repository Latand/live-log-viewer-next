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
  /** Canonical assistant response that projected this structured card. */
  sourceId?: string;
  verdict?: "REQUEST_CHANGES" | "APPROVE" | "COMMENT";
  findings: ReviewFinding[];
  summary: string[];
  raw: string;
}

export const RAW_DEBUG_KEEP = 24_000;
type ReviewVerdict = NonNullable<ReviewCardItem["verdict"]>;
/** Emphasis runs reviewers wrap around a verdict: `*`, `**`, `***`, `_`, `__`, `___`. */
const EMPHASIS = String.raw`[*_]{1,3}`;
/** The `VERDICT:` label with the Markdown reviewers put around it — a heading
    marker, emphasis around the label, the value or the whole line — as in
    `**VERDICT: APPROVE**`, `## VERDICT: APPROVE`, `**Verdict:** APPROVE` and
    `Verdict: **APPROVE**` (#1682). */
const VERDICT_LABEL =
  String.raw`(?:#{1,6}[ \t]+)?(?:${EMPHASIS}[ \t]*)?(?:VERDICT|Verdict|verdict)[*_]{0,3}[ \t]*:[ \t]*(?:${EMPHASIS}[ \t]*)?`;
/** The verdict token and its closing emphasis; `APPROVED`, `APPROVE_DECISION`
    and `COMMENT-level` are other words. */
const VERDICT_TOKEN = String.raw`(REQUEST_CHANGES|APPROVE|COMMENT)[*_]{0,3}(?![A-Za-z0-9_]|-[A-Za-z0-9])`;
/** One verdict line: the labelled form, or the bare token as a plain line. The
    Markdown forms need the label, so finding headings like `### COMMENT — …`
    stay findings. Up to three spaces of indent; four make a code block. */
export const VERDICT_LINE_RE = new RegExp(String.raw`^ {0,3}(?:${VERDICT_LABEL})?${VERDICT_TOKEN}`, "m");
const ANY_VERDICT_TOKEN_RE = /(?<![\w-])(?:REQUEST_CHANGES|APPROVE|COMMENT)(?![\w-])/;
/** A negation or condition straight after APPROVE takes the approval back:
    `VERDICT: APPROVE once tests pass`, `**VERDICT: APPROVE** (after fixes)`.
    After REQUEST_CHANGES or COMMENT the same words describe the code. */
const HEDGED_APPROVAL_RE =
  /^[\s*_—–:,(-]*(?:not|never|unless|if|once|until|pending|after|when|assuming|provided|subject\s+to|conditional(?:ly)?|would|could|should|cannot|can't|only\s+(?:if|when|once|after))(?![\w'])/i;
/** A bare token that runs on into a sentence is prose about a verdict:
    `APPROVE requires findings to be empty`, `APPROVE received.`. Reviewers do
    name what they judged with `at` and `for`, as in `REQUEST_CHANGES at <sha>`. */
const BARE_TOKEN_SENTENCE_RE = /^(?:[ \t]+(?!(?:at|for)\b)[a-z0-9]|[ \t]*=)/;
const FINDING_ITEM_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const FINDING_HEADING_RE = /^\s*#{1,6}\s+finding\s+\d+\b.*$/i;
/** Reviewers label the same fields with any mix of leading bullet and bold, so
    accept `- **Severity:** High`, `**Severity:** High`, `- Severity: High` and
    `Severity: High` as the one field contract (#930). */
const FINDING_FIELD_RE =
  /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(severity|file|line|title|explanation)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/i;
const TOP_LEVEL_BULLET_RE = /^[-*+]\s+(.*)$/;
const SEVERITY_RE = /(?:\[(P[0-3])\]|\b(Critical|High|Medium|Low|Info|P[0-3])\b)/i;
const PATH_RE =
  /((?:\.{1,2}\/|\/|~\/)?[\w@.+-][\w@.+\-/]*\.(?:tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|md|json|ya?ml|toml|css|scss|html|sql|sh|env|ftl|txt))(?::(\d+))?/i;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const SECRET_KEYWORD_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)/i;
const SECRET_VALUE_RE =
  /([\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token))\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;

export function redactSecrets(text: string): string {
  if (!SECRET_KEYWORD_RE.test(text)) return text;
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

/** Strip the bold markers a whole-line `**Severity: High**` label leaves behind
    once the field name has been matched. */
function fieldValue(value: string): string {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/^\*\*([\s\S]*)\*\*$/);
  if (wrapped) return wrapped[1]!.trim();
  return trimmed.replace(/\*\*$/, "").trim();
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
      current[key] = fieldValue(field[2] ?? "");
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

/** Display-only fallback for reviewers whose findings never reach the field
    contract above: count `### Finding N` blocks, else top-level bullets that
    carry a severity token, so a REQUEST_CHANGES verdict with a written-out
    findings file never reports zero (#930). */
export function countFindingBlocks(text: string): number {
  const lines = text.split("\n");
  const headings = lines.filter((line) => FINDING_HEADING_RE.test(line)).length;
  if (headings > 0) return headings;
  let bullets = 0;
  for (const line of lines) {
    const bullet = line.match(TOP_LEVEL_BULLET_RE);
    if (bullet && SEVERITY_RE.test(bullet[1] ?? "")) bullets += 1;
  }
  return bullets;
}

type VerdictLine = { verdict: ReviewVerdict; labelled: boolean; accepted: boolean };

/** A line with the verdict shape, and whether it states that verdict. A
    refused line still counts against an approval in reviewVerdict. */
function verdictLine(line: string): VerdictLine | null {
  const match = line.match(VERDICT_LINE_RE);
  if (!match) return null;
  const verdict = match[1] as ReviewVerdict;
  const rest = line.slice(match[0].length);
  const labelled = !match[0].trimStart().startsWith(verdict);
  const refused =
    ANY_VERDICT_TOKEN_RE.test(rest)
    || (verdict === "APPROVE" && (/^[ \t*_]*\?/.test(rest) || HEDGED_APPROVAL_RE.test(rest)))
    || (!labelled && BARE_TOKEN_SENTENCE_RE.test(rest));
  return { verdict, labelled, accepted: !refused };
}

/** Lines a reviewer wrote as its own prose. Fenced code and blockquotes hold
    examples and quoted earlier reviews, so their lines are skipped. */
function* ownProseLines(text: string): Generator<string> {
  let fence: { marker: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const token = fenceMatch[1]!;
      if (!fence) fence = { marker: token[0]!, length: token.length };
      else if (token[0] === fence.marker && token.length >= fence.length && !fenceMatch[2]!.trim()) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    yield line;
  }
}

/** The review's verdict, read from its own prose. Labelled `VERDICT:` lines
    decide, bare token lines only when no labelled line exists, and the
    deciding lines must agree. An approval must also be unanimous: any other
    verdict-shaped line, refused or naming another verdict, leaves no verdict.
    A hedged change request, a changed mind or a pasted template therefore
    cannot become an approval. */
export function reviewVerdict(text: string): ReviewVerdict | null {
  if (!/REQUEST_CHANGES|APPROVE|COMMENT/.test(text)) return null;
  const lines: VerdictLine[] = [];
  for (const line of ownProseLines(text)) {
    const found = verdictLine(line);
    if (found) lines.push(found);
  }
  const accepted = lines.filter((line) => line.accepted);
  const deciding = accepted.some((line) => line.labelled) ? accepted.filter((line) => line.labelled) : accepted;
  const verdicts = new Set(deciding.map((line) => line.verdict));
  if (verdicts.size !== 1) return null;
  const [verdict] = [...verdicts];
  if (verdict === "APPROVE" && lines.some((line) => !line.accepted || line.verdict !== "APPROVE")) return null;
  return verdict ?? null;
}

export function parseReview(text: string, ts: unknown): ReviewCardItem | null {
  const verdict = reviewVerdict(text);
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
