import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ResumeSpec } from "@/lib/agent/cli";
import { agentRegistry, type SpawnReceipt } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { logEvent } from "@/lib/events";
import { inboxImageExt, MAX_INBOX_IMAGE_BYTES } from "@/lib/imagePolicy";
import { INBOX_DIR } from "@/lib/inbox";
import { normalizeResumePanesFile, type ResumePaneRecord, type ResumePanesFile } from "@/lib/resumePanesFile";
import { procBackend } from "@/lib/proc";
import { listFiles } from "@/lib/scanner";
import { isHelperArgv, pidAlive, readArgv, readPpid } from "@/lib/scanner/process";
import {
  composerLine,
  detectBlockingGate,
  detectStartupGate,
  isShellCommand,
  parseScreenMenu,
  READY_MARKERS,
  screenTail,
} from "@/lib/status";

export { READY_MARKERS, screenTail } from "@/lib/status";

const TMUX = "tmux";
const CANONICAL_EXTERNAL_SESSION = "agents";
/* Outlives the 10 s /api/files poll so the pane map is not rebuilt every
   request; a post-kill rebuild passes fresh=true to bypass the memo. */
const PANE_MAP_TTL_MS = 12_000;
const MAX_ANCESTRY_HOPS = 64;

export interface InboxImagePayload {
  base64: string;
  mime: string;
}

export interface ImagePayloadResult {
  images: InboxImagePayload[];
  error: { error: string; status: number } | null;
}

/** Decoded byte length a base64 string produces, accounting for `=` padding;
    lets the size check agree exactly with what Buffer.from(..., "base64")
    will later decode, without decoding it twice. */
function base64DecodedLength(base64: string): number {
  if (!base64.length) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Normalises and validates a request's image list; the legacy single `image`
 * field folds in. Returns the first problem — a malformed entry, unsupported
 * mime, or oversize payload — as an HTTP error instead of silently dropping
 * the image and letting the request succeed short one attachment.
 */
export function collectImagePayloads(body: { image?: unknown; images?: unknown }): ImagePayloadResult {
  const raw = Array.isArray(body.images) ? body.images : body.image && typeof body.image === "object" ? [body.image] : [];
  const images: InboxImagePayload[] = [];
  for (const entry of raw) {
    const base64 = entry && typeof entry === "object" ? (entry as { base64?: unknown }).base64 : undefined;
    const mime = entry && typeof entry === "object" ? (entry as { mime?: unknown }).mime : undefined;
    if (typeof base64 !== "string" || !base64) {
      return { images: [], error: { error: "invalid image", status: 400 } };
    }
    if (inboxImageExt(typeof mime === "string" ? mime : "") === null) {
      return { images: [], error: { error: "unsupported image type", status: 415 } };
    }
    if (base64DecodedLength(base64) > MAX_INBOX_IMAGE_BYTES) {
      return { images: [], error: { error: "image is too large (10 MB limit)", status: 413 } };
    }
    images.push({ base64, mime: mime as string });
  }
  return { images, error: null };
}

/** A resolved tmux target in `session:window.pane` form (e.g. `0:1.0`). */
export type TmuxTarget = string;

/** One pane, addressed two ways: the display coordinates shown in the UI and
    the stable `%N` pane id. Coordinates renumber as windows close (this repo's
    users run `renumber-windows on`), so anything that acts on a pane later —
    a kill in particular — must go through `paneId`. */
export interface PaneRef {
  target: TmuxTarget;
  paneId: string;
  windowName?: string;
}

/** A pane listing has three meaningful states. A missing tmux server is an
    expected absence; a command failure is uncertain observation and callers
    that might resume an agent must stop there. */
export type PaneObservation =
  | { kind: "available"; panes: Map<number, PaneRef> }
  | { kind: "no-server" }
  | { kind: "failure"; error: string };

let paneMemo: { at: number; observation: PaneObservation } | null = null;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The service endpoint is intentionally an environment contract. During the
    migration the old /tmp server remains reachable until this flag is enabled. */
export function externalTmuxMode(): boolean {
  return process.env.LLV_LEGACY_TMUX_EXTERNAL === "1";
}

export function tmuxEndpoint(): string {
  return process.env.TMUX_TMPDIR || "/tmp";
}

/** Runs tmux with an explicit argv (no shell) and optional stdin payload. */
function runTmux(args: string[], input?: Buffer | string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TMUX, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMUX_TMPDIR: tmuxEndpoint() } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** pane_pid → pane map from `tmux list-panes -a`, memoised for a few seconds.
    `fresh` bypasses the memo — a rebuild right after a kill must observe the
    pane's absence immediately, or the killed session ghosts back in. */
export async function panePidMap(fresh = false): Promise<PaneObservation> {
  const now = Date.now();
  if (!fresh && paneMemo && now - paneMemo.at < PANE_MAP_TTL_MS) return paneMemo.observation;

  const map = new Map<number, PaneRef>();
  let result: RunResult;
  try {
    result = await runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{window_name}",
    ]);
  } catch (error) {
    return { kind: "failure", error: error instanceof Error ? error.message : String(error) };
  }
  if (result.code !== 0) {
    const error = result.stderr.trim() || `tmux list-panes exited ${result.code ?? "without a status"}`;
    if (/no server running on|failed to connect to server/i.test(error)) return { kind: "no-server" };
    return { kind: "failure", error };
  }
  for (const line of result.stdout.split("\n")) {
    const [target = "", paneId = "", pidRaw = "", windowName = ""] = line.split("\t");
    const panePid = Number(pidRaw.trim());
    if (target.trim() && paneId.startsWith("%") && Number.isInteger(panePid) && panePid > 0) {
      map.set(panePid, { target: target.trim(), paneId: paneId.trim(), windowName: windowName.trim() });
    }
  }
  const observation: PaneObservation = { kind: "available", panes: map };
  paneMemo = { at: now, observation };
  return observation;
}

/**
 * Walks the /proc ppid chain up from `pid` until it lands on a tmux pane pid.
 * Returns the pane target the process lives in, or null when it is outside
 * tmux. The walk stops at claude daemon/pty helpers: a session hosted under
 * the background daemon has no pane of its own, and continuing upward would
 * hit the pane of whichever agent started the daemon — send-keys would then
 * type into that unrelated agent.
 */
export async function resolveTarget(pid: number): Promise<TmuxTarget | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const observation = await panePidMap();
  if (observation.kind !== "available") return null;
  const { panes } = observation;
  if (panes.size === 0) return null;

  const seen = new Set<number>();
  let cursor: number | null = pid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS && cursor !== null && cursor > 1; hop += 1) {
    const hit = panes.get(cursor);
    if (hit) return hit.target;
    if (seen.has(cursor) || isHelperArgv(readArgv(cursor))) break;
    seen.add(cursor);
    cursor = readPpid(cursor);
  }
  return null;
}

/**
 * Scanner-known pids that are currently running. The web caller may only target
 * one of these — an arbitrary pid from the request is never trusted directly.
 */
export async function knownLivePids(): Promise<Set<number>> {
  const pids = new Set<number>();
  for (const entry of await listFiles()) {
    if (entry.pid !== null && entry.proc === "running" && pidAlive(entry.pid)) pids.add(entry.pid);
  }
  return pids;
}

/** Resolves and revalidates a request pid against the scanner's live set. */
export async function targetForKnownPid(pid: number): Promise<TmuxTarget | null | "unknown"> {
  const live = await knownLivePids();
  if (!live.has(pid)) return "unknown";
  return resolveTarget(pid);
}

/** Resolves a scanner-approved pid only. Transcript-to-pane policy lives in
    agent/transcriptHost so resource observation and delivery cannot diverge. */
export async function resolveRequestedTmuxTarget(pid: number | null): Promise<TmuxTarget | null> {
  if (pid !== null) {
    const target = await targetForKnownPid(pid);
    if (target !== "unknown" && target !== null) return target;
  }
  return null;
}

const PASTE_SETTLE_MS = 250;
const SUBMIT_VERIFY_TRIES = 4;
const SUBMIT_VERIFY_DELAY_MS = 400;
const GATE_SETTLE_MS = 700;

/**
 * Per-pane send serialization. Two concurrent deliveries into one pane
 * interleave their paste/Enter sequences and corrupt both messages — a real
 * failure mode every upstream tmux orchestrator guards against. The chain
 * keyed by target runs deliveries strictly one after another; an earlier
 * failure never blocks the next sender.
 */
const paneLocks = new Map<string, Promise<unknown>>();

export async function withPaneLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const prev = paneLocks.get(target) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  paneLocks.set(
    target,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (paneLocks.get(target) !== run && paneLocks.size > 256) paneLocks.clear();
  }
}

/**
 * Pre-send pane check: the message must land in an agent CLI's composer.
 * A pane whose foreground process fell back to the shell would execute the
 * text as shell commands; auto-answerable startup gates (trust folder, resume
 * picker) get an Enter and one settle round; approval/rate-limit walls refuse
 * the send with a readable reason — a blind paste there vanishes or, worse,
 * answers a question the user never saw.
 */
async function ensureDeliverable(target: TmuxTarget): Promise<void> {
  const command = await paneCommand(target);
  if (command === null) throw new Error("tmux pane is unavailable");
  if (isShellCommand(command)) {
    logEvent("gate", { target, result: "error", reason: "shell_prompt" });
    throw new Error("pane has no agent (plain shell) — message was not sent");
  }
  for (let round = 0; round < 3; round += 1) {
    const screen = await paneScreen(target);
    const menu = parseScreenMenu(screen);
    if (menu !== null) {
      logEvent("gate", { target, result: "error", reason: "select_dialog" });
      throw new Error("agent is waiting for a choice in the pane — answer before sending a new message");
    }
    const blocking = detectBlockingGate(screen);
    if (blocking !== null) {
      logEvent("gate", { target, result: "error", reason: blocking });
      throw new Error(
        blocking === "rate_limit"
          ? "agent hit a rate limit — message was not sent"
          : "agent is waiting for confirmation in the pane — answer before sending a new message",
      );
    }
    const startup = detectStartupGate(screen);
    if (startup !== null) {
      logEvent("gate", { target, result: "ok", reason: startup });
      await runTmux(["send-keys", "-t", target, "Enter"]);
      await sleep(GATE_SETTLE_MS);
      continue;
    }
    return;
  }
}

/**
 * Pushes `text` into the pane, then presses Enter. A dedicated tmux buffer plus
 * paste-buffer carries multi-line payloads reliably where send-keys would not.
 * `-p` wraps the paste in bracketed-paste markers when the pane's application
 * enabled them (both agent CLIs do): without the markers raw \n bytes hit the
 * TUI as keystrokes and line breaks collapse or vanish inside the message.
 *
 * The TUI ingests a bracketed paste asynchronously, so an Enter that lands
 * mid-ingest gets swallowed and the message sits in the composer unsent. The
 * paste therefore gets a settle delay, and afterwards the composer is polled:
 * while it still shows the head of the text (or a collapsed «[Pasted text …]»
 * chip), Enter is pressed again. An extra Enter on an already-empty composer
 * is a no-op in both CLIs, so a false positive here costs nothing.
 */
export async function sendText(target: TmuxTarget, text: string): Promise<void> {
  await withPaneLock(target, async () => {
    try {
      await ensureDeliverable(target);
      await sendTextUnlocked(target, text);
      logEvent("send", { target, result: "ok", meta: { bytes: text.length } });
    } catch (error) {
      logEvent("send", { target, result: "error", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

/** The raw paste+Enter sequence; callers must hold the pane lock. */
async function sendTextUnlocked(target: TmuxTarget, text: string): Promise<void> {
  const bufferName = `viewer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const load = await runTmux(["load-buffer", "-b", bufferName, "-"], Buffer.from(text, "utf8"));
  if (load.code !== 0) throw new Error(load.stderr.trim() || "could not load tmux buffer");

  const paste = await runTmux(["paste-buffer", "-d", "-p", "-b", bufferName, "-t", target]);
  if (paste.code !== 0) throw new Error(paste.stderr.trim() || "could not paste text into pane");

  await sleep(PASTE_SETTLE_MS);
  const enter = await runTmux(["send-keys", "-t", target, "Enter"]);
  if (enter.code !== 0) throw new Error(enter.stderr.trim() || "could not press Enter");

  const head = text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 32) ?? "";
  for (let round = 0; round < SUBMIT_VERIFY_TRIES; round += 1) {
    await sleep(SUBMIT_VERIFY_DELAY_MS);
    const line = composerLine(await paneScreen(target));
    const stillUnsent = (head !== "" && line.includes(head)) || line.includes("[Pasted text");
    if (!stillUnsent) return;
    await runTmux(["send-keys", "-t", target, "Enter"]);
  }
}

/**
 * Interrupts whatever the pane's foreground CLI is doing by sending Escape —
 * both Claude Code and Codex CLI treat it as a safe, reversible interrupt key.
 */
export async function sendInterrupt(target: TmuxTarget): Promise<void> {
  const res = await runTmux(["send-keys", "-t", target, "Escape"]);
  logEvent("interrupt", { target, result: res.code === 0 ? "ok" : "error", reason: res.stderr.trim() || undefined });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "could not send Escape");
}

/**
 * Current shell pid of the pane at `target`, or null when no such pane exists.
 * Used to re-verify a pane's identity right before killing it by display
 * coordinates — tmux renumbers `session:window.pane` targets as windows close,
 * so coordinates recorded earlier may point at a different pane by kill time.
 */
export async function panePidOf(target: TmuxTarget): Promise<number | null> {
  const res = await runTmux(["display-message", "-p", "-t", target, "#{pane_pid}"]).catch(() => null);
  const pid = res && res.code === 0 ? Number(res.stdout.trim()) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Kills the tmux pane hosting a conversation's agent. The window goes with it
 * when this was its only pane — the case for every window the viewer spawns.
 */
export async function killPane(target: TmuxTarget): Promise<void> {
  const res = await runTmux(["kill-pane", "-t", target]);
  logEvent("kill", { target, result: res.code === 0 ? "ok" : "error", reason: res.stderr.trim() || undefined });
  if (res.code !== 0) throw new Error(res.stderr.trim() || "could not close tmux pane");
}

/**
 * The tmux session the user is actually looking at: the attached client with
 * the freshest activity wins; a detached server falls back to the most recent
 * session; no server at all yields a fresh detached «agents» session.
 */
export async function activeTmuxSession(): Promise<string> {
  if (externalTmuxMode()) {
    const healthy = await runTmux(["has-session", "-t", CANONICAL_EXTERNAL_SESSION]).catch(() => null);
    if (!healthy || healthy.code !== 0) {
      throw new Error("external legacy tmux supervisor is unavailable; refusing to create a container-owned server");
    }
    return CANONICAL_EXTERNAL_SESSION;
  }
  const clients = await runTmux(["list-clients", "-F", "#{client_activity} #{client_session}"]).catch(() => null);
  const pick = (stdout: string) => {
    let best: { at: number; name: string } | null = null;
    for (const line of stdout.split("\n")) {
      const sep = line.indexOf(" ");
      if (sep < 0) continue;
      const at = Number(line.slice(0, sep));
      const name = line.slice(sep + 1).trim();
      if (name && Number.isFinite(at) && (!best || at > best.at)) best = { at, name };
    }
    return best?.name ?? null;
  };
  if (clients && clients.code === 0) {
    const name = pick(clients.stdout);
    if (name) return name;
  }
  const sessions = await runTmux(["list-sessions", "-F", "#{session_activity} #{session_name}"]).catch(() => null);
  if (sessions && sessions.code === 0) {
    const name = pick(sessions.stdout);
    if (name) return name;
  }
  /* A detached session created without a size falls back to 80x24 and
     reflows every agent TUI into an unreadable strip; a generous fixed size
     keeps captures and screen-scrape detection stable until a client attaches. */
  const created = await runTmux(["new-session", "-d", "-x", "220", "-y", "50", "-s", "agents"]);
  if (created.code !== 0 && !/duplicate session/.test(created.stderr)) {
    throw new Error(created.stderr.trim() || "could not create tmux session");
  }
  return "agents";
}

/**
 * Windows opened for resumed conversations, keyed by transcript path. A
 * resumed agent writes its new turns into a fresh transcript file, so the
 * conversation the user keeps typing into never gets a live pid of its own —
 * without this registry every follow-up message would boot yet another
 * resume window.
 *
 * The records store a `%N` pane id, and pane ids are only unique within one
 * tmux server lifetime: when the server restarts, tmux hands the same `%N` out
 * to an unrelated pane. So the file is stamped with the server pid it was
 * written under — a lookup against a different live server discards every
 * record wholesale rather than pasting a message into whatever agent now
 * occupies a reused pane id. The window-name check alone cannot catch this:
 * every resumed pane of an engine shares one constant name (`claude-resume` /
 * `codex-resume`), so a reused id passes it and the message is misrouted.
 */
const RESUME_PANES_FILE = statePath("resume-panes.json");

let resumePanes: Map<string, ResumePaneRecord> | null = null;
/** Server pid the in-memory map is scoped to, mirrored from/to disk. */
let resumePanesServerPid: number | null = null;

function loadResumePanes(): Map<string, ResumePaneRecord> {
  if (resumePanes) return resumePanes;
  resumePanes = new Map();
  resumePanesServerPid = null;
  try {
    const file = normalizeResumePanesFile(JSON.parse(fs.readFileSync(RESUME_PANES_FILE, "utf8")));
    resumePanesServerPid = file.serverPid;
    for (const [key, value] of Object.entries(file.panes)) {
      if (value && typeof value.paneId === "string" && typeof value.windowName === "string") {
        resumePanes.set(key, value);
      }
    }
  } catch {
    /* first run or unreadable cache: start empty */
  }
  return resumePanes;
}

function persistResumePanes(): void {
  if (!resumePanes) return;
  try {
    fs.mkdirSync(path.dirname(RESUME_PANES_FILE), { recursive: true });
    const file: ResumePanesFile = { serverPid: resumePanesServerPid, panes: Object.fromEntries(resumePanes) };
    fs.writeFileSync(RESUME_PANES_FILE, JSON.stringify(file));
  } catch {
    /* best-effort: a lost cache only costs one extra resume window */
  }
}

/**
 * Pid of the running tmux server, or null when no server (hence no session)
 * exists. The `%N` pane-id namespace is scoped to this pid; a changed pid means
 * every stored id belongs to a dead server and must not be trusted.
 */
export async function tmuxServerPid(): Promise<number | null> {
  const res = await runTmux(["display-message", "-p", "#{pid}"]).catch(() => null);
  const pid = res && res.code === 0 ? Number(res.stdout.trim()) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function tmuxServerIdentity(): Promise<string | null> {
  const pid = await tmuxServerPid();
  return pid === null ? null : procBackend.processIdentity(pid);
}

/**
 * The resume-pane map scoped to the live server: when the current server pid
 * differs from the one the records were written under, they belong to a
 * restarted server (pane ids reused) and are dropped before any is trusted.
 */
function resumePanesForServer(serverPid: number): Map<string, ResumePaneRecord> {
  const map = loadResumePanes();
  if (resumePanesServerPid !== serverPid) {
    map.clear();
    resumePanesServerPid = serverPid;
    persistResumePanes();
  }
  return map;
}

export interface SpawnedPane {
  /** Stable `%N` pane id used for tmux commands. */
  paneId: string;
  /** Human-readable `session:window.pane` shown in the UI. */
  display: TmuxTarget;
  /** Shell pid of the pane, set on freshly spawned windows: handoff lineage
      matches a later-born conversation to its source through this pid. */
  panePid?: number;
  receipt?: SpawnReceipt;
}

/** Resume records scoped to the current tmux server. Callers still have to
    compare a record's pane pid and engine with their observed host. */
export async function resumePaneRecords(): Promise<{ serverPid: number; records: Map<string, ResumePaneRecord> } | null> {
  const serverPid = await tmuxServerPid();
  if (serverPid === null) return null;
  return { serverPid, records: new Map(resumePanesForServer(serverPid)) };
}

/** Saves a fully identified resume pane. A missing pane pid deliberately
    leaves no record: a later lookup must discover a real live process or
    perform one controlled resume instead of trusting a reusable pane id. */
export async function rememberResumePane(transcriptPath: string, spec: ResumeSpec, pane: SpawnedPane): Promise<void> {
  if (!pane.panePid) return;
  const serverPid = await tmuxServerPid();
  if (serverPid === null) return;
  resumePanesForServer(serverPid).set(transcriptPath, {
    paneId: pane.paneId,
    panePid: pane.panePid,
    windowName: spec.windowName,
    engine: spec.engine,
  });
  persistResumePanes();
}

export interface PaneInfo {
  windowName: string;
  command: string;
  display: TmuxTarget;
}

/** Window name, foreground command and display target of a pane, when it exists. */
export async function paneInfo(paneId: string): Promise<PaneInfo | null> {
  const res = await runTmux([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{window_name}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}",
  ]).catch(() => null);
  const parts = res && res.code === 0 ? res.stdout.trim().split("\t") : null;
  if (!parts || parts.length !== 3) return null;
  return { windowName: parts[0] ?? "", command: parts[1] ?? "", display: parts[2] ?? paneId };
}

/** Drops a transcript's resume-window record, e.g. after its pane was killed. */
export function forgetResumePane(transcriptPath: string): void {
  if (loadResumePanes().delete(transcriptPath)) persistResumePanes();
}

const SPAWN_READY_TIMEOUT_MS = 60_000;
const SPAWN_POLL_MS = 1_000;
const SPAWN_STABLE_ROUNDS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function cdCommandForCwd(cwd: string): string {
  return `cd -- ${shellSingleQuote(cwd)}`;
}

async function paneCommand(target: TmuxTarget): Promise<string | null> {
  const res = await runTmux(["display-message", "-p", "-t", target, "#{pane_current_command}"]).catch(() => null);
  return res && res.code === 0 ? res.stdout.trim() : null;
}

export async function paneScreen(target: TmuxTarget): Promise<string> {
  const res = await runTmux(["capture-pane", "-p", "-t", target]).catch(() => null);
  return res && res.code === 0 ? res.stdout : "";
}

export async function sendKeys(target: TmuxTarget, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const res = await runTmux(["send-keys", "-t", target, ...keys]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "could not send keys");
}

/**
 * Opens a new window in the user's current tmux session, boots the resumed
 * agent there, waits until the CLI is actually accepting input, then pastes
 * the text. The window runs the login shell and the agent command is typed
 * into it, so the pane survives even when the agent CLI exits early — a window
 * created with the agent as its direct command would close on exit and the
 * later paste would fail with "can't find window".
 *
 * Readiness is polled instead of a fixed delay: `claude --resume` on a large
 * session first shows a «Resume from summary» picker, which this answers with
 * Enter (summary resume). Pasting only happens once the foreground process is
 * the agent CLI — a pane that fell back to the shell would otherwise execute
 * the prompt text as a shell command.
 */
async function spawnAgentWithPromptUnchecked(spec: ResumeSpec, text: string): Promise<SpawnedPane> {
  const session = await activeTmuxSession();
  const spawned = await runTmux([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}",
    "-t",
    session + ":",
    "-n",
    spec.windowName,
    "-c",
    spec.cwd,
  ]);
  if (spawned.code !== 0) throw new Error(spawned.stderr.trim() || "could not open tmux window");
  /* The %N pane id addresses the pane even after window indexes shift; the
     display form only labels UI messages. */
  const [target = "", display = "", pidRaw = ""] = spawned.stdout.trim().split("\t");
  if (!target) throw new Error("tmux did not return a window address");
  const panePid = Number(pidRaw);

  const cwdTyped = await runTmux(["send-keys", "-t", target, "-l", cdCommandForCwd(spec.cwd)]);
  if (cwdTyped.code !== 0) throw new Error(cwdTyped.stderr.trim() || "could not type cwd into pane");
  const cwdEnter = await runTmux(["send-keys", "-t", target, "Enter"]);
  if (cwdEnter.code !== 0) throw new Error(cwdEnter.stderr.trim() || "could not enter cwd");

  /* Type the boot command literally into the fresh shell, then run it. */
  const typed = await runTmux(["send-keys", "-t", target, "-l", spec.command]);
  if (typed.code !== 0) throw new Error(typed.stderr.trim() || "could not type command into pane");
  const enter = await runTmux(["send-keys", "-t", target, "Enter"]);
  if (enter.code !== 0) throw new Error(enter.stderr.trim() || "could not start agent");

  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  let agentSeen = false;
  let answeredScreen = "";
  let previousScreen = "";
  let stableRounds = 0;
  while (Date.now() < deadline) {
    await sleep(SPAWN_POLL_MS);
    const command = await paneCommand(target);
    if (command === null) throw new Error("agent window closed immediately after launch");
    if (isShellCommand(command)) {
      if (agentSeen) {
        throw new Error(`agent exited immediately after launch: ${screenTail(await paneScreen(target))}`);
      }
      continue;
    }
    agentSeen = true;

    const screen = await paneScreen(target);
    /* Startup gates (trust-folder, resume-summary picker, other option-list
       dialogs) each default to the safe option, so Enter clears them.
       Re-answering only when the screen changed avoids hammering Enter into a
       composer that is already ready. */
    const gate = screen !== answeredScreen ? detectStartupGate(screen) : null;
    if (gate !== null) {
      logEvent("gate", { target, cwd: spec.cwd, result: "ok", reason: gate });
      await runTmux(["send-keys", "-t", target, "Enter"]);
      answeredScreen = screen;
      previousScreen = "";
      stableRounds = 0;
      continue;
    }
    if (READY_MARKERS.test(screen)) break;
    if (screen === previousScreen) {
      stableRounds += 1;
      if (stableRounds >= SPAWN_STABLE_ROUNDS) break;
    } else {
      stableRounds = 0;
      previousScreen = screen;
    }
  }

  const finalCommand = await paneCommand(target);
  if (finalCommand === null || isShellCommand(finalCommand)) {
    logEvent("spawn", { target, cwd: spec.cwd, result: "error", reason: "agent_exited_on_boot" });
    throw new Error(`agent did not start in the window: ${screenTail(await paneScreen(target))}`);
  }
  logEvent("spawn", {
    target,
    cwd: spec.cwd,
    ...(spec.transcript ? { path: spec.transcript } : {}),
    result: "ok",
    meta: { window: spec.windowName },
  });
  if (text) await sendText(target, text);
  return {
    paneId: target,
    display: display || target,
    ...(Number.isInteger(panePid) && panePid > 0 ? { panePid } : {}),
  };
}

/** Every visible legacy launch receives a durable receipt before tmux creates
    its window. Callers may later attach the engine-native transcript identity. */
export async function spawnAgentWithPrompt(spec: ResumeSpec, text: string): Promise<SpawnedPane> {
  const receipt = agentRegistry().beginSpawn(spec.engine, spec.cwd, spec.launchProfile);
  try {
    return { ...(await spawnAgentWithPromptUnchecked(spec, text)), receipt };
  } catch (error) {
    agentRegistry().failSpawn(receipt.launchId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Opens a visible shell window and types one command without agent readiness or paste handling. */
export async function spawnCommandWindow(spec: { command: string; cwd: string; windowName: string }): Promise<SpawnedPane> {
  const session = await activeTmuxSession();
  const spawned = await runTmux(["new-window", "-d", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}", "-t", session + ":", "-n", spec.windowName, "-c", spec.cwd]);
  if (spawned.code !== 0) throw new Error(spawned.stderr.trim() || "could not open tmux window");
  const [paneId = "", display = "", pidRaw = ""] = spawned.stdout.trim().split("\t");
  if (!paneId) throw new Error("tmux did not return a window address");
  for (const [args, message] of [
    [["send-keys", "-t", paneId, "-l", cdCommandForCwd(spec.cwd)], "could not type cwd into pane"],
    [["send-keys", "-t", paneId, "Enter"], "could not enter cwd"],
    [["send-keys", "-t", paneId, "-l", spec.command], "could not type command into pane"],
    [["send-keys", "-t", paneId, "Enter"], "could not start command"],
  ] as const) {
    const result = await runTmux([...args]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || message);
  }
  const panePid = Number(pidRaw);
  return { paneId, display: display || paneId, ...(Number.isInteger(panePid) && panePid > 0 ? { panePid } : {}) };
}

export interface SavedImage {
  path: string;
}

/** Stores a pasted clipboard image under the viewer inbox and returns its path. */
export function saveInboxImage(base64: string, mime: string): SavedImage {
  const ext = inboxImageExt(mime);
  if (ext === null) throw new Error("unsupported image type");
  const data = Buffer.from(base64, "base64");
  if (data.length === 0) throw new Error("invalid image data");
  if (data.length > MAX_INBOX_IMAGE_BYTES) throw new Error("image is too large");
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  /* Date.now() alone collides when both API routes save several images in a
     tight synchronous loop within the same millisecond. */
  const filePath = path.join(INBOX_DIR, `img-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`);
  fs.writeFileSync(filePath, data);
  return { path: filePath };
}

/** Removes inbox images saved for a delivery that failed before reaching the
    agent; best-effort, since a delivery that already succeeded never calls this. */
export function deleteInboxImages(paths: string[]): void {
  for (const filePath of paths) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone or unwritable: nothing more to clean up */
    }
  }
}

export interface ImagePayloadBundle {
  payload: string;
  imagePaths: string[];
}

/** Saves each image to the inbox and folds the resulting paths into the text
    payload delivered to the agent, one per line after the text. A save that
    throws mid-batch deletes the images already written, so no caller can
    orphan a partial batch. */
export function buildImagePayload(text: string, images: InboxImagePayload[]): ImagePayloadBundle {
  const imagePaths: string[] = [];
  try {
    for (const image of images) imagePaths.push(saveInboxImage(image.base64, image.mime).path);
  } catch (error) {
    deleteInboxImages(imagePaths);
    throw error;
  }
  const payload = [text, ...imagePaths].filter(Boolean).join("\n");
  return { payload, imagePaths };
}
