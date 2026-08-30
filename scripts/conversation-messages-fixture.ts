#!/usr/bin/env bun
/**
 * Synthetic transcript fixtures for `conversation_messages` (#1311).
 *
 * Generates one Codex rollout and one Claude transcript whose record mix
 * follows the proportions of real 100 MB rollouts and 30 MB Claude sessions
 * (token-count events, encrypted reasoning blobs, doubled message
 * representations, hook attachments, tool outputs that dominate the bytes)
 * without carrying a byte of real content. Deterministic under `--seed`.
 *
 *   bun scripts/conversation-messages-fixture.ts <outDir> [--codex-bytes N] [--claude-bytes N] [--seed N]
 *
 * Writes `<outDir>/codex/rollout-<stamp>-<id>.jsonl` and
 * `<outDir>/claude/<id>.jsonl`. Only ever point it at a scratch directory.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith("--"));
if (!outDir) {
  console.error("usage: bun scripts/conversation-messages-fixture.ts <outDir> [--codex-bytes N] [--claude-bytes N] [--seed N]");
  process.exit(2);
}
function flag(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? Number(args[index + 1]) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const CODEX_BYTES = flag("codex-bytes", 110 * 1024 * 1024);
const CLAUDE_BYTES = flag("claude-bytes", 30 * 1024 * 1024);
let seed = flag("seed", 1311) >>> 0;

function random(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function int(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}
function hex(length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(random() * 16).toString(16);
  return out;
}
/** Runtime-minted thread id in the shape the Codex scanner expects in a rollout name. */
function threadId(): string {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

const WORDS = ("ledger cadence harbor granite meadow signal orbit lantern quorum ripple saffron timber velvet willow zenith "
  + "anchor basalt copper drift ember fathom glacier hollow ingot juniper kestrel lumen marble nectar oriole pebble "
  + "quartz reed summit tundra umber vapor wander yarrow beacon cinder delta fjord gable heron isle keel loom mesa").split(" ");
function sentence(min: number, max: number): string {
  const count = int(min, max);
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) words.push(pick(WORDS));
  words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
  return `${words.join(" ")}.`;
}
function paragraph(min: number, max: number): string {
  const sentences: string[] = [];
  for (let i = int(min, max); i > 0; i -= 1) sentences.push(sentence(6, 18));
  return sentences.join(" ");
}
/** Tool output whose size distribution puts the bulk of the bytes into a few large results. */
function blob(): string {
  const size = pick([400, 1_200, 4_000, 9_000, 30_000, 30_000, 120_000]);
  const lines: string[] = [];
  let total = 0;
  while (total < size) {
    const line = `${hex(6)} ${sentence(4, 12)}`;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function opaque(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE64[Math.floor(random() * 64)];
  return out;
}

class Clock {
  private ms: number;
  constructor(startIso: string) { this.ms = Date.parse(startIso); }
  next(minSeconds = 1, maxSeconds = 20): string {
    this.ms += int(minSeconds * 1_000, maxSeconds * 1_000);
    return new Date(this.ms).toISOString();
  }
  same(): string { return new Date(this.ms).toISOString(); }
}

class Sink {
  bytes = 0;
  private buffered: string[] = [];
  private readonly fd: number;
  constructor(pathname: string) {
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    this.fd = fs.openSync(pathname, "w");
  }
  line(record: unknown): void {
    const text = `${JSON.stringify(record)}\n`;
    this.buffered.push(text);
    this.bytes += Buffer.byteLength(text);
    if (this.buffered.length >= 64) this.flush();
  }
  flush(): void {
    if (this.buffered.length) fs.writeSync(this.fd, this.buffered.join(""));
    this.buffered = [];
  }
  close(): void { this.flush(); fs.closeSync(this.fd); }
}

function generateCodex(pathname: string, target: number): { turns: number; records: number } {
  const sink = new Sink(pathname);
  const clock = new Clock("2026-08-30T10:00:00.000Z");
  let records = 0;
  const emit = (record: unknown) => { sink.line(record); records += 1; };
  emit({ timestamp: clock.same(), type: "session_meta", payload: { id: threadId(), timestamp: clock.same(), cwd: "/workspace/fixture", originator: "synthetic", cli_version: "0.0.0", instructions: null, source: "cli" } });
  let turns = 0;
  let calls = 0;
  const assistantMessage = (text: string) => {
    const ts = clock.next();
    emit({ timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: text } });
    emit({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
  };
  while (sink.bytes < target) {
    turns += 1;
    const userText = `Turn ${turns}: ${paragraph(1, 3)}`;
    const userTs = clock.next(5, 120);
    emit({ timestamp: userTs, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } });
    emit({ timestamp: userTs, type: "event_msg", payload: { type: "user_message", message: userText, images: [] } });
    emit({ timestamp: clock.next(), type: "turn_context", payload: { cwd: "/workspace/fixture", approval_policy: "never", sandbox_policy: { mode: "workspace-write" }, model: "synthetic-model", effort: "medium", summary: "auto" } });
    emit({ timestamp: clock.next(), type: "event_msg", payload: { type: "task_started", model_context_window: 258_400 } });
    const steps = int(6, 24);
    for (let step = 0; step < steps; step += 1) {
      emit({ timestamp: clock.next(), type: "response_item", payload: { type: "reasoning", summary: [], content: null, encrypted_content: opaque(int(1_500, 2_500)) } });
      if (random() < 0.2) emit({ timestamp: clock.next(), type: "event_msg", payload: { type: "agent_reasoning", text: paragraph(1, 3) } });
      calls += 1;
      const callId = `call_${hex(16)}`;
      if (random() < 0.7) {
        emit({ timestamp: clock.next(), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", `grep -rn ${pick(WORDS)} src/`], timeout_ms: 120_000 }), call_id: callId } });
        emit({ timestamp: clock.next(), type: "response_item", payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ output: blob(), metadata: { exit_code: 0, duration_seconds: random() * 5 } }) } });
      } else {
        emit({ timestamp: clock.next(), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: `*** Begin Patch\n*** Update File: src/${pick(WORDS)}.ts\n@@\n-${sentence(3, 8)}\n+${sentence(3, 8)}\n*** End Patch`, call_id: callId } });
        emit({ timestamp: clock.next(), type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: `Success. Updated the following files:\nM src/${pick(WORDS)}.ts` } });
      }
      emit({ timestamp: clock.next(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: calls * 900, cached_input_tokens: calls * 700, output_tokens: calls * 120, reasoning_output_tokens: calls * 40, total_tokens: calls * 1_060 }, last_token_usage: { input_tokens: 900, cached_input_tokens: 700, output_tokens: 120, reasoning_output_tokens: 40, total_tokens: 1_060 }, model_context_window: 258_400 }, rate_limits: { primary: { used_percent: int(0, 99), window_minutes: 300, resets_at: 0 }, secondary: { used_percent: int(0, 99), window_minutes: 10_080, resets_at: 0 } } } });
      if (step > 0 && step % 5 === 0) assistantMessage(`Progress ${turns}.${step}: ${paragraph(1, 2)}`);
    }
    const finalText = `Answer ${turns}: ${paragraph(2, 6)}`;
    assistantMessage(finalText);
    emit({ timestamp: clock.next(), type: "event_msg", payload: { type: "task_complete", last_agent_message: finalText } });
    if (turns % 40 === 0) {
      emit({ timestamp: clock.next(), type: "compacted", payload: { message: paragraph(6, 12) } });
      emit({ timestamp: clock.same(), type: "event_msg", payload: { type: "context_compacted" } });
    }
  }
  sink.close();
  return { turns, records };
}

function generateClaude(pathname: string, sessionId: string, target: number): { turns: number; records: number } {
  const sink = new Sink(pathname);
  const clock = new Clock("2026-08-30T10:00:00.000Z");
  let records = 0;
  let parentUuid: string | null = null;
  const envelope = (ts: string) => ({ parentUuid, isSidechain: false, userType: "external", cwd: "/workspace/fixture", sessionId, version: "0.0.0", gitBranch: "main" });
  const emit = (record: Record<string, unknown>) => {
    sink.line(record);
    records += 1;
    if (typeof record.uuid === "string") parentUuid = record.uuid;
  };
  const uuid = () => `fx${hex(30)}`;
  const assistant = (content: unknown[]) => {
    const ts = clock.next();
    emit({ ...envelope(ts), type: "assistant", uuid: uuid(), timestamp: ts, requestId: `req_${hex(20)}`, message: { id: `msg_${hex(24)}`, type: "message", role: "assistant", model: "synthetic-model", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: int(1, 40), cache_creation_input_tokens: int(0, 5_000), cache_read_input_tokens: int(10_000, 90_000), output_tokens: int(20, 900), service_tier: "standard" } } });
  };
  const attachment = (hookEvent: string, toolUseID: string) => {
    const ts = clock.next(0, 1);
    emit({ ...envelope(ts), type: "attachment", attachment: { type: "async_hook_response", hookEvent, toolUseID, content: `${hookEvent} hook completed` }, uuid: uuid(), timestamp: ts });
  };
  let turns = 0;
  while (sink.bytes < target) {
    turns += 1;
    const userText = `Turn ${turns}: ${paragraph(1, 3)}`;
    const userTs = clock.next(5, 120);
    emit({ ...envelope(userTs), type: "user", uuid: uuid(), timestamp: userTs, message: { role: "user", content: [{ type: "text", text: userText }] } });
    emit({ type: "last-prompt", lastPrompt: userText, leafUuid: parentUuid, sessionId });
    if (turns === 1) emit({ type: "ai-title", aiTitle: "Synthetic fixture session", sessionId });
    if (turns % 3 === 0) emit({ type: "mode", mode: "default", sessionId });
    const steps = int(4, 16);
    for (let step = 0; step < steps; step += 1) {
      if (random() < 0.3) assistant([{ type: "thinking", thinking: paragraph(1, 4), signature: opaque(int(1_200, 1_800)) }]);
      const toolUseID = `toolu_${hex(24)}`;
      const tool = pick(["Bash", "Read", "Grep", "Edit"] as const);
      const input = tool === "Bash"
        ? { command: `grep -rn ${pick(WORDS)} src/`, description: sentence(3, 6) }
        : tool === "Edit"
          ? { file_path: `/workspace/fixture/src/${pick(WORDS)}.ts`, old_string: sentence(3, 8), new_string: sentence(3, 8) }
          : { file_path: `/workspace/fixture/src/${pick(WORDS)}.ts` };
      assistant([{ type: "tool_use", id: toolUseID, name: tool, input }]);
      attachment("PreToolUse", toolUseID);
      const output = blob();
      const ts = clock.next();
      emit({ ...envelope(ts), type: "user", uuid: uuid(), timestamp: ts, message: { role: "user", content: [{ tool_use_id: toolUseID, type: "tool_result", content: output }] }, toolUseResult: { stdout: output, stderr: "", interrupted: false, isImage: false, noOutputExpected: false } });
      attachment("PostToolUse", toolUseID);
      if (step > 0 && step % 6 === 0) assistant([{ type: "text", text: `Progress ${turns}.${step}: ${paragraph(1, 2)}` }]);
    }
    assistant([{ type: "text", text: `Answer ${turns}: ${paragraph(2, 6)}` }]);
    const stopTs = clock.next();
    emit({ ...envelope(stopTs), type: "system", subtype: "stop_hook_summary", level: "info", hookCount: 1, hookInfos: [{ command: "synthetic-hook" }], hookErrors: [], hasOutput: false, preventedContinuation: false, stopReason: "", toolUseID: `toolu_${hex(24)}`, uuid: uuid(), timestamp: stopTs });
    if (turns % 5 === 0) emit({ type: "queue-operation", operation: "enqueue", sessionId, timestamp: clock.same() });
  }
  sink.close();
  return { turns, records };
}

const codexPath = path.join(outDir, "codex", `rollout-2026-08-30T10-00-00-${threadId()}.jsonl`);
const claudeSession = threadId();
const claudePath = path.join(outDir, "claude", `${claudeSession}.jsonl`);
const startedAt = Date.now();
const codex = generateCodex(codexPath, CODEX_BYTES);
const claude = generateClaude(claudePath, claudeSession, CLAUDE_BYTES);
console.log(JSON.stringify({
  codex: { path: codexPath, bytes: fs.statSync(codexPath).size, ...codex },
  claude: { path: claudePath, bytes: fs.statSync(claudePath).size, ...claude },
  elapsedMs: Date.now() - startedAt,
}, null, 2));
