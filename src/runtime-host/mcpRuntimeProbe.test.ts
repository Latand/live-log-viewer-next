import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MCP_TOOL_NAMES } from "@/lib/mcp/server";

import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { mcpProbeCallFailures, mcpProbeFailureDetail, probeControlUrl, probeMcpRuntime, VIEWER_CONTROL_URL_ENV } from "./mcpRuntimeProbe";
import { serveRuntimeHost } from "./socket";

/* The probed runtime reads through the control endpoint it is handed. Unset, it
   resolves to the fixed loopback address, which belongs to whichever Viewer is
   already serving (#790) - so every probe below is pointed at its own stub. */
function candidateControl() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/api/runtime/deployments"
        ? Response.json({ count: 0, deployments: [] })
        : Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

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
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

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
      expect(evidence.callFailures).toBeUndefined();
      expect(processId).not.toBeNull();
      expect(() => process.kill(processId!, 0)).toThrow();
    }
  } finally {
    control.stop(true);
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
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

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
    control.stop(true);
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
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;
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
    control.stop(true);
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
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

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
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

/* `deploymentStatus: false` and nothing else is what #790 had to work from. */
test("a refused candidate MCP read names the read, its refusal and the control surface it used", () => {
  expect(mcpProbeFailureDetail({
    controlUrl: "http://127.0.0.1:19106",
    calls: [
      {
        name: "deployment_status",
        ok: false,
        result: {
          isError: true,
          structuredContent: { ok: false, error: "Viewer control request failed with status 405", status: 405 },
        },
      },
      { name: "board_snapshot", ok: true, result: { structuredContent: { ok: true } } },
    ],
  })).toBe(
    "MCP runtime read probes failed against http://127.0.0.1:19106 - "
    + "deployment_status: Viewer control request failed with status 405",
  );
});

test("a read refused without a structured error still reports its text and status", () => {
  expect(mcpProbeFailureDetail({
    controlUrl: undefined,
    calls: [{
      name: "board_snapshot",
      ok: false,
      result: { isError: true, structuredContent: { ok: false, status: 503 }, content: [{ type: "text", text: "runtime host is unavailable" }] },
    }],
  })).toBe("MCP runtime read probes failed - board_snapshot: runtime host is unavailable (status 503)");
});

/* #790 is a gate that graded the Viewer already serving: a candidate differing
   from it can then neither pass nor fail on its own behalf. */
test("a probe handed no control endpoint refuses by name instead of addressing the serving Viewer", async () => {
  const runtime = {
    source: "managed" as const,
    revision: "7".repeat(40),
    releaseId: "deploy-untargeted",
    artifactDigest: "a".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  let spawned = false;

  for (const control of [undefined, "", "   ", "127.0.0.1:8898"]) {
    const evidence = await probeMcpRuntime({
      /* A command that cannot exist: if the probe reached the spawn, the
         evidence would name that failure and this test would say so. */
      command: path.join(os.tmpdir(), "llv-probe-never-executed"),
      args: [],
      cwd: process.cwd(),
      env: control === undefined ? {} : { [VIEWER_CONTROL_URL_ENV]: control },
      runtime,
      onProcessReady: () => { spawned = true; },
    });

    expect(evidence).toMatchObject({
      ok: false,
      processReady: false,
      tools: [],
      calls: { deploymentStatus: false, boardSnapshot: false },
      revision: runtime.revision,
      artifactDigest: runtime.artifactDigest,
    });
    expect(evidence.detail).toContain(VIEWER_CONTROL_URL_ENV);
  }

  expect(spawned).toBe(false);
});

test("a probe keeps the control endpoint it was handed", () => {
  expect(probeControlUrl(" http://127.0.0.1:19106 ")).toBe("http://127.0.0.1:19106");
  expect(probeControlUrl("https://viewer.invalid/base")).toBe("https://viewer.invalid/base");
  expect(probeControlUrl("ftp://viewer.invalid")).toBeNull();
  expect(probeControlUrl(undefined)).toBeNull();
});


/* Three deploys failed on `boardSnapshot: false` and a sentence that named no
   reason. The refusal the candidate's own runtime produced is the only account
   of it there will ever be - the candidate is retired seconds later. */
test("every refused read is kept with the tool's own reason and its failure code", () => {
  expect(mcpProbeCallFailures([
    { name: "deployment_status", ok: true, result: { structuredContent: { ok: true } } },
    {
      name: "board_snapshot",
      ok: false,
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          code: "tool_failed",
          error: "file scanner worker exited before completion (1)",
        },
      },
    },
  ])).toEqual([{
    tool: "board_snapshot",
    code: "tool_failed",
    error: "file scanner worker exited before completion (1)",
  }]);
});

test("a refusal with no code, and one that answered nothing at all, are both still kept", () => {
  expect(mcpProbeCallFailures([
    {
      name: "board_snapshot",
      ok: false,
      result: { isError: true, content: [{ type: "text", text: "the corpus could not be read" }] },
    },
    { name: "deployment_status", ok: false, result: undefined },
  ])).toEqual([
    { tool: "board_snapshot", error: "the corpus could not be read" },
    { tool: "deployment_status", error: "no result" },
  ]);
});

/* The record is durable and the operator pastes it into issues, so the capture
   redacts and clamps exactly where `containerLog` does. The refusal that
   blocked these deploys named a filesystem path, which is precisely the shape
   that must not survive into a published artifact. */
test("a refusal naming a home path is redacted and clamped before it is recorded", () => {
  const refusal = `Module not found ${["", "home", "someone", "checkout", "fileScanner.worker.ts"].join("/")}\n`
    + `${"scan detail. ".repeat(60)}`;
  const [failure] = mcpProbeCallFailures([{
    name: "board_snapshot",
    ok: false,
    result: { isError: true, structuredContent: { ok: false, code: "tool_failed", error: refusal } },
  }]);

  expect(failure!.error).not.toContain(["", "home", "someone"].join("/"));
  expect(failure!.error).toContain("Module not found");
  expect(failure!.error).toContain("fileScanner.worker.ts");
  expect(failure!.error).not.toContain("\n");
  expect(failure!.error.endsWith("...")).toBe(true);
  expect(failure!.error.length).toBeLessThan(refusal.length / 2);
});
