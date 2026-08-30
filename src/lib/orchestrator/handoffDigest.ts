import fs from "node:fs";
import path from "node:path";

import type { HeadlessSpawnAvailability } from "@/lib/accounts/contracts";
import { CODEX_LUNA_MODEL } from "@/lib/agent/models";
import { statePath } from "@/lib/configDir";
import type { HeadlessCodexRunRequest, HeadlessRunResult } from "@/lib/flows/exec";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { hardenedRedact } from "@/lib/view/compactText";

import { orchestratorMandateForDelivery } from "./prompt";

/* Bounded rotation handoffs (issue #1067).
 *
 * Rotation used to append a fresh handoff section to the incumbent's FULL
 * mandate, so every rotation grew the successor's mandate monotonically until
 * the designation crossed the 32000-byte structured envelope and died —
 * leaving a pending intent nobody could clear, because every retry recomposed
 * the same oversized text.
 *
 * The successor mandate is now composed from three bounded pieces: the CORE
 * mandate (everything before the first handoff section), ONE compact
 * "Rotation history" section standing in for every prior handoff, and the
 * fresh handoff for this rotation. The history is a headless summary when the
 * summarizer answers in time and a deterministic verbatim tail when it does
 * not — rotation never blocks on it. Whatever the history costs, the compose
 * step measures the delivered text against the envelope minus the launch
 * overhead and trims (history first, then the caller's notes) before the seat
 * command creates any durable intent.
 */

/** The literal heading a rotation handoff section carries, and the split
    boundary the next rotation recognizes it by. */
export const HANDOFF_HEADING = "## Handoff from your predecessor (rotation)";
/** The one section that replaces every prior handoff. */
export const HISTORY_HEADING = "## Rotation history";
/** Digest and deterministic fallback share this budget, so the history
    section costs the same whichever produced it. */
export const HISTORY_BUDGET_BYTES = 4_096;
/** AC 3: how many prior handoffs the fallback keeps verbatim, newest first. */
export const FALLBACK_HANDOFF_COUNT = 2;
export const PREDECESSOR_REPORT_CAP_BYTES = 6_000;
export const SUMMARY_INPUT_CAP_BYTES = 48_000;
/** One bounded try. Rotation waits at most this long for a nicer history. */
export const HANDOFF_DIGEST_TIMEOUT_MS = 75_000;

const DIGEST_EFFORT = "low";
const TRUNCATION_SUFFIX = " …[truncated]";
const NOTES_LABEL = "Notes from the caller:";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate by code points so a multibyte tail can never overshoot the byte
    bound, marking the cut when one happened. */
function truncateToBytes(value: string, maxBytes: number): { value: string; truncated: boolean; codePoints: number } {
  if (byteLength(value) <= maxBytes) return { value, truncated: false, codePoints: [...value].length };
  const suffixBytes = byteLength(TRUNCATION_SUFFIX);
  let bytes = 0;
  let codePoints = 0;
  let output = "";
  for (const point of value) {
    const pointBytes = byteLength(point);
    if (bytes + pointBytes + suffixBytes > maxBytes) break;
    output += point;
    bytes += pointBytes;
    codePoints += 1;
  }
  return output
    ? { value: `${output}${TRUNCATION_SUFFIX}`, truncated: true, codePoints }
    : { value: "", truncated: true, codePoints: 0 };
}

/**
 * A section boundary is compared as a whole line, so the line endings have to
 * agree first: a mandate that made a round trip through a CRLF surface splits
 * into `"## Rotation history\r"` lines that match no heading, the split finds
 * no sections, and every stacked handoff survives as "core" — the exact
 * stacking this module exists to remove. CRLF and lone CR collapse to LF
 * before any comparison or rendering.
 */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

/**
 * Marker hygiene: any text that carries its own Markdown heading would become
 * a section boundary for the NEXT rotation's split, and one stray line would
 * resurrect the stacking this module exists to remove. Headings become list
 * items before anything is rendered.
 *
 * This runs over every piece of the fresh block that is not composed here —
 * the digest, prior handoff bodies, the caller's notes and the board task
 * text — because all four are caller- or model-controlled and any of them can
 * contain a line reading `## Rotation history`. The core mandate is exempt on
 * purpose: it is the operator's own prose, its real headings must survive, and
 * `splitMandate` has already proved it holds neither reserved heading.
 */
export function normalizeMarkers(value: string): string {
  return normalizeLineEndings(value).replace(/^#{1,6}[ \t]+/gm, "- ");
}

export interface SplitMandate {
  /** Everything before the first history/handoff section. */
  core: string;
  /** The previous rotation-history body, heading removed. */
  history: string | null;
  /** Prior handoff bodies, oldest first, headings removed. */
  handoffs: string[];
}

/**
 * Split a mandate on its section boundaries. A boundary is a line equal to a
 * section heading — after line endings are normalized, so a mandate that made a
 * round trip through a CRLF surface still splits — and `### ` sub-headings
 * inside a body (the fallback renders them) never split. Applied to whichever
 * base the rotation uses (the request's mandate or the incumbent's stored one),
 * because the desktop rotate draft prefills its textarea from the stored
 * mandate and posts the stacked text back explicitly.
 */
export function splitMandate(mandate: string): SplitMandate {
  const core: string[] = [];
  const historyParts: string[] = [];
  const handoffs: string[] = [];
  let kind: "history" | "handoff" | null = null;
  let body: string[] = [];
  const close = (): void => {
    const section = body.join("\n").trim();
    if (section) {
      if (kind === "history") historyParts.push(section);
      else if (kind === "handoff") handoffs.push(section);
    }
    body = [];
  };
  for (const line of normalizeLineEndings(mandate).split("\n")) {
    if (line === HISTORY_HEADING || line === HANDOFF_HEADING) {
      close();
      kind = line === HISTORY_HEADING ? "history" : "handoff";
      continue;
    }
    if (kind === null) core.push(line);
    else body.push(line);
  }
  close();
  return {
    core: core.join("\n").trimEnd(),
    /* A malformed mandate carrying several history sections collapses into
       one; the next split then sees exactly one boundary of each kind. */
    history: historyParts.length ? historyParts.join("\n\n") : null,
    handoffs,
  };
}

/** The fresh handoff, in pieces, so compose can trim the caller's notes
    without re-deriving the rest. */
export interface HandoffParts {
  header: string[];
  tasks: string | null;
  notes: string | null;
}

export interface ComposeInput {
  core: string;
  /** Rendered digest or fallback body, already within HISTORY_BUDGET_BYTES. */
  history: string | null;
  handoff: HandoffParts;
  /** Structured envelope minus the launch overhead of the delivering mode. */
  budgetBytes: number;
  /** The exact transform delivery applies, so measurement counts what ships. */
  deliver: (mandate: string) => string;
}

export type ComposeOutcome =
  | { kind: "fits"; mandate: string; bytes: number; historyDropped: boolean; notesTruncatedTo: number | null }
  | { kind: "too_large"; bytes: number; budgetBytes: number };

/** Assembles the pieces verbatim. Every argument reaches here already
    normalized by `composeSuccessorMandate`, which is the one entry point. */
function renderMandate(core: string, history: string | null, handoff: HandoffParts, notes: string | null): string {
  const block = [
    HANDOFF_HEADING,
    ...handoff.header,
    ...(handoff.tasks ? [handoff.tasks] : []),
    ...(notes ? [`${NOTES_LABEL}\n${notes}`] : []),
  ].join("\n\n");
  return [
    core,
    ...(history ? [`${HISTORY_HEADING}\n${history}`] : []),
    block,
  ].join("\n\n");
}

/**
 * Core + one history section + the fresh handoff, measured as delivered and
 * trimmed until it fits: history first (the successor can still read the
 * predecessor's transcript), then the caller's notes. The task list keeps its
 * existing caps and the predecessor pointer is never dropped — it is the
 * successor's only route back to the full record.
 */
export function composeSuccessorMandate(input: ComposeInput): ComposeOutcome {
  /* Marker hygiene, applied ONCE up front. Everything the successor mandate
     carries besides the operator's own core is caller-, board- or
     model-controlled — the history body, the caller's handoff notes, the board
     task text — and a single line reading `## Rotation history` inside any of
     them would become a section boundary for the NEXT rotation's split.
     Normalizing here rather than inside the render also keeps the notes trim
     monotone: the search slices text whose heading markers are already gone,
     so a longer slice never costs fewer bytes. */
  const core = normalizeLineEndings(input.core);
  const history = input.history === null ? null : normalizeMarkers(input.history);
  const handoff: HandoffParts = {
    header: input.handoff.header.map(normalizeMarkers),
    tasks: input.handoff.tasks === null ? null : normalizeMarkers(input.handoff.tasks),
    notes: input.handoff.notes === null ? null : normalizeMarkers(input.handoff.notes),
  };
  const measure = (mandate: string): number => byteLength(input.deliver(mandate));
  const full = renderMandate(core, history, handoff, handoff.notes);
  const fullBytes = measure(full);
  if (fullBytes <= input.budgetBytes) {
    return { kind: "fits", mandate: full, bytes: fullBytes, historyDropped: false, notesTruncatedTo: null };
  }
  if (history !== null) {
    const dropped = renderMandate(core, null, handoff, handoff.notes);
    const droppedBytes = measure(dropped);
    if (droppedBytes <= input.budgetBytes) {
      return { kind: "fits", mandate: dropped, bytes: droppedBytes, historyDropped: true, notesTruncatedTo: null };
    }
  }
  const historyDropped = history !== null;
  const bare = renderMandate(core, null, handoff, null);
  const bareBytes = measure(bare);
  if (bareBytes > input.budgetBytes) return { kind: "too_large", bytes: bareBytes, budgetBytes: input.budgetBytes };
  const notes = handoff.notes;
  if (!notes) return { kind: "fits", mandate: bare, bytes: bareBytes, historyDropped, notesTruncatedTo: null };
  const points = [...notes];
  let best = { mandate: bare, bytes: bareBytes, kept: 0 };
  let low = 1;
  let high = points.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderMandate(core, null, handoff, `${points.slice(0, middle).join("")}${TRUNCATION_SUFFIX}`);
    const bytes = measure(candidate);
    if (bytes <= input.budgetBytes) {
      best = { mandate: candidate, bytes, kept: middle };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { kind: "fits", mandate: best.mandate, bytes: best.bytes, historyDropped, notesTruncatedTo: best.kept };
}

/** Normalize and bound a digest body, so the history section costs the same
    whether a model or the fallback wrote it. */
export function boundHistoryBody(value: string): string | null {
  const normalized = normalizeMarkers(value).trim();
  if (!normalized) return null;
  return truncateToBytes(normalized, HISTORY_BUDGET_BYTES).value || null;
}

/**
 * AC 3: the summarizer is unavailable, slow, broken, or over budget — keep the
 * newest N handoffs verbatim (then the previous digest if room remains) inside
 * the same byte budget. A pure function of the incumbent's mandate and the
 * reason, so a rotation that falls back is fully reproducible.
 */
export function fallbackHistory(priorHistory: string | null, priorHandoffs: string[], reason: string): string | null {
  const newestFirst = [...priorHandoffs].reverse().slice(0, FALLBACK_HANDOFF_COUNT)
    .map((body) => ({ label: "### Earlier handoff", body }));
  const candidates = [
    ...newestFirst,
    ...(priorHistory ? [{ label: "### Earlier rotation history", body: priorHistory }] : []),
  ];
  if (!candidates.length) return null;
  const lead = `(verbatim — summarizer ${reason})`;
  let remaining = HISTORY_BUDGET_BYTES - byteLength(lead);
  const kept: { label: string; body: string }[] = [];
  for (const candidate of candidates) {
    const overhead = byteLength(`\n\n${candidate.label}\n`);
    if (remaining - overhead <= 0) continue;
    const body = truncateToBytes(normalizeMarkers(candidate.body).trim(), remaining - overhead).value;
    if (!body) continue;
    kept.push({ label: candidate.label, body });
    remaining -= overhead + byteLength(body);
  }
  if (!kept.length) return null;
  /* Rendered oldest-first, the order the successor reads them in. */
  return [lead, ...kept.reverse().map((piece) => `${piece.label}\n${piece.body}`)].join("\n\n");
}

/**
 * Bytes the launch path adds around the mandate. Spawn mode prepends the role
 * scaffold and a blank line before asserting the envelope; existing-mode
 * delivery asserts the delivered text alone.
 */
export function launchOverheadBytes(mode: "spawn" | "existing", roleParams: unknown): number {
  if (mode === "existing") return 0;
  const role = resolveSpawnRole({ role: "orchestrator", roleParams: roleParams ?? { mode: "standard" } });
  if (!role.ok || !role.value) return 0;
  return byteLength(role.value.scaffold) + 2;
}

export type MandatePreflight =
  | { ok: true; bytes: number; overhead: number }
  | { ok: false; bytes: number; overhead: number; bound: number; excess: number };

/**
 * AC 4: one bound decides — the delivery bound. Measured on exactly the text
 * spawn mode places after the scaffold and existing mode delivers, so a
 * mandate that passes here cannot fail the envelope assertion afterwards, and
 * one that fails never becomes a pending intent.
 */
export function mandatePreflight(mandate: string, mode: "spawn" | "existing", roleParams: unknown): MandatePreflight {
  const overhead = launchOverheadBytes(mode, roleParams);
  const bytes = byteLength(orchestratorMandateForDelivery(mandate));
  const excess = bytes + overhead - MAX_STRUCTURED_TEXT_BYTES;
  return excess > 0
    ? { ok: false, bytes, overhead, bound: MAX_STRUCTURED_TEXT_BYTES, excess }
    : { ok: true, bytes, overhead };
}

/** The actionable 413 body: what it measured, against what, and by how much. */
export function mandateTooLargeBody(refusal: Extract<MandatePreflight, { ok: false }>): Record<string, unknown> {
  return {
    error: `mandate is too large to deliver: ${refusal.bytes} bytes of mandate plus ${refusal.overhead} bytes of launch overhead exceeds the ${refusal.bound}-byte structured envelope by ${refusal.excess} bytes; shorten the mandate by at least ${refusal.excess} bytes`,
    code: "mandate_too_large",
    bytes: refusal.bytes,
    overhead: refusal.overhead,
    bound: refusal.bound,
    excess: refusal.excess,
  };
}

export interface HandoffDigestRequest {
  project: string;
  /** Artifact directory name and headless run key. */
  clientRequestId: string;
  priorHistory: string | null;
  /** Oldest first, headings removed. */
  priorHandoffs: string[];
  predecessor: { path: string; engine: "claude" | "codex" } | null;
}

export type HandoffDigestFallbackReason =
  | "unavailable" | "exhausted" | "timeout" | "failed" | "empty" | "over_budget" | "error";

export type HandoffDigestOutcome =
  | { kind: "digest"; text: string }
  | { kind: "fallback"; reason: HandoffDigestFallbackReason };

export interface HandoffDigestRuntime {
  /** `project` fences the pick to that project's allowed accounts (#1279);
      an unbound project selects across every account, as it always did. */
  resolveAccount(project: string): HeadlessSpawnAvailability | Promise<HeadlessSpawnAvailability>;
  run(request: HeadlessCodexRunRequest): Promise<HeadlessRunResult>;
  readPredecessorReport(transcript: string, engine: "claude" | "codex"): string | null;
}

export const productionDigestRuntime: HandoffDigestRuntime = {
  /* Imported at call time: the seat command is on the request path of every
     designation, and nothing about it should drag the headless runner or the
     account manager into module load. */
  resolveAccount: async (project) => {
    const { accountManager } = await import("@/lib/accounts/manager");
    return accountManager.resolveHeadlessSpawn("codex", null, [], project);
  },
  run: async (request) => {
    const { runHeadlessCodexOnce } = await import("@/lib/flows/exec");
    return await runHeadlessCodexOnce(request);
  },
  readPredecessorReport: (transcript, engine) => lastAssistantReport(transcript, engine),
};

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * The predecessor's last visible report, from a bounded tail of its transcript.
 *
 * Read through an `O_NOFOLLOW` descriptor whose device/inode must still match
 * the path, the same discipline every other transcript reader here uses: a
 * seat rotation must not be talked into reading a file the transcript path was
 * swapped for. Both engines' row shapes are recognized — Claude writes
 * `type: "assistant"` with `message.content` parts, Codex writes
 * `payload.type: "agent_message"`.
 */
function lastAssistantReport(transcript: string, engine: "claude" | "codex"): string | null {
  let data: string;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(transcript, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return null;
    const pathStat = fs.lstatSync(transcript);
    if (!pathStat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) return null;
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    data = buffer.toString("utf8");
    /* A partial first row would parse as garbage; drop it. */
    if (start > 0) data = data.slice(data.indexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  const lines = data.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(lines[index]!);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = engine === "claude" ? claudeAssistantText(row) : codexAssistantText(row);
    if (message?.trim()) return truncateToBytes(message.trim(), PREDECESSOR_REPORT_CAP_BYTES).value || null;
  }
  return null;
}

function claudeAssistantText(row: Record<string, unknown>): string | null {
  if (row.type !== "assistant") return null;
  const message = row.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .flatMap((part) => (part && typeof part === "object" && !Array.isArray(part)
      && (part as Record<string, unknown>).type === "text"
      && typeof (part as Record<string, unknown>).text === "string"
      ? [(part as Record<string, unknown>).text as string]
      : []))
    .join("\n");
}

function codexAssistantText(row: Record<string, unknown>): string | null {
  const payload = row.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  return record.type === "agent_message" && typeof record.message === "string" ? record.message : null;
}

/* AC 2 asks for an IDENTITY-FREE digest, and an instruction in the prompt is
   not a filter: the material being compacted is transcript-derived, the model
   is free to quote it back, and whatever it writes is pasted into the
   successor's mandate and re-summarized at every later rotation — one leak
   becomes permanent. `hardenedRedact` covers credentials only, so these four
   identity classes are removed DETERMINISTICALLY, on the way in to the prompt
   and again on the way out of the model. Over-redaction is the intended
   failure mode: a digest of decisions, blockers and in-flight work needs none
   of these to be useful, and the fresh handoff — which is not summarized —
   still carries the predecessor's real transcript path. */
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** The owner segment of a code-hosting URL is an account handle. */
const FORGE_OWNER = /\b((?:github|gitlab)\.com\/|bitbucket\.org\/)[A-Za-z0-9][A-Za-z0-9-]{0,38}/gi;
const AT_HANDLE = /(^|[^A-Za-z0-9_@/])@[A-Za-z0-9][A-Za-z0-9._-]{1,38}/g;
const HOME_RELATIVE_PATH = /~\/[^\s"'`)\],;]*/g;
/** Anything rooted in a real filesystem root, plus any absolute path three or
    more segments deep — which catches an arbitrary checkout layout while
    leaving two-segment API routes (`/api/board`) readable. */
const ROOTED_PATH = /(?<![A-Za-z0-9_~:/])\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|media|app|workspace|private|data|usr|proc|dev)\/[^\s"'`)\],;]*/g;
const DEEP_PATH = /(?<![A-Za-z0-9_~:/])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[^\s"'`)\],;]*/g;
/** A prefixed record id, recognized by the digits every minted one carries —
    so `agent_registry` and `account_manager` stay readable. Whatever this
    misses, the UUID rule below still empties: the prefix alone names nobody. */
const OPAQUE_ID = /\b(?:conversation|session|launch|thread|run|acct|account|agent)_(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Deterministic identity floor for the digest: emails, account handles,
    filesystem paths and opaque record ids, whoever wrote the text. */
export function identityRedact(value: string): string {
  return value
    .replace(EMAIL_ADDRESS, "[redacted-email]")
    .replace(FORGE_OWNER, "$1[redacted-handle]")
    .replace(AT_HANDLE, "$1[redacted-handle]")
    .replace(HOME_RELATIVE_PATH, "[redacted-path]")
    .replace(ROOTED_PATH, "[redacted-path]")
    .replace(DEEP_PATH, "[redacted-path]")
    .replace(OPAQUE_ID, "[redacted-id]")
    .replace(UUID, "[redacted-id]");
}

/** Credentials and identities, in that order: the whole filter every piece of
    summarizer input and the model's own output passes through. */
function redactForDigest(value: string): string {
  return identityRedact(hardenedRedact(value));
}

const DIGEST_INSTRUCTIONS = `You are compacting the rotation history of a project manager agent's mandate. Write a digest of the material below for the manager's successor. Use exactly these three headings and short bullet points under each:

Decisions:
Blockers:
In flight:

Rules: at most 3500 bytes in total. Keep only what the successor needs to act: decisions already made, blockers still open, and work in flight with its current state. Never include names, account handles, email addresses, tokens, or file paths. Do not use Markdown headings starting with "#". Do not run commands or read files; everything you need is below. Output the digest only — no preamble, no closing remarks.`;

/** Every piece of transcript-derived text is redacted before it enters the
    prompt, and the oldest handoffs drop out first when the input is too big —
    the previous digest already covers them. */
function digestPrompt(request: HandoffDigestRequest, report: string | null): string {
  const history = request.priorHistory ? redactForDigest(request.priorHistory).trim() : null;
  const tail = report ? redactForDigest(report).trim() : null;
  const handoffs = request.priorHandoffs.map((body) => redactForDigest(body).trim()).filter(Boolean);
  let total = byteLength(history ?? "") + byteLength(tail ?? "") + handoffs.reduce((sum, body) => sum + byteLength(body), 0);
  let oldest = 0;
  while (oldest < handoffs.length && total > SUMMARY_INPUT_CAP_BYTES) {
    total -= byteLength(handoffs[oldest]!);
    oldest += 1;
  }
  const kept = handoffs.slice(oldest);
  return [
    DIGEST_INSTRUCTIONS,
    `=== Previous rotation history ===\n${history ?? "(none)"}`,
    `=== Earlier handoffs, oldest first ===\n${kept.length
      ? kept.map((body, index) => `--- handoff ${index + 1} ---\n${body}`).join("\n\n")
      : "(none)"}`,
    `=== Predecessor's last report ===\n${tail ?? "(unavailable)"}`,
  ].join("\n\n");
}

/**
 * AC 2: one bounded headless Codex turn on the general-purpose model, through
 * the flows runner's own account, process-group and artifact discipline
 * (empty MCP server table via --ignore-user-config, single-agent, read-only
 * sandbox, killed as a group when the timer fires).
 *
 * One account, one attempt: a rotation must not wait on account rotation for a
 * summary it can approximate deterministically, so every unhappy answer —
 * no capacity, timeout, non-zero exit, empty or over-budget output — resolves
 * to a fallback reason instead of an error the caller has to interpret.
 */
export async function summarizeHandoffsHeadless(
  request: HandoffDigestRequest,
  runtime: HandoffDigestRuntime = productionDigestRuntime,
): Promise<HandoffDigestOutcome> {
  const availability = await runtime.resolveAccount(request.project);
  if (availability.kind === "exhausted") return { kind: "fallback", reason: "exhausted" };
  if (availability.kind !== "available") return { kind: "fallback", reason: "unavailable" };
  const report = request.predecessor
    ? runtime.readPredecessorReport(request.predecessor.path, request.predecessor.engine)
    : null;
  const artifactDir = statePath("orchestrator", "handoff-digests", request.clientRequestId);
  try {
    const result = await runtime.run({
      key: `orchestrator-handoff:${request.clientRequestId}`,
      /* A fresh empty directory: the summarizer reads only its prompt. */
      cwd: path.join(artifactDir, "cwd"),
      ["prompt"]: digestPrompt(request, report),
      model: CODEX_LUNA_MODEL,
      effort: DIGEST_EFFORT,
      account: availability.account.engine === "codex"
        ? { home: availability.account.home, managed: availability.account.kind === "managed" }
        : null,
      artifactDir,
      timeoutMs: HANDOFF_DIGEST_TIMEOUT_MS,
      sandbox: "read-only",
    });
    if (result.status === "timeout") return { kind: "fallback", reason: "timeout" };
    if (result.status !== "done") return { kind: "fallback", reason: "failed" };
    const redacted = redactForDigest(result.finalOutput).trim();
    if (!redacted) return { kind: "fallback", reason: "empty" };
    if (byteLength(redacted) > HISTORY_BUDGET_BYTES) return { kind: "fallback", reason: "over_budget" };
    const digest = normalizeMarkers(redacted).trim();
    return digest ? { kind: "digest", text: digest } : { kind: "fallback", reason: "empty" };
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}
