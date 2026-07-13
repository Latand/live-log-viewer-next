import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

function localSubscriptionAvailable(): boolean {
  const binary = process.env.LLV_CLAUDE_BINARY ?? "claude";
  const version = spawnSync(binary, ["--version"], { env: subscriptionEnvironment(), stdio: "ignore" });
  if (version.status !== 0) return false;
  const auth = spawnSync(binary, ["auth", "status"], {
    env: subscriptionEnvironment(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (auth.status !== 0) return false;
  try {
    const value = JSON.parse(auth.stdout) as Record<string, unknown>;
    return value.loggedIn === true && value.authMethod === "claude.ai" && typeof value.subscriptionType === "string";
  } catch {
    return false;
  }
}

async function waitFor(
  iterator: AsyncIterator<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 60_000,
): Promise<RuntimeEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) throw new Error("Claude event stream ended early");
          if (predicate(next.value)) return next.value;
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude integration event timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function containsText(event: RuntimeEvent, expected: string): boolean {
  if (event.kind === "delta") return event.text.includes(expected);
  if (event.kind !== "item") return false;
  return JSON.stringify(event.item).includes(expected);
}

test.skipIf(!localSubscriptionAvailable())("real Claude subscription supports late attach and restart resume", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-integration-"));
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  let recovered: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      eventStore,
      deliveryLedger,
    });
    const owner = host.attach(0)[Symbol.asyncIterator]();
    const sent = await host.send({
      id: `issue-150-original-${crypto.randomUUID()}`,
      text: "Remember marker ORCHID-150, then reply with exactly ACK-150.",
    });
    expect(sent.outcome).toBe("turn-started");
    const late = host.attach(0)[Symbol.asyncIterator]();
    await waitFor(owner, (event) => containsText(event, "ACK-150"));
    await waitFor(late, (event) => containsText(event, "ACK-150"));
    const sessionId = host.identity.sessionId;
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;

    recovered = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: process.cwd(),
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      initialEventCursor: releasedCursor,
      eventStore,
      deliveryLedger,
    });
    expect(recovered.identity.sessionId).toBe(sessionId);
    const recovery = recovered.attach((await recovered.health()).eventCursor)[Symbol.asyncIterator]();
    const recall = await recovered.send({
      id: `issue-150-recall-${crypto.randomUUID()}`,
      text: "Reply with only the marker I asked you to remember.",
    });
    expect(recall.outcome).toBe("turn-started");
    await waitFor(recovery, (event) => containsText(event, "ORCHID-150"));
  } finally {
    await host?.release();
    await recovered?.release();
  }
}, 180_000);

test.skipIf(!localSubscriptionAvailable())("real Claude permission requests reach EngineHost.answer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-claude-permission-integration-"));
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      model: "haiku",
      permissionMode: "default",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "permission-probe");
    const sent = await host.send({
      id: `issue-150-permission-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Do not answer before attempting the tool.`,
    });
    expect(sent.outcome).toBe("turn-started");
    const attention = await waitFor(events, (event) => event.kind === "attention" && event.method === "can_use_tool");
    if (attention.kind !== "attention") throw new Error("expected Claude permission attention");
    await host.answer(attention.id, { behavior: "deny", message: "Denied by the runtime integration test." });
    await waitFor(events, (event) => event.kind === "turn-ended");
  } finally {
    await host?.release();
  }
}, 180_000);
