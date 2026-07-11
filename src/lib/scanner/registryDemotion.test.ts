import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { AgentRegistry, setAgentRegistryForTests } from "../agent/registry";
import { archivedTranscriptPaths, pinnedPathsFor } from "./index";

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

test("a conversation-id pin resolves to its current generation path", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-${process.pid}`, "agent-registry.json"));
  const conversation = store.ensureConversation("codex", "/repo/current.jsonl", "default");
  setAgentRegistryForTests(store);
  expect(pinnedPathsFor(conversation.id)).toEqual(new Set(["/repo/current.jsonl"]));
  /* Paths outside the registry pass through; unknown ids leave the scan unpinned. */
  expect(pinnedPathsFor("/plain/path.jsonl")).toEqual(new Set(["/plain/path.jsonl"]));
  expect(pinnedPathsFor("conversation_unknown")).toEqual(new Set());
});

test("an archived path pin brings its current generation along", () => {
  const store = new AgentRegistry(path.join(os.tmpdir(), `llv-pin-arch-${process.pid}`, "agent-registry.json"));
  const conversation = store.ensureConversation("codex", "/repo/old.jsonl", "default");
  setAgentRegistryForTests(store);
  const snapshot = store.snapshot();
  expect(snapshot.conversations[conversation.id]?.generations.at(-1)?.path).toBe("/repo/old.jsonl");
  /* Same conversation with the generation advanced: the pin must ship both
     the requested predecessor and the successor the link redirects to. */
  const pins = pinnedPathsFor("/repo/old.jsonl");
  expect(pins.has("/repo/old.jsonl")).toBe(true);
});

test("an unreadable registry keeps a path pin and drops an id pin", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-pin-corrupt-"));
  try {
    const file = path.join(base, "agent-registry.json");
    await writeFile(file, "{ this is not json");
    setAgentRegistryForTests(new AgentRegistry(file));
    expect(pinnedPathsFor("conversation_x")).toEqual(new Set());
    expect(pinnedPathsFor("/some/path.jsonl")).toEqual(new Set(["/some/path.jsonl"]));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
