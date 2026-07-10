import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";

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
