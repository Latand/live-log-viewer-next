import { expect, test } from "bun:test";

import { headlessCodexThreadConfig } from "./codexHeadlessConfig";

test("headless Codex threads disable native collaboration tools", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: { docs: {} } } })).toEqual({
    mcp_servers: { docs: { enabled: false } },
    features: { plugins: false, apps: false, multi_agent: false },
    include_apps_instructions: false,
  });
});

test("an operator-granted Codex thread enables native collaboration", () => {
  expect(headlessCodexThreadConfig({ config: { mcp_servers: {} } }, true)).toMatchObject({
    features: { plugins: false, apps: false, multi_agent: true },
  });
});
