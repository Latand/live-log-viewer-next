import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "../agent/registry";
import { archivedTranscriptPaths } from "./index";

afterEach(() => setAgentRegistryForTests(null));

test("a corrupt agent registry yields an empty demotion set and discovery stays available", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unsupported registry schema also degrades to no demotion", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-registry-demotion-schema-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 999 }));
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(archivedTranscriptPaths()).toEqual(new Set());
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
