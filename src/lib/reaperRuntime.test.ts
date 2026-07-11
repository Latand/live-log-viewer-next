import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";

import { readReaperReport, runReaperCycle } from "./reaperRuntime";

const originalStateDir = process.env.LLV_STATE_DIR;
const originalEnabled = process.env.LLV_REAPER_ENABLED;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  if (originalEnabled === undefined) delete process.env.LLV_REAPER_ENABLED;
  else process.env.LLV_REAPER_ENABLED = originalEnabled;
});

test("runtime cycle persists an API report in dry-run mode by default", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-runtime-"));
  process.env.LLV_STATE_DIR = directory;
  delete process.env.LLV_REAPER_ENABLED;
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    const report = await runReaperCycle({ registry, hosts: [], files: [], now: Date.parse("2026-07-12T12:00:00.000Z") });

    expect(report).toMatchObject({ mode: "dry-run", configFlag: "LLV_REAPER_ENABLED", eligibleCount: 0, agents: [] });
    expect(readReaperReport()).toEqual(report);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime cycle enters active mode only for the exact opt-in flag", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-active-"));
  process.env.LLV_STATE_DIR = directory;
  process.env.LLV_REAPER_ENABLED = "true";
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));

  try {
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("dry-run");
    process.env.LLV_REAPER_ENABLED = "1";
    expect((await runReaperCycle({ registry, hosts: [], files: [] })).mode).toBe("active");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
