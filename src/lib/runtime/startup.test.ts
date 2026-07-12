import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";

import { adoptStructuredHostsAtStartup } from "./startup";

test("server startup delegates registry rows to structured adoption with the owning Codex home", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  registry.upsert({
    key: { engine: "codex", sessionId: "startup-thread" },
    artifactPath: "/managed/sessions/startup-thread.jsonl",
    cwd: "/repo",
    accountId: "managed",
    status: "dead",
    host: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  let options: unknown;
  await adoptStructuredHostsAtStartup({
    registry,
    resolveCodexHome: () => "/managed",
    adopt: async (received, optionsFor) => {
      expect(received).toBe(registry);
      options = optionsFor(registry.snapshot().entries["codex:startup-thread"]!);
      return [];
    },
  });
  expect(options).toMatchObject({ cwd: "/repo", codexHome: "/managed" });
});
