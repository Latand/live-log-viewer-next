import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import type { CodexAccount } from "@/lib/accounts/codex";

import { QuotaController, type QuotaProbePort } from "./quotaController";

test("durable per-engine policy is the quota evaluation guard", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-controller-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    let listed = 0;
    const probe: QuotaProbePort = {
      list() { listed += 1; return []; },
      active() { return "default"; },
      async probe() { throw new Error("no account should be probed"); },
    };
    const controller = new QuotaController(registry, probe, "00000000-0000-4000-8000-000000000000", () => Date.parse("2026-07-10T12:00:00.000Z"));

    registry.setAutoBalancePolicy("codex", false);
    await controller.tick("codex");
    expect(listed).toBe(0);

    registry.setAutoBalancePolicy("codex", true);
    await controller.tick("codex");
    expect(listed).toBe(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed home records a closed code while the controller sweeps later homes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-quota-sweep-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    const accounts: CodexAccount[] = [
      { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 },
      { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 },
    ];
    const visited: string[] = [];
    const controller = new QuotaController(registry, {
      list: () => accounts,
      active: () => "default",
      async probe(engine, account, now) {
        visited.push(account.id);
        if (account.id === "default") throw new Error("access_token=secret");
        return {
          engine,
          accountId: account.id,
          authenticated: true,
          authCheckedAt: now,
          limits: { session: { usedPercent: 20, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(now / 1000) },
          provenance: { source: "live" as const, reason: null, staleSince: null },
          observedAt: now,
        };
      },
    }, "00000000-0000-4000-8000-000000000040", () => Date.parse("2026-07-10T12:00:00.000Z"));
    await controller.tick("codex");
    expect(visited.sort()).toEqual(["default", "managed"]);
    expect(registry.snapshot().quotaObservations.codex.default?.provenance.reason).toBe("quota-probe-failed");
    expect(JSON.stringify(registry.snapshot())).not.toContain("secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
