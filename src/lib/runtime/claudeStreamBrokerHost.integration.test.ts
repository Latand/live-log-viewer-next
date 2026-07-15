import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import { pathIsInside, prepareClaudeIntegrationTestHome } from "./integrationTestHome";

const claudeBinary = process.env.LLV_CLAUDE_BINARY ?? "claude";
const resumeHome = prepareClaudeIntegrationTestHome(claudeBinary);
const permissionHome = prepareClaudeIntegrationTestHome(claudeBinary);
const bypassHome = prepareClaudeIntegrationTestHome(claudeBinary);

afterAll(() => {
  resumeHome?.cleanup();
  permissionHome?.cleanup();
  bypassHome?.cleanup();
});

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

test.skipIf(!resumeHome)("real Claude subscription supports late attach and restart resume", async () => {
  if (!resumeHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = resumeHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  let recovered: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
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
    const sessionPath = claudeTranscriptPath(process.cwd(), sessionId, resumeHome.claudeProjectsDir);
    expect(pathIsInside(resumeHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;

    recovered = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
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
    resumeHome.cleanup();
  }
}, 180_000);

test.skipIf(!permissionHome)("real Claude permission requests reach EngineHost.answer", async () => {
  if (!permissionHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = permissionHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: permissionHome.claudeConfigDir,
      claudeProjectsDir: permissionHome.claudeProjectsDir,
      env: permissionHome.env,
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
    const sessionPath = claudeTranscriptPath(process.cwd(), host.identity.sessionId, permissionHome.claudeProjectsDir);
    expect(pathIsInside(permissionHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.answer(attention.id, { behavior: "deny", message: "Denied by the runtime integration test." });
    await waitFor(events, (event) => event.kind === "turn-ended");
  } finally {
    await host?.release();
    permissionHome.cleanup();
  }
}, 180_000);

test.skipIf(!bypassHome)("real Claude bypass executes Bash without pending attention", async () => {
  if (!bypassHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = bypassHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: directory,
      binary: claudeBinary,
      claudeConfigDir: bypassHome.claudeConfigDir,
      claudeProjectsDir: bypassHome.claudeProjectsDir,
      env: bypassHome.env,
      model: "haiku",
      permissionMode: "bypassPermissions",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "bypass-probe");
    const sent = await host.send({
      id: `issue-243-bypass-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Reply after the tool completes.`,
    });
    expect(sent.outcome).toBe("turn-started");
    let sawAttention = false;
    await waitFor(events, (event) => {
      if (event.kind === "attention") sawAttention = true;
      return event.kind === "turn-ended";
    });
    expect(fs.existsSync(probePath)).toBeTrue();
    expect(sawAttention).toBeFalse();
    expect((await host.health()).pendingAttention).toEqual([]);
  } finally {
    await host?.release();
    bypassHome.cleanup();
  }
}, 180_000);
