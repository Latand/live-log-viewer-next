import type { ServerWebSocket } from "bun";

import type { EngineEvent } from "./claude-wire";
import { arg, ReplayBuffer, sanitize, subscriptionEnv } from "./lib";
type ViewerState = { after: number };

const port = Number(arg("--port", "8987"));
const resume = arg("--resume");
const events = new ReplayBuffer<EngineEvent>(4_000);
const viewers = new Set<ServerWebSocket<ViewerState>>();
let pendingTurns = 0;
let sessionId: string | undefined;
let shuttingDown = false;

const command = [
  "claude",
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--safe-mode",
  "--system-prompt",
  "You are a deterministic runtime protocol probe. Follow each user request exactly and do not inspect files.",
  "--include-partial-messages",
  "--replay-user-messages",
  "--model",
  "haiku",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "",
];
if (resume) command.push("--resume", resume);

const claude = Bun.spawn(command, {
  cwd: import.meta.dir,
  env: subscriptionEnv(),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

function send(ws: ServerWebSocket<ViewerState>, value: unknown): void {
  ws.send(JSON.stringify(sanitize(value)));
}

function broadcast(value: unknown): void {
  for (const viewer of viewers) send(viewer, value);
}

function acceptEngineEvent(raw: EngineEvent): void {
  const event = sanitize(raw);
  if (event.type === "system" && event.subtype === "init") sessionId = event.session_id;
  if (event.type === "result") pendingTurns = Math.max(0, pendingTurns - 1);
  const item = events.push(event);
  broadcast({ kind: "event", seq: item.seq, event, active: pendingTurns > 0 });
}

async function consumeStdout(): Promise<void> {
  const reader = claude.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      acceptEngineEvent(JSON.parse(line));
    }
  }
  if (buffered.trim()) acceptEngineEvent(JSON.parse(buffered));
}

void consumeStdout().catch((error) => {
  broadcast({ kind: "broker_error", message: String(error) });
});
void new Response(claude.stderr).text().then((text) => {
  if (text.trim() && !shuttingDown) broadcast({ kind: "engine_stderr", text });
});

const server = Bun.serve<ViewerState>({
  hostname: "127.0.0.1",
  port,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/readyz") return new Response("ok");
    if (url.pathname !== "/events") return new Response("not found", { status: 404 });
    const after = Number(url.searchParams.get("after") ?? "0");
    if (server.upgrade(request, { data: { after } })) return;
    return new Response("upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) {
      viewers.add(ws);
      const replay = events.after(ws.data.after);
      send(ws, {
        kind: "hello",
        active: pendingTurns > 0,
        sessionId,
        lastSeq: events.lastSeq,
        replay,
      });
    },
    message(ws, message) {
      const request = JSON.parse(String(message));
      if (request.op !== "send" || typeof request.text !== "string") {
        send(ws, { kind: "error", message: "Expected {op:'send', text, clientMessageId}" });
        return;
      }
      const disposition = pendingTurns > 0 ? "queued" : "started";
      pendingTurns += 1;
      claude.stdin.write(
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: request.text }] },
        })}\n`,
      );
      send(ws, {
        kind: "send_ack",
        clientMessageId: request.clientMessageId,
        disposition,
        active: true,
      });
    },
    close(ws) {
      viewers.delete(ws);
    },
  },
});

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop(true);
  claude.kill("SIGTERM");
  await claude.exited;
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`BROKER_READY ws://127.0.0.1:${port}/events`);
