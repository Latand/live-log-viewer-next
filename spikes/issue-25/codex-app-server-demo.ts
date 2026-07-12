import { join } from "node:path";

import {
  type AccountReadResult,
  CodexRpcClient,
  codexEventSummary,
  type ThreadResult,
  type TurnResult,
} from "./codex-rpc";
import { arg, EvidenceLog, subscriptionEnv, withTimeout } from "./lib";

const cwd = import.meta.dir;
const repo = join(cwd, "..", "..");
const port = Number(arg("--port", "8977"));
const url = `ws://127.0.0.1:${port}`;
const evidencePath = arg("--log", join(cwd, "evidence", "codex-app-server.jsonl"))!;
const evidence = new EvidenceLog();
let server: Bun.Subprocess | undefined;

async function startServer(): Promise<Bun.Subprocess> {
  const process = Bun.spawn(["codex", "app-server", "--listen", url], {
    cwd: repo,
    env: subscriptionEnv(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  void new Response(process.stderr).text();
  await withTimeout(
    (async () => {
      while (true) {
        if ((await Promise.race([process.exited, Bun.sleep(0).then(() => undefined)])) !== undefined) {
          throw new Error("codex app-server exited before becoming ready");
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/readyz`);
          if (response.ok) return;
        } catch {}
        await Bun.sleep(50);
      }
    })(),
    10_000,
    "app-server readiness",
  );
  evidence.record("app-server", "ready", { pid: process.pid, transport: url });
  return process;
}

async function stopServer(process: Bun.Subprocess): Promise<void> {
  process.kill("SIGTERM");
  await withTimeout(process.exited.then(() => undefined), 5_000, "app-server shutdown");
}

try {
  evidence.record("demo", "environment", {
    openaiApiKey: "unset",
    transport: "websocket",
    clientProcesses: 2,
  });
  server = await startServer();
  const owner = await CodexRpcClient.connect(url, "llv_issue_25_owner");
  const account = await owner.request<AccountReadResult>("account/read", { refreshToken: false });
  evidence.record("owner", "subscription_auth", {
    accountType: account.account?.type,
    planType: account.account?.planType,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  });

  const started = await owner.request<ThreadResult>("thread/start", {
    cwd: repo,
    model: "gpt-5.4-mini",
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  const threadId = started.thread.id as string;
  evidence.record("owner", "thread_started", { threadId, path: started.thread.path });

  const mark = owner.mark();
  const turn = await owner.request<TurnResult>("turn/start", {
    threadId,
    effort: "low",
    input: [
      {
        type: "text",
        text: "Remember marker ZEBRA-25. Run the shell command `sleep 8`, then reply with exactly ORIGINAL-DONE. Follow any steering message that arrives while the command runs.",
      },
    ],
    clientUserMessageId: "issue-25-codex-original",
  });
  const turnId = turn.turn.id as string;
  await owner.waitFor(
    (message) =>
      message.method === "item/started" && message.params?.item?.type === "commandExecution",
    mark,
  );
  evidence.record("owner", "turn_in_flight", { threadId, turnId, trigger: "commandExecution" });

  const viewer = Bun.spawn(
    [
      process.execPath,
      join(cwd, "codex-late-viewer.ts"),
      "--url",
      url,
      "--thread",
      threadId,
      "--turn",
      turnId,
    ],
    { cwd: repo, env: subscriptionEnv(), stdout: "pipe", stderr: "pipe" },
  );
  const viewerOutput = new Response(viewer.stdout).text();
  const viewerError = new Response(viewer.stderr).text();
  const ownerCompleted = owner.waitFor(
    (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId,
    mark,
  );
  const [completed, viewerExit, stdout, stderr] = await Promise.all([
    ownerCompleted,
    viewer.exited,
    viewerOutput,
    viewerError,
  ]);
  for (const line of stdout.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    evidence.record("second-process", row.event, row.data);
  }
  if (viewerExit !== 0) throw new Error(`late viewer exited ${viewerExit}: ${stderr}`);
  evidence.record("owner", "turn_completed", codexEventSummary(completed));

  owner.close();
  await stopServer(server);
  server = undefined;
  evidence.record("demo", "server_stopped", { threadId });

  server = await startServer();
  const recovery = await CodexRpcClient.connect(url, "llv_issue_25_recovery");
  const resumed = await recovery.request<ThreadResult>("thread/resume", { threadId });
  evidence.record("recovery", "thread_resumed_after_restart", {
    threadId,
    persistedPath: resumed.thread?.path,
    turns: resumed.thread?.turns?.length ?? resumed.thread?.initialTurnsPage?.data?.length,
  });
  const recoveryMark = recovery.mark();
  const recall = await recovery.request<TurnResult>("turn/start", {
    threadId,
    effort: "low",
    input: [{ type: "text", text: "Reply with only the marker I asked you to remember." }],
    clientUserMessageId: "issue-25-codex-recovery",
  });
  const recallTurnId = recall.turn.id as string;
  const recallMessage = await recovery.waitFor(
    (message) =>
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage" &&
      String(message.params?.item?.text ?? "").includes("ZEBRA-25"),
    recoveryMark,
  );
  await recovery.waitFor(
    (message) =>
      message.method === "turn/completed" && message.params?.turn?.id === recallTurnId,
    recoveryMark,
  );
  evidence.record("recovery", "context_recalled", codexEventSummary(recallMessage));
  recovery.close();
  await stopServer(server);
  server = undefined;
  evidence.record("demo", "verified", {
    lateAttach: true,
    liveEvents: true,
    sameTurnSteer: true,
    restartResume: true,
  });
} finally {
  if (server) server.kill("SIGTERM");
  await evidence.write(evidencePath);
}
