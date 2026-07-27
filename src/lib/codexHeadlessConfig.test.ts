import { expect, test } from "bun:test";

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
      viewer: { enabled: true, default_tools_approval_mode: "approve" },
      docs: { enabled: false },
    },
    features: { plugins: false, apps: false, multi_agent: false, realtime_conversation: true },
    include_apps_instructions: false,
  });
});

test("configurations without Viewer disable every registered MCP server", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: { docs: {} } } })).toEqual({
    mcp_servers: { docs: { enabled: false } },
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
