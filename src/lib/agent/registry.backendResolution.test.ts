import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { attentionCallerAuthority } from "@/lib/attention/callerAuthority";

import { AgentRegistry } from "./registry";
import { publishRegistryBackendIdentity, RegistryBackendIdentityError } from "./registryBackendIdentity";

const roots: string[] = [];
const HOST_PID = 248965;

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-backend-resolution-"));
  roots.push(root);
  return root;
}

function withoutBackendEnv<T>(run: () => T): T {
  const previous = process.env.LLV_AGENT_REGISTRY_SQLITE;
  delete process.env.LLV_AGENT_REGISTRY_SQLITE;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.LLV_AGENT_REGISTRY_SQLITE;
    else process.env.LLV_AGENT_REGISTRY_SQLITE = previous;
  }
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function registryFileWithHost(transcript: string, hostPid: number, status: string): unknown {
  return {
    version: 2,
    entries: {
      "claude:live-session": {
        artifactPath: transcript,
        status,
        structuredHost: { kind: "claude-broker", process: { pid: hostPid, startIdentity: null } },
      },
    },
    receipts: {},
    conversations: {
      conversation_live: {
        id: "conversation_live",
        engine: "claude",
        generations: [{ id: "live-session", path: transcript, accountId: "default" }],
      },
    },
  };
}

/** The authoritative content: one conversation whose structured host pid is
    the process an MCP server would find by walking its own ancestry. */
function authoritativeFile(transcript: string): unknown {
  return registryFileWithHost(transcript, HOST_PID, "live");
}

/** What the production mirror looked like: the same conversation, but carrying
    a host pid from a generation that died hours earlier. */
function staleMirrorFile(transcript: string): unknown {
  return registryFileWithHost(transcript, 8351, "idle");
}

function hostPidsFor(registry: AgentRegistry): number[] {
  const snapshot = registry.readOnlySnapshot();
  return Object.values(snapshot.entries)
    .map((entry) => entry.structuredHost?.process?.pid)
    .filter((pid): pid is number => typeof pid === "number");
}

function seedAuthoritativeStore(root: string): { filename: string; store: string; transcript: string } {
  const filename = path.join(root, "agent-registry.json");
  const store = path.join(root, "agent-registry.sqlite");
  const transcript = path.join(root, "live-session.jsonl");
  fs.writeFileSync(filename, JSON.stringify(authoritativeFile(transcript)));
  /* The writer: explicit mode, and it imports the JSON seed into SQLite. */
  new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite", sqliteFilename: store });
  publishRegistryBackendIdentity(filename, "sqlite", store);
  /* Now the mirror diverges, exactly as it had in production. */
  fs.writeFileSync(filename, JSON.stringify(staleMirrorFile(transcript)));
  return { filename, store, transcript };
}

test("a reader with no env opens the writer's SQLite store, not the diverged mirror", () => {
  const { filename } = seedAuthoritativeStore(stateRoot());

  const reader = withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }));

  expect(hostPidsFor(reader)).toEqual([HOST_PID]);
  expect(hostPidsFor(reader)).not.toContain(8351);
});

test("a live hosted caller is identified from the authoritative registry", () => {
  const { filename } = seedAuthoritativeStore(stateRoot());
  const reader = withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }));
  const snapshot = reader.readOnlySnapshot();
  const hosted = Object.values(snapshot.conversations).map((conversation) => ({
    conversationId: conversation.id,
    role: null,
    pids: Object.values(snapshot.entries)
      .filter((entry) => conversation.generations.some((generation) => generation.path === entry.artifactPath))
      .map((entry) => entry.structuredHost?.process?.pid)
      .filter((pid): pid is number => typeof pid === "number"),
  }));

  /* The MCP server's own chain: itself, the agent, then the structured host. */
  const authority = attentionCallerAuthority({
    ancestry: () => [248998, 248968, HOST_PID],
    hosted: () => hosted,
    rootConversationId: () => null,
  });

  expect(authority).toEqual({ kind: "worker", conversationId: "conversation_live", role: null });
});

/* The fix must not hand authority to anyone it could not name before. */
test("a caller whose ancestry matches no recorded host stays unidentified", () => {
  const { filename } = seedAuthoritativeStore(stateRoot());
  const reader = withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }));
  const snapshot = reader.readOnlySnapshot();

  const authority = attentionCallerAuthority({
    ancestry: () => [999001, 999002],
    hosted: () => Object.values(snapshot.conversations).map((conversation) => ({
      conversationId: conversation.id,
      role: null,
      pids: [HOST_PID],
    })),
    rootConversationId: () => null,
  });

  expect(authority).toEqual({ kind: "unidentified" });
});

test("a reader refuses to start when a store exists but no identity was published", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify({ version: 2, entries: {}, receipts: {} }));
  fs.writeFileSync(path.join(root, "agent-registry.sqlite"), "");

  expect(() => withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }))).toThrow(RegistryBackendIdentityError);
});

test("a JSON-only deployment still constructs without a descriptor", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify({ version: 2, entries: {}, receipts: {} }));

  const reader = withoutBackendEnv(() => new AgentRegistry(filename, undefined, undefined, { resolveBackendIdentity: true }));

  expect(reader.readOnlySnapshot().entries).toEqual({});
});
