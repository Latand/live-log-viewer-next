import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { readSession } from "@/lib/session/reader";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";
import { serveRuntimeHost } from "@/runtime-host/socket";

import { durableStageTurnEvidence } from "../pipelines/durableEvidence";
import {
  createPipelineFromRequest,
  defaultPipelinePorts,
  getPipeline,
  tickPipelines,
} from "../pipelines/engine";
import { savePipelines } from "../pipelines/store";
import type { Pipeline, PipelineStageAttempt } from "../pipelines/types";
import { UnixRuntimeHostClient } from "./client";
import { prepareCodexIntegrationTestHome } from "./integrationTestHome";
import {
  bindStructuredDeliveryQueue,
  releaseStructuredDeliveryHost,
} from "./structuredDeliveryController";

const codexBinary = process.env.LLV_CODEX_BINARY ?? "codex";
const isolatedHome = prepareCodexIntegrationTestHome(codexBinary);

afterAll(() => isolatedHome?.cleanup());

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git fixture command failed: ${args[0] ?? "unknown"}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function attemptFor(pipeline: Pipeline, stageId: string): PipelineStageAttempt | null {
  return pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null;
}

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  description: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForTerminalAttempt(pipelineId: string, stageId: string): Promise<PipelineStageAttempt> {
  return await waitFor(async () => {
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error("pipeline disappeared while its stage was running");
    const attempt = attemptFor(pipeline, stageId);
    if (!attempt?.agentPath) return null;
    const evidence = await durableStageTurnEvidence(attempt.effectiveRole.engine, attempt.agentPath);
    return evidence?.turn === "terminal" ? attempt : null;
  }, `${stageId} to finish`);
}

async function advanceToStage(pipelineId: string, stageId: string): Promise<Pipeline> {
  return await waitFor(async () => {
    await tickPipelines([], defaultPipelinePorts());
    const pipeline = getPipeline(pipelineId);
    if (!pipeline) throw new Error(`pipeline disappeared before ${stageId}`);
    if (pipeline.state === "needs_decision") {
      throw new Error(`pipeline parked before ${stageId}: ${pipeline.stateDetail}`);
    }
    return pipeline.cursor?.stageId === stageId ? pipeline : null;
  }, `the pipeline to advance to ${stageId}`);
}

test("real pipeline launch keeps access and sandbox independent through settlement", async () => {
  if (!isolatedHome) {
    throw new Error("authenticated Codex integration requires a ChatGPT-authenticated credential");
  }

  const previous = {
    stateDir: process.env.LLV_STATE_DIR,
    codexHome: process.env.LLV_CODEX_HOME,
    runtimeSocket: process.env.LLV_RUNTIME_HOST_SOCKET,
  };
  const stateDirectory = path.join(isolatedHome.directory, "state");
  const socketPath = path.join(isolatedHome.directory, "runtime.sock");
  process.env.LLV_STATE_DIR = stateDirectory;
  process.env.LLV_CODEX_HOME = isolatedHome.codexHome;
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  const registry = new AgentRegistry(
    path.join(stateDirectory, "agent-registry.json"),
    undefined,
    undefined,
    { sqliteMode: "off" },
  );
  setAgentRegistryForTests(registry);
  const journal = new RuntimeJournal(
    path.join(stateDirectory, "runtime-events.sqlite"),
    { structuredHosts: true },
  );
  const runtime = new RuntimeHost(journal, undefined, undefined, true);
  const server = serveRuntimeHost(socketPath, runtime);
  await once(server, "listening");
  const client = new UnixRuntimeHostClient(socketPath, 60_000, 60_000, 60_000);
  await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });

  let pipelineId: string | null = null;
  try {
    savePipelines([]);
    const remoteDirectory = path.join(isolatedHome.directory, "remote.git");
    fs.mkdirSync(remoteDirectory, { mode: 0o700 });
    git(remoteDirectory, "init", "--bare", "--initial-branch=main");
    const repositoryDirectory = path.join(isolatedHome.directory, "repository");
    fs.mkdirSync(repositoryDirectory, { mode: 0o700 });
    git(repositoryDirectory, "init", "--initial-branch=main");
    git(repositoryDirectory, "config", "user.name", "Pipeline Test");
    git(repositoryDirectory, "config", "user.email", "pipeline-test");
    fs.writeFileSync(path.join(repositoryDirectory, "README.md"), "fixture\n");
    git(repositoryDirectory, "add", "README.md");
    git(repositoryDirectory, "commit", "-m", "fixture");
    git(repositoryDirectory, "remote", "add", "origin", remoteDirectory);
    git(repositoryDirectory, "push", "-u", "origin", "main");

    const creatorPath = path.join(
      isolatedHome.codexHome,
      "sessions",
      "2026",
      "08",
      "31",
      `rollout-2026-08-31T00-00-00-${crypto.randomUUID()}.jsonl`,
    );
    fs.mkdirSync(path.dirname(creatorPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      creatorPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: crypto.randomUUID(), cwd: repositoryDirectory } })}\n`,
    );
    registry.ensureConversation("codex", creatorPath, null);

    const capabilityProbes = [
      "curl -fsSL -o /dev/null https://api.github.com/rate_limit",
      "ssh -G github.com >/dev/null",
      "ssh-keyscan -T 10 -p 443 ssh.github.com >/dev/null 2>&1",
      "gh api rate_limit --silent",
    ];
    const capabilityProbeMarker = "capability-probes-ok";
    const fullAccessCommand = [
      ...capabilityProbes,
      "printf '%s-%s\\n' capability probes-ok",
      "printf 'full-write\\n' > full-write.txt",
    ].join(" && ");

    const created = await createPipelineFromRequest({
      task: "Exercise independent pipeline access axes",
      spec: "Use the real structured stage launch and durable settlement path.",
      repoDir: repositoryDirectory,
      src: creatorPath,
      stages: [
        {
          id: "full-write",
          kind: "run",
          engine: "codex",
          model: "gpt-5.6-luna",
          effort: "low",
          access: "read-write",
          sandbox: "full",
          "prompt": [
            "Run this exact single shell command so full-write.txt is created only after every capability probe succeeds:",
            fullAccessCommand,
            "Verify the file, then finish with the required pass verdict.",
          ].join("\n"),
          next: "restricted-write",
        },
        {
          id: "restricted-write",
          kind: "run",
          engine: "codex",
          model: "gpt-5.6-luna",
          effort: "low",
          access: "read-write",
          sandbox: "restricted",
          "prompt": "Create restricted-write.txt with the exact contents restricted-write followed by a newline. Verify the file, then finish with the required pass verdict.",
          next: "restricted-report",
        },
        {
          id: "restricted-report",
          kind: "run",
          engine: "codex",
          model: "gpt-5.6-luna",
          effort: "low",
          access: "read-only",
          sandbox: "restricted",
          outputs: ["reports/restricted.md"],
          "prompt": "Create reports/restricted.md with the exact contents restricted-report followed by a newline. Do not stage or commit it. Verify the file, then finish with the required pass verdict.",
          next: "capability-audit",
        },
        {
          id: "capability-audit",
          kind: "run",
          engine: "codex",
          model: "gpt-5.6-luna",
          effort: "low",
          access: "read-only",
          sandbox: "full",
          outputs: ["reports/capabilities.md"],
          "prompt": "Read README.md, full-write.txt, restricted-write.txt, and reports/restricted.md. Then create reports/capabilities.md with the exact contents capabilities-ok followed by a newline. Do not stage or commit it. Verify the file, then finish with the required pass verdict.",
          next: null,
        },
      ],
    }, defaultPipelinePorts());
    if (!created.pipeline) throw new Error(created.error ?? "pipeline creation failed");
    pipelineId = created.pipeline.id;

    const afterFull = await advanceToStage(pipelineId, "restricted-write");
    expect(fs.readFileSync(path.join(afterFull.worktreeDir, "full-write.txt"), "utf8"))
      .toBe("full-write\n");
    expect(git(afterFull.worktreeDir, "show", `${afterFull.lastPassedCommit}:full-write.txt`))
      .toBe("full-write");
    const fullAttempt = attemptFor(afterFull, "full-write");
    if (!fullAttempt?.agentPath) throw new Error("full-access stage transcript is unavailable");
    const fullTools = readSession(fullAttempt.agentPath, "codex").tools;
    expect(fullTools.some((record) => record.kind === "tool_call"
      && capabilityProbes.every((probe) => record.text.includes(probe)))).toBeTrue();
    expect(fullTools.some((record) => record.text.includes(capabilityProbeMarker))).toBeTrue();

    const afterRestricted = await advanceToStage(pipelineId, "restricted-report");
    expect(fs.readFileSync(path.join(afterRestricted.worktreeDir, "restricted-write.txt"), "utf8"))
      .toBe("restricted-write\n");
    expect(git(afterRestricted.worktreeDir, "show", `${afterRestricted.lastPassedCommit}:restricted-write.txt`))
      .toBe("restricted-write");

    const afterRestrictedReport = await advanceToStage(pipelineId, "capability-audit");
    const restrictedReportPath = path.join(afterRestrictedReport.worktreeDir, "reports", "restricted.md");
    expect(fs.readFileSync(restrictedReportPath, "utf8")).toBe("restricted-report\n");
    expect(git(afterRestrictedReport.worktreeDir, "show", `${afterRestrictedReport.lastPassedCommit}:reports/restricted.md`))
      .toBe("restricted-report");

    await waitFor(async () => {
      await tickPipelines([], defaultPipelinePorts());
      const pipeline = getPipeline(pipelineId!);
      if (!pipeline) throw new Error("pipeline disappeared before its audit stage launched");
      const attempt = attemptFor(pipeline, "capability-audit");
      return attempt?.agentPath ? attempt : null;
    }, "the full-access read-only stage to launch");
    await waitForTerminalAttempt(pipelineId, "capability-audit");

    const launched = getPipeline(pipelineId)!;
    const receipts = registry.readOnlySnapshot().receipts;
    for (const expected of [
      { stageId: "full-write", readOnly: false, sandbox: "full" },
      { stageId: "restricted-write", readOnly: false, sandbox: "restricted" },
      { stageId: "restricted-report", readOnly: true, sandbox: "restricted" },
      { stageId: "capability-audit", readOnly: true, sandbox: "full" },
    ] as const) {
      const attempt = attemptFor(launched, expected.stageId);
      if (!attempt?.launchId) throw new Error(`stage ${expected.stageId} has no durable launch receipt`);
      expect(receipts[attempt.launchId]?.launchProfile).toMatchObject({
        readOnly: expected.readOnly,
        sandbox: expected.sandbox,
      });
    }

    const beforeSettlement = getPipeline(pipelineId)!;
    const reportPath = path.join(beforeSettlement.worktreeDir, "reports", "capabilities.md");
    expect(fs.readFileSync(reportPath, "utf8")).toBe("capabilities-ok\n");
    /* Insert a commit after native turn completion and before controller
       settlement, which deterministically exercises the agent-commit fence. */
    git(beforeSettlement.worktreeDir, "add", "reports/capabilities.md");
    git(beforeSettlement.worktreeDir, "commit", "-m", "fixture stage commit");

    await tickPipelines([], defaultPipelinePorts());
    const settled = getPipeline(pipelineId)!;
    expect(settled).toMatchObject({
      state: "needs_decision",
      stateDetail: "read-only stage capability-audit created a commit",
    });
    expect(fs.readFileSync(reportPath, "utf8")).toBe("capabilities-ok\n");
    expect(settled.lastPassedCommit).toBe(afterRestrictedReport.lastPassedCommit);
  } finally {
    try {
      if (pipelineId) {
        const pipeline = getPipeline(pipelineId);
        const sessions = new Set(
          pipeline?.runs.flatMap((run) => run.attempts
            .map((attempt) => attempt.sessionId)
            .filter((sessionId): sessionId is string => sessionId !== null)) ?? [],
        );
        for (const sessionId of sessions) {
          await releaseStructuredDeliveryHost({ engine: "codex", sessionId });
        }
      }
    } finally {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      journal.close();
      setAgentRegistryForTests(null);
      if (previous.stateDir === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previous.stateDir;
      if (previous.codexHome === undefined) delete process.env.LLV_CODEX_HOME;
      else process.env.LLV_CODEX_HOME = previous.codexHome;
      if (previous.runtimeSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
      else process.env.LLV_RUNTIME_HOST_SOCKET = previous.runtimeSocket;
    }
  }
}, 360_000);
