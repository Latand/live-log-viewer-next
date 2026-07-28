import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MCP_TOOL_NAMES } from "@/lib/mcp/server";

import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { probeMcpRuntime } from "./mcpRuntimeProbe";
import { serveRuntimeHost } from "./socket";

test("host-admitted managed MCP probes discover the complete surface, call required reads, and exit", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

  try {
    for (const host of ["claude", "codex"]) {
      let processId: number | null = null;
      const evidence = await probeMcpRuntime({
        command: host === "claude" ? process.execPath : "/usr/bin/node",
        args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
        cwd: process.cwd(),
        env: { ...environment, LLV_TEST_HOST: host },
        runtime: {
          source: "managed",
          revision: "7".repeat(40),
          releaseId: "deploy-probe",
          artifactDigest: "a".repeat(64),
          stagedAt: "2026-07-23T08:00:00.000Z",
        },
        healthProbeCapability: admissions.issue(),
        healthProbeAdmissions: admissions,
        onProcessReady: (pid) => { processId = pid; },
      });

      expect(evidence).toMatchObject({
        ok: true,
        revision: "7".repeat(40),
        artifactDigest: "a".repeat(64),
        processReady: true,
        calls: { deploymentStatus: true, boardSnapshot: true },
      });
      expect(evidence.tools).toHaveLength(MCP_TOOL_NAMES.length);
      expect(evidence.tools).toContain("deployment_status");
      expect(evidence.tools).toContain("board_snapshot");
      expect(processId).not.toBeNull();
      expect(() => process.kill(processId!, 0)).toThrow();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("a release target naming a runtime this host never staged falls back to the bundled surface", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-missing-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const revision = "7".repeat(40);
  const runtime = {
    source: "managed" as const,
    revision,
    releaseId: "deploy-retired",
    artifactDigest: "a".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  /* The named release root is absent, exactly as after a retire or a state
     directory that never carried it. */
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    image: `viewer:${revision}`,
    container: "viewer-active",
    endpoint: "http://127.0.0.1:8898",
    revision,
    mcpRuntime: runtime,
  }));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

  try {
    const evidence = await probeMcpRuntime({
      command: "/usr/bin/node",
      args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: environment,
      runtime,
      healthProbeCapability: admissions.issue(),
      healthProbeAdmissions: admissions,
    });

    expect(evidence).toMatchObject({ ok: true, processReady: true });
    expect(evidence.tools).toHaveLength(MCP_TOOL_NAMES.length);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("absent, forged, expired, and replayed health admissions cannot imitate the runtime host", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-adversarial-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  let now = 100;
  const admissions = new McpHealthProbeAdmissions(() => now, 10);
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const runtime = {
    source: "managed" as const,
    revision: "7".repeat(40),
    releaseId: "deploy-adversarial",
    artifactDigest: "a".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  const run = async (healthProbeCapability?: string) => {
    return await probeMcpRuntime({
      command: process.execPath,
      args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: environment,
      runtime,
      ...(healthProbeCapability ? { healthProbeCapability } : {}),
      healthProbeAdmissions: admissions,
    });
  };

  try {
    expect((await run()).calls).toEqual({ deploymentStatus: false, boardSnapshot: false });
    expect((await run("A".repeat(43))).calls).toEqual({ deploymentStatus: false, boardSnapshot: false });

    const expired = admissions.issue();
    now = 110;
    expect((await run(expired)).calls).toEqual({ deploymentStatus: false, boardSnapshot: false });

    const legitimate = admissions.issue();
    expect((await run(legitimate)).calls).toEqual({ deploymentStatus: true, boardSnapshot: true });
    expect((await run(legitimate)).calls).toEqual({ deploymentStatus: false, boardSnapshot: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("the final launcher rejects capability approval from a caller-selected runtime socket", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-forged-socket-"));
  const socketPath = path.join(sandbox, "forged-runtime.sock");
  const server = serveRuntimeHost(socketPath, {
    async handle(request) {
      if (request.method === "mcp-health-probe-admission") {
        return { id: request.id, ok: true, result: true };
      }
      if (request.method === "snapshot") {
        return { id: request.id, ok: true, result: { deployments: [] } };
      }
      return { id: request.id, ok: false, error: "unsupported" };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");

  try {
    const evidence = await probeMcpRuntime({
      command: process.execPath,
      args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: environment,
      runtime: {
        source: "managed",
        revision: "7".repeat(40),
        releaseId: "deploy-forged-socket",
        artifactDigest: "a".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
      healthProbeCapability: "A".repeat(43),
    });

    expect(evidence.calls).toEqual({ deploymentStatus: false, boardSnapshot: false });
    expect(evidence.ok).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);
