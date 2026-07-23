import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpRuntimeReleaseStore } from "./mcpRuntimeRelease";

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function preparedPackage(): { root: string; source: string; state: string; stable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-release-"));
  sandboxes.push(root);
  const source = path.join(root, "source");
  const state = path.join(root, "state");
  const stable = path.join(root, "llv-mcp-runtime");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  fs.mkdirSync(path.join(source, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(source, "bin", "mcp-server.mjs"), "process.stdout.write('launcher\\n');\n");
  fs.writeFileSync(path.join(source, "bin", "server-runtime.mjs"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(source, "dist", "mcp-server.mjs"), "process.stdout.write('candidate\\n');\n");
  fs.writeFileSync(path.join(source, "node_modules", "fixture", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(source, "package.json"), "{\"name\":\"fixture\",\"type\":\"module\"}\n");
  return { root, source, state, stable };
}

test("a staged MCP runtime becomes visible as one complete immutable release", () => {
  const fixture = preparedPackage();
  const revision = "7".repeat(40);
  const store = new McpRuntimeReleaseStore({
    stateDir: fixture.state,
    stableRuntimeRoot: fixture.stable,
    now: () => "2026-07-23T08:00:00.000Z",
  });

  const runtime = store.stagePreparedPackage(fixture.source, "deploy-publication", revision);
  const releaseRoot = store.releaseRoot(runtime);

  expect(runtime).toEqual({
    source: "managed",
    revision,
    releaseId: expect.stringMatching(/^[a-z0-9-]+$/),
    artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    stagedAt: "2026-07-23T08:00:00.000Z",
  });
  expect(fs.readFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), "utf8")).toContain("candidate");
  expect(fs.readFileSync(path.join(releaseRoot, "node_modules", "fixture", "index.js"), "utf8")).toContain("export");
  expect(JSON.parse(fs.readFileSync(path.join(releaseRoot, "runtime-release.json"), "utf8"))).toEqual(runtime);
  expect(fs.readdirSync(path.dirname(releaseRoot)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
});

test("process death around release publication leaves an absent or complete runtime and retries cleanly", async () => {
  for (const boundary of ["before-release-rename", "after-release-rename"] as const) {
    const fixture = preparedPackage();
    const revision = "6".repeat(40);
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "mcpRuntimeReleaseChild.ts")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_MCP_TEST_SOURCE: fixture.source,
        LLV_MCP_TEST_STATE: fixture.state,
        LLV_MCP_TEST_STABLE: fixture.stable,
        LLV_MCP_TEST_REVISION: revision,
        LLV_MCP_TEST_BOUNDARY: boundary,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(86);
    expect(await new Response(child.stderr).text()).toBe("");

    const releasesDir = path.join(fixture.state, "mcp-runtime", "releases");
    const visible = fs.readdirSync(releasesDir).filter((entry) => !entry.startsWith("."));
    expect(visible).toHaveLength(boundary === "before-release-rename" ? 0 : 1);
    if (visible[0]) {
      expect(fs.existsSync(path.join(releasesDir, visible[0], "dist", "mcp-server.mjs"))).toBe(true);
      expect(fs.existsSync(path.join(releasesDir, visible[0], "runtime-release.json"))).toBe(true);
    }

    const store = new McpRuntimeReleaseStore({
      stateDir: fixture.state,
      stableRuntimeRoot: fixture.stable,
      now: () => "2026-07-23T08:01:00.000Z",
    });
    const runtime = store.stagePreparedPackage(fixture.source, "deploy-crash-boundary", revision);
    expect(fs.existsSync(path.join(store.releaseRoot(runtime), "dist", "mcp-server.mjs"))).toBe(true);
    expect(fs.readdirSync(releasesDir).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  }
});

test("stable launcher publication preserves the registered path across crash boundaries", async () => {
  for (const boundary of ["before-launcher-rename", "after-launcher-rename"] as const) {
    const fixture = preparedPackage();
    const registeredPath = path.join(fixture.stable, "bin", "mcp-server.mjs");
    fs.mkdirSync(path.dirname(registeredPath), { recursive: true });
    fs.writeFileSync(registeredPath, "process.stdout.write('previous\\n');\n", "utf8");
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "mcpRuntimeReleaseChild.ts")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_MCP_TEST_ACTION: "install-launcher",
        LLV_MCP_TEST_SOURCE: fixture.source,
        LLV_MCP_TEST_STATE: fixture.state,
        LLV_MCP_TEST_STABLE: fixture.stable,
        LLV_MCP_TEST_REVISION: "5".repeat(40),
        LLV_MCP_TEST_BOUNDARY: boundary,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(86);
    expect(await new Response(child.stderr).text()).toBe("");
    const afterCrash = fs.readFileSync(registeredPath, "utf8");
    expect(["process.stdout.write('previous\\n');\n", "process.stdout.write('launcher\\n');\n"]).toContain(afterCrash);

    const store = new McpRuntimeReleaseStore({
      stateDir: fixture.state,
      stableRuntimeRoot: fixture.stable,
      now: () => "2026-07-23T08:02:00.000Z",
    });
    const evidence = store.installStableLauncher(fixture.source);
    expect(evidence).toEqual({
      executablePath: registeredPath,
      launcherDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      publishedAt: "2026-07-23T08:02:00.000Z",
      durable: true,
    });
    expect(fs.readFileSync(registeredPath, "utf8")).toBe("process.stdout.write('launcher\\n');\n");
    expect(fs.readdirSync(path.dirname(registeredPath)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  }
});

test("process death around target publication exposes one complete Viewer and MCP release pair", async () => {
  for (const boundary of ["before-target-rename", "after-target-rename"] as const) {
    const fixture = preparedPackage();
    const revision = "4".repeat(40);
    const target = path.join(fixture.state, "viewer-release.json");
    const previous = {
      revision: "8".repeat(40),
      image: "viewer:previous",
      container: "viewer-previous",
      endpoint: "http://127.0.0.1:8898",
    };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(previous), "utf8");
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "mcpRuntimeReleaseChild.ts")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLV_MCP_TEST_ACTION: "publish-target",
        LLV_MCP_TEST_SOURCE: fixture.source,
        LLV_MCP_TEST_STATE: fixture.state,
        LLV_MCP_TEST_STABLE: fixture.stable,
        LLV_MCP_TEST_REVISION: revision,
        LLV_MCP_TEST_BOUNDARY: boundary,
        LLV_MCP_TEST_TARGET: target,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(86);
    expect(await new Response(child.stderr).text()).toBe("");

    const visible = JSON.parse(fs.readFileSync(target, "utf8"));
    if (boundary === "before-target-rename") expect(visible).toEqual(previous);
    else expect(visible).toMatchObject({ revision, mcpRuntime: { revision, source: "managed" } });

    const store = new McpRuntimeReleaseStore({
      stateDir: fixture.state,
      stableRuntimeRoot: fixture.stable,
    });
    const candidate = {
      revision,
      image: `viewer:${revision}`,
      container: "viewer-candidate",
      endpoint: "http://127.0.0.1:18001",
      mcpRuntime: {
        source: "managed" as const,
        revision,
        releaseId: "deploy-crash-boundary",
        artifactDigest: "a".repeat(64),
        stagedAt: "2026-07-23T08:00:00.000Z",
      },
    };
    store.publishReleaseTarget(target, candidate);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(candidate);
    expect(fs.readdirSync(path.dirname(target)).filter((entry) => entry.includes(".tmp"))).toEqual([]);
  }
});

test("runtime retention keeps the active rollback pair and retires failed candidates", () => {
  const fixture = preparedPackage();
  const store = new McpRuntimeReleaseStore({
    stateDir: fixture.state,
    stableRuntimeRoot: fixture.stable,
    now: () => "2026-07-23T08:03:00.000Z",
  });
  const first = store.stagePreparedPackage(fixture.source, "deploy-first", "1".repeat(40));
  fs.writeFileSync(path.join(fixture.source, "dist", "mcp-server.mjs"), "process.stdout.write('second\\n');\n");
  const second = store.stagePreparedPackage(fixture.source, "deploy-second", "2".repeat(40));
  const failed = store.stagePreparedPackage(fixture.source, "deploy-failed", "3".repeat(40));
  const legacy = store.legacyRuntimeIdentity("8".repeat(40));

  expect(legacy).toEqual({
    source: "legacy",
    revision: "8".repeat(40),
    releaseId: null,
    artifactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    stagedAt: null,
  });
  store.retire(failed);
  store.retainOnly([second, first, legacy]);

  expect(fs.existsSync(store.releaseRoot(first))).toBe(true);
  expect(fs.existsSync(store.releaseRoot(second))).toBe(true);
  expect(fs.existsSync(path.join(fixture.state, "mcp-runtime", "releases", failed.releaseId!))).toBe(false);
  expect(fs.readdirSync(path.join(fixture.state, "mcp-runtime", "releases")).sort())
    .toEqual([first.releaseId!, second.releaseId!].sort());
});
