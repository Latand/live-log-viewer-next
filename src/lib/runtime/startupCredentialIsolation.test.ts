import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { discardWakatimeEnvironmentCredential, WAKATIME_CREDENTIAL_ENV } from "@/lib/wakatime/credential";

import { adoptStructuredHostsAtStartup } from "./startup";

test("startup adoption snapshots exclude ambient WakaTime key material", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-env-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const placeholder = ["startup", "snapshot", "value"].join("-");
  let codexEnvironment: NodeJS.ProcessEnv | undefined;
  let claudeEnvironment: NodeJS.ProcessEnv | undefined;
  discardWakatimeEnvironmentCredential();
  process.env[WAKATIME_CREDENTIAL_ENV] = placeholder;
  try {
    await adoptStructuredHostsAtStartup({
      registry,
      client: null,
      adopt: async (_registry, _optionsFor, environment) => {
        codexEnvironment = environment;
        return [];
      },
      adoptClaude: async (_registry, _optionsFor, environment) => {
        claudeEnvironment = environment;
        return [];
      },
    });

    expect(codexEnvironment?.[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(claudeEnvironment?.[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
    expect(JSON.stringify({ codexEnvironment, claudeEnvironment })).not.toContain(placeholder);
  } finally {
    discardWakatimeEnvironmentCredential();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
