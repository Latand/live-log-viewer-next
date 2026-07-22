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
      viewer: { enabled: true },
      docs: { enabled: false },
    },
    features: { plugins: false, apps: false, multi_agent: false },
    include_apps_instructions: false,
  });
});

test("configurations without Viewer disable every registered MCP server", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: { docs: {} } } })).toEqual({
    mcp_servers: { docs: { enabled: false } },
    features: { plugins: false, apps: false, multi_agent: false },
    include_apps_instructions: false,
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
