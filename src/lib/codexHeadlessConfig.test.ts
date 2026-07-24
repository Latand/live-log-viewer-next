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

test("a Codex thread approves Viewer and retains optional server approval policy", () => {
  expect(headlessCodexThreadConfig({
    config: {
      mcp_servers: {
        viewer: { default_tools_approval_mode: "prompt" },
        "agent-browser": { default_tools_approval_mode: "writes" },
        "telegram-readonly": { default_tools_approval_mode: "prompt" },
      },
    },
  }, false, ["agent-browser"])).toMatchObject({
    mcp_servers: {
      viewer: { enabled: true, default_tools_approval_mode: "approve" },
      "agent-browser": { enabled: true, default_tools_approval_mode: "writes" },
      "telegram-readonly": { enabled: false, default_tools_approval_mode: "prompt" },
    },
  });
});
