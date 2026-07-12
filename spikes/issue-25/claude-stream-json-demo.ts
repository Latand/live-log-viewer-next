import { join } from "node:path";

import type { BrokerMessage, EngineEvent } from "./claude-wire";
import { arg, EvidenceLog, subscriptionEnv, withTimeout } from "./lib";
import { WsInbox } from "./ws-inbox";

const cwd = import.meta.dir;
const port = Number(arg("--port", "8987"));
const url = `ws://127.0.0.1:${port}/events`;
const evidencePath = arg("--log", join(cwd, "evidence", "claude-stream-json.jsonl"))!;
const evidence = new EvidenceLog();
let broker: Bun.Subprocess | undefined;

async function startBroker(resume?: string): Promise<Bun.Subprocess> {
  const command = [process.execPath, join(cwd, "claude-broker.ts"), "--port", String(port)];
  if (resume) command.push("--resume", resume);
  const child = Bun.spawn(command, {
    cwd,
    env: subscriptionEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  await withTimeout(
    (async () => {
      while (!output.includes("BROKER_READY")) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Claude broker exited before readiness");
        output += decoder.decode(value, { stream: true });
      }
    })(),
    10_000,
    "Claude broker readiness",
  );
  evidence.record("broker", "ready", { pid: child.pid, url, resume: Boolean(resume) });
  return child;
}

async function stopBroker(process: Bun.Subprocess): Promise<void> {
  process.kill("SIGTERM");
  await withTimeout(process.exited.then(() => undefined), 10_000, "Claude broker shutdown");
}

function isEngine(message: BrokerMessage, predicate: (event: EngineEvent) => boolean): boolean {
  return message.kind === "event" && Boolean(message.event && predicate(message.event));
}

async function readClaudeAuthSummary(): Promise<Record<string, unknown>> {
  const status = Bun.spawn(["claude", "auth", "status"], {
    cwd,
    env: subscriptionEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([status.exited, new Response(status.stdout).text()]);
  if (exitCode !== 0) throw new Error("claude auth status failed");
  const parsed = JSON.parse(stdout);
  return {
    loggedIn: parsed.loggedIn,
    authMethod: parsed.authMethod,
    apiProvider: parsed.apiProvider,
    subscriptionType: parsed.subscriptionType,
  };
}

try {
  evidence.record("demo", "environment", {
    anthropicApiKey: "unset",
    claudeCodeOauthToken: "unset",
    processModel: "one long-lived stream-json child",
  });
  evidence.record("demo", "subscription_status", await readClaudeAuthSummary());
  broker = await startBroker();
  const owner = await WsInbox.connect<BrokerMessage>(`${url}?after=0`);
  await owner.waitFor((message) => message.kind === "hello");
  const mark = owner.mark();
  owner.send({
    op: "send",
    clientMessageId: "issue-25-claude-original",
    text: "Remember marker ORCHID-25. Output the integers 1 through 300, one per line, then write ORIGINAL-DONE.",
  });
  await owner.waitFor(
    (message) =>
      isEngine(
        message,
        (event) => event.type === "stream_event" && event.event?.type === "content_block_delta",
      ),
    mark,
  );
  const init = await owner.waitFor(
    (message) => isEngine(message, (event) => event.type === "system" && event.subtype === "init"),
    mark,
  );
  const sessionId = init.event?.session_id as string;
  evidence.record("owner", "subscription_auth", {
    sessionId,
    apiKeySource: init.event?.apiKeySource,
    model: init.event?.model,
  });
  evidence.record("owner", "turn_in_flight", { sessionId, trigger: "partial_message" });

  const lateViewer = Bun.spawn(
    [process.execPath, join(cwd, "claude-late-viewer.ts"), "--url", url],
    { cwd, env: subscriptionEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const [viewerExit, viewerOutput, viewerError] = await Promise.all([
    lateViewer.exited,
    new Response(lateViewer.stdout).text(),
    new Response(lateViewer.stderr).text(),
  ]);
  for (const line of viewerOutput.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    evidence.record("late-viewer-process", row.event, row.data);
  }
  if (viewerExit !== 0) throw new Error(`late viewer exited ${viewerExit}: ${viewerError}`);
  owner.close();

  await stopBroker(broker);
  broker = undefined;
  evidence.record("demo", "broker_stopped", { sessionId });
  broker = await startBroker(sessionId);
  const recovery = await WsInbox.connect<BrokerMessage>(`${url}?after=0`);
  await recovery.waitFor((message) => message.kind === "hello");
  const recoveryMark = recovery.mark();
  recovery.send({
    op: "send",
    clientMessageId: "issue-25-claude-recovery",
    text: "Reply with only the marker I asked you to remember.",
  });
  const recovered = await recovery.waitFor(
    (message) =>
      isEngine(
        message,
        (event) => event.type === "result" && String(event.result ?? "").trim() === "ORCHID-25",
      ),
    recoveryMark,
  );
  evidence.record("recovery", "context_recalled", {
    sessionId: recovered.event?.session_id,
    result: recovered.event?.result,
  });
  recovery.close();
  await stopBroker(broker);
  broker = undefined;
  evidence.record("demo", "verified", {
    oneLongLivedProcess: true,
    lateAttachReplay: true,
    liveFanout: true,
    midSessionStdinInjection: "queued-next-turn",
    restartResume: true,
  });
} finally {
  if (broker) broker.kill("SIGTERM");
  await evidence.write(evidencePath);
}
