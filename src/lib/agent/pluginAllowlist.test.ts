import { expect, test } from "bun:test";

import {
  GRANTABLE_PLUGINS,
  grantedPluginServerNames,
  grantedPlugins,
  normalizeSpawnPlugins,
  pluginAllowlistForSession,
  sessionOriginFor,
} from "./pluginAllowlist";

test("an operator-launched root session is granted computer use by default", () => {
  const origin = sessionOriginFor({ origin: { kind: "operator" } });
  expect(origin).toBe("operator-root");
  expect(pluginAllowlistForSession({ origin })).toEqual(["computer-use"]);
});

test("a root grant contains computer use and nothing else", () => {
  const granted = pluginAllowlistForSession({ origin: "operator-root" });
  expect(granted).toEqual(["computer-use"]);
  expect(granted.every((name) => GRANTABLE_PLUGINS.includes(name))).toBe(true);
});

test("a Claude root session carries no Codex plugin grant", () => {
  expect(pluginAllowlistForSession({ origin: "operator-root", engine: "claude" })).toEqual([]);
  expect(pluginAllowlistForSession({ origin: "operator-root", engine: "codex" })).toEqual(["computer-use"]);
});

test("an operator root session opts out with an explicit empty allowlist", () => {
  expect(pluginAllowlistForSession({ origin: "operator-root", requested: [] })).toEqual([]);
});

test("every delegated launch signal denies the grant", () => {
  const delegated = [
    { origin: { kind: "agent" } },
    { origin: { kind: "container" } },
    { origin: { kind: "operator" }, parentConversationId: "conversation_1" },
    { origin: { kind: "operator" }, agentRole: "builder" },
    { origin: { kind: "operator" }, agentRole: "reviewer" },
    { origin: { kind: "operator" }, delegationDepth: 1 },
  ];
  for (const input of delegated) {
    expect(sessionOriginFor(input)).toBe("delegated");
    expect(pluginAllowlistForSession({ origin: "delegated" })).toEqual([]);
  }
});

test("a delegated session cannot inherit the grant by asking for it", () => {
  const origin = sessionOriginFor({ origin: { kind: "agent" }, parentConversationId: "conversation_1" });
  expect(pluginAllowlistForSession({ origin, requested: ["computer-use"] })).toEqual([]);
});

test("an unknown origin kind is treated as delegated", () => {
  expect(sessionOriginFor({ origin: { kind: "successor" } })).toBe("delegated");
});

test("a request can never widen the allowlist to every plugin", () => {
  for (const requested of [["*"], ["all"], ["computer-use", "browser"], ["chrome"], ["computer-use", "*"]]) {
    const normalized = normalizeSpawnPlugins(requested);
    expect(normalized.ok).toBe(false);
  }
});

test("a rejected plugin name is reported rather than silently dropped", () => {
  const normalized = normalizeSpawnPlugins(["computer-use", "browser"]);
  expect(normalized).toMatchObject({ ok: false });
  if (!normalized.ok) expect(normalized.error).toContain("browser");
});

test("an absent request leaves the decision to policy and an empty one opts out", () => {
  expect(normalizeSpawnPlugins(undefined)).toEqual({ ok: true, value: null });
  expect(normalizeSpawnPlugins([])).toEqual({ ok: true, value: [] });
  expect(normalizeSpawnPlugins(["computer-use", "computer-use"])).toEqual({ ok: true, value: ["computer-use"] });
});

test("a malformed request is rejected", () => {
  expect(normalizeSpawnPlugins("computer-use")).toMatchObject({ ok: false });
  expect(normalizeSpawnPlugins([1])).toMatchObject({ ok: false });
});

test("a stored profile cannot smuggle a plugin past the grant bound", () => {
  expect(grantedPlugins(["computer-use", "browser", "*"])).toEqual(["computer-use"]);
  expect(grantedPlugins(undefined)).toEqual([]);
  expect(grantedPlugins("computer-use" as unknown as string[])).toEqual([]);
});

test("a grant maps to the MCP servers its plugins may contribute", () => {
  expect(grantedPluginServerNames(["computer-use"])).toEqual(["computer-use"]);
  expect(grantedPluginServerNames([])).toEqual([]);
});
