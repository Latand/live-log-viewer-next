import { expect, test } from "bun:test";

import { viewerMcpServerEntry } from "./agent/spawnPolicy";
import { headlessCodexThreadConfig } from "./codexHeadlessConfig";

test("headless Codex threads allow only the registered Viewer MCP server", () => {
  expect(headlessCodexThreadConfig({
    config: {
      mcp_servers: {
        viewer: { command: "agent-log-viewer-mcp", enabled: false },
        docs: { command: "docs-mcp", enabled: true },
      },
    },
  })).toEqual({
    mcp_servers: {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "approve" },
      docs: { enabled: false },
    },
    features: { plugins: false, apps: false, multi_agent: false, realtime_conversation: true },
    include_apps_instructions: false,
  });
});

test("configurations without Viewer add the packaged server and disable every unrelated MCP server", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: { docs: {} } } })).toEqual({
    mcp_servers: {
      docs: { enabled: false },
      viewer: { ...viewerMcpServerEntry(), enabled: true, default_tools_approval_mode: "approve" },
    },
    features: { plugins: false, apps: false, multi_agent: false, realtime_conversation: true },
    include_apps_instructions: false,
  });
});

test("hosted threads keep the realtime conversation feature the app-server enabled", () => {
  /* The host spawns `codex app-server --enable realtime_conversation`, but the
     per-thread `features` override replaces the global table — without an
     explicit true here, thread/realtime/start fails locally with "thread does
     not support realtime conversation" (issue #621 MVP probe). */
  expect(headlessCodexThreadConfig({ config: { mcp_servers: {} } })).toMatchObject({
    features: { realtime_conversation: true },
  });
});

test("configurations without an MCP table fail closed", () => {
  expect(() => headlessCodexThreadConfig({ config: {} })).toThrow("config/read returned no MCP server table");
});

test("an operator-granted Codex thread enables native collaboration", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: {} } }, true)).toMatchObject({
    features: { plugins: false, apps: false, multi_agent: true },
  });
});

test("a granted thread enables the plugin subsystem for itself and allowlists only computer use", () => {
  const config = headlessCodexThreadConfig({
    config: {
      mcp_servers: {},
      plugins: {
        "computer-use@openai-bundled": { enabled: true },
        "browser@openai-bundled": { enabled: true },
        "github@openai-curated": { enabled: true },
      },
    },
  }, false, undefined, ["computer-use"]);
  expect(config).toMatchObject({
    features: { plugins: true, apps: false, multi_agent: false },
    plugins: {
      "computer-use@openai-bundled": { enabled: true },
      "browser@openai-bundled": { enabled: false },
      "github@openai-curated": { enabled: false },
    },
    include_apps_instructions: false,
  });
});

test("a thread without a grant keeps the plugin subsystem off and carries no plugin table", () => {
  const config = headlessCodexThreadConfig({
    config: { mcp_servers: {}, plugins: { "computer-use@openai-bundled": { enabled: true } } },
  }, false, undefined, []);
  expect(config).toMatchObject({ features: { plugins: false } });
  expect(config).not.toHaveProperty("plugins");
});

test("a thread configuration cannot be widened to every installed plugin", () => {
  /* Whatever a stored profile claims, only grantable names reach the thread —
     an unknown name never enables a plugin and never turns the subsystem on. */
  const wide = headlessCodexThreadConfig({
    config: { mcp_servers: {}, plugins: { "browser@openai-bundled": { enabled: true } } },
  }, false, undefined, ["browser", "*"]);
  expect(wide).toMatchObject({ features: { plugins: false } });
  expect(wide).not.toHaveProperty("plugins");
});

test("a granted plugin missing from the effective config is still stated in the thread table", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: {} } }, false, undefined, ["computer-use"]))
    .toMatchObject({ plugins: { "computer-use": { enabled: true } } });
});

test("a Codex thread approves Viewer and retains optional server approval policy", () => {
  expect(headlessCodexThreadConfig({
    config: {
      mcp_servers: {
        viewer: { default_tools_approval_mode: "prompt" },
        "agent-browser": { default_tools_approval_mode: "writes" },
        "telegram-readonly": { default_tools_approval_mode: "prompt" },
      },
    },
    /* Nothing outside the grant bound can be enabled, so a stored allowlist
       naming a configured server still leaves it off (issue #739). Each
       server's own approval policy survives the disable. */
  }, false, ["agent-browser"])).toMatchObject({
    mcp_servers: {
      viewer: { enabled: true, default_tools_approval_mode: "approve" },
      "agent-browser": { enabled: false, default_tools_approval_mode: "writes" },
      "telegram-readonly": { enabled: false, default_tools_approval_mode: "prompt" },
    },
  });
});

test("a replayed Viewer entry drops the unset fields config/read reports as null (#1410)", () => {
  /* Codex answers config/read with every optional field present, using null
     for the ones nobody configured. Replaying those nulls back made Codex
     refuse the launch outright ("invalid type: string ``, expected f64"), so
     no session could start. */
  const thread = headlessCodexThreadConfig({
    config: {
      mcp_servers: {
        viewer: {
          command: "bun",
          args: ["/opt/viewer/bin/mcp-server.mjs"],
          environment_id: "local",
          enabled: true,
          tool_timeout_sec: null,
          startup_timeout_sec: null,
        },
      },
    },
  }) as { mcp_servers: Record<string, Record<string, unknown>> };

  expect(thread.mcp_servers.viewer).toEqual({
    command: "bun",
    args: ["/opt/viewer/bin/mcp-server.mjs"],
    environment_id: "local",
    enabled: true,
    default_tools_approval_mode: "approve",
  });
  expect("tool_timeout_sec" in thread.mcp_servers.viewer).toBe(false);
  expect("startup_timeout_sec" in thread.mcp_servers.viewer).toBe(false);
});

test("a replayed Viewer entry keeps a timeout the operator actually set (#1410)", () => {
  const thread = headlessCodexThreadConfig({
    config: {
      mcp_servers: {
        viewer: { command: "bun", args: ["/opt/viewer/bin/mcp-server.mjs"], tool_timeout_sec: 120 },
      },
    },
  }) as { mcp_servers: Record<string, Record<string, unknown>> };

  expect(thread.mcp_servers.viewer.tool_timeout_sec).toBe(120);
});
