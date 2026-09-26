import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Manual live check; run this file with LLV_CLAUDE_PROVIDER_SMOKE=1 and a local Claude Code binary. */
test.skipIf(process.env.LLV_CLAUDE_PROVIDER_SMOKE !== "1")("Claude Code sends a Messages request and account token to the selected local provider", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-live-"));
  const priorState = process.env.LLV_STATE_DIR;
  const priorHome = process.env.LLV_CLAUDE_HOME;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_CLAUDE_HOME = path.join(root, "main");
  const secret = ["local", "live", "fixture", "token"].join("-");
  const requests: Array<{ path: string; authorized: boolean; model: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized = request.headers.get("authorization") === `Bearer ${secret}` || request.headers.get("x-api-key") === secret;
      const body = await request.json().catch(() => ({})) as { model?: unknown };
      requests.push({ path: url.pathname, authorized, model: typeof body.model === "string" ? body.model : null });
      if (url.pathname.endsWith("/v1/models")) return Response.json({ data: [{ id: "fixture-model" }] });
      if (url.pathname.endsWith("/v1/messages/count_tokens")) return Response.json({ input_tokens: 10 });
      const events = [
        ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ].map(([event, body]) => `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`).join("");
      return new Response(events, { headers: { "content-type": "text/event-stream" } });
    },
  });
  let childPid: number | null = null;
  try {
    const { createManagedClaudeAccount } = await import("./claude");
    const { accountManager } = await import("./manager");
    const { freshSpecFor } = await import("@/lib/agent/cli");
    const { claudeStructuredHostOptions } = await import("@/lib/runtime/structuredSpawn");
    const account = createManagedClaudeAccount("Stub", {
      config: { baseUrl: `http://127.0.0.1:${server.port}/zen/go`, model: "fixture-model", smallFastModel: null }, token: secret,
    });
    const context = accountManager.resolveSpawn("claude", account.id);
    const spec = freshSpecFor("claude", root, { claudeConfigDir: account.home, model: "opus" });
    const launch = claudeStructuredHostOptions({ spec, account: context }, { env: context.env, host: {} });
    const binary = process.env.LLV_CLAUDE_BINARY ?? "claude";
    const child = spawn(binary, ["-p", "--output-format", "json", "--model", launch.model!, "--dangerously-skip-permissions", "Reply with pong"], {
      cwd: root,
      env: { ...launch.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), DISABLE_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    childPid = child.pid ?? null;
    child.stdout.resume(); child.stderr.resume();
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const deadline = Date.now() + 20_000;
    while (!requests.some((request) => request.path.endsWith("/v1/messages")) && Date.now() < deadline) await Bun.sleep(100);
    const message = requests.find((request) => request.path.endsWith("/v1/messages"));
    expect(message).toEqual({ path: "/zen/go/v1/messages", authorized: true, model: "fixture-model" });
    await Promise.race([exited, Bun.sleep(2_000)]);
  } finally {
    if (childPid) { try { process.kill(childPid, "SIGTERM"); } catch { /* child already exited */ } }
    server.stop();
    if (priorState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = priorState;
    if (priorHome === undefined) delete process.env.LLV_CLAUDE_HOME; else process.env.LLV_CLAUDE_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
