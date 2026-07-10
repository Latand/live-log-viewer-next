import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import { evaluateAutoBalance } from "./autoBalance";
import type { MigrationEngine } from "./contracts";

const start = Date.parse("2026-07-10T12:00:00.000Z");
const observation = (id: string, used: number, observedAt: number) => ({ engine: "codex" as MigrationEngine, accountId: id, authenticated: true, limits: { session: { usedPercent: used, resetsAt: null }, weekly: null, plan: null, capturedAt: Math.floor(observedAt / 1000) }, provenance: { source: "live" as const, reason: null, staleSince: null }, observedAt });

test("automatic balance needs two samples and cannot supersede a manual intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-"));
  const registry = new AgentRegistry(path.join(dir, "registry.json"));
  registry.setAutoBalancePolicy("codex", true);
  expect(evaluateAutoBalance("codex", "a", [observation("a", 90, start), observation("b", 20, start)], start, registry)).toBeNull();
  const intent = evaluateAutoBalance("codex", "a", [observation("a", 90, start + 60_000), observation("b", 20, start + 60_000)], start + 60_000, registry);
  expect(intent).toMatchObject({ origin: "auto", targetId: "b" });
  const manual = registry.upsertMigrationIntent("claude", "manual", "manual", "manual-request");
  registry.setAutoBalancePolicy("claude", true);
  evaluateAutoBalance("claude", "a", [{ ...observation("a", 90, start), engine: "claude" }, { ...observation("b", 20, start), engine: "claude" }], start, registry);
  const result = evaluateAutoBalance("claude", "a", [{ ...observation("a", 90, start + 60_000), engine: "claude" }, { ...observation("b", 20, start + 60_000), engine: "claude" }], start + 60_000, registry);
  expect(result).toBeNull();
  expect(registry.snapshot().migrationIntents[manual.id]?.targetId).toBe("manual");
});

test("restart requires two fresh samples from the new controller boot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-auto-restart-"));
  const registry = new AgentRegistry(path.join(dir, "registry.json"));
  expect(evaluateAutoBalance("codex", "a", [observation("a", 90, start), observation("b", 20, start)], start, registry, "boot-1")).toBeNull();
  expect(evaluateAutoBalance("codex", "a", [observation("a", 90, start + 60_000), observation("b", 20, start + 60_000)], start + 60_000, registry, "boot-2")).toBeNull();
  expect(evaluateAutoBalance("codex", "a", [observation("a", 90, start + 120_000), observation("b", 20, start + 120_000)], start + 120_000, registry, "boot-2"))
    .toMatchObject({ origin: "auto", targetId: "b" });
});
