import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry, RegistryParityError } from "./registry";

const CHILD = path.join(import.meta.dir, "registry.sqliteChild.ts");

function waitFor(pathname: string): void {
  while (!fs.existsSync(pathname)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)]!;
}

test("SQLite first boot imports JSON and preserves membership and capability digest paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-import-"));
  const filename = path.join(directory, "agent-registry.json");
  const digest = "a".repeat(64);
  const legacy = new AgentRegistry(filename);
  const begun = legacy.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    spawnCapabilityDigest: digest,
    memberships: [{
      kind: "flow",
      containerId: "flow-187",
      role: "builder",
      slot: "builder:0",
      stageId: null,
      stageOrder: null,
      round: null,
      parentConversationId: null,
    }],
  });
  if (begun.kind !== "created") throw new Error("expected a new receipt");
  const expected = legacy.snapshot();

  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });

  expect(fs.existsSync(path.join(directory, "agent-registry.sqlite"))).toBeTrue();
  expect(sqlite.snapshot()).toEqual(expected);
  expect(sqlite.conversationIdForSpawnCapabilityDigest(digest)).toBe(begun.receipt.conversationId);
  expect(sqlite.snapshot().memberships[begun.receipt.conversationId]).toEqual([
    expect.objectContaining({ containerId: "flow-187", slot: "builder:0" }),
  ]);

  sqlite.rememberMembership(begun.receipt.conversationId, {
    kind: "pipeline",
    containerId: "pipeline-187",
    role: "builder",
    slot: "stage:build",
    stageId: "build",
    stageOrder: 1,
    round: null,
    parentConversationId: null,
  });

  expect(new AgentRegistry(filename).snapshot()).toEqual(sqlite.snapshot());
});

test("dual-write keeps JSON authoritative and SQLite reads require parity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-parity-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqliteFilename = path.join(directory, "agent-registry.sqlite");
  const dual = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "dual-write" });
  const receipt = dual.beginSpawn("codex", "/parity");

  expect(new AgentRegistry(filename).snapshot().receipts[receipt.launchId]).toEqual(
    new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot().receipts[receipt.launchId],
  );

  const db = new Database(sqliteFilename);
  const stored = db.query<{ value_json: string }, [string, string]>(
    "SELECT value_json FROM registry_rows WHERE collection = ? AND row_key = ?",
  ).get("receipts", receipt.launchId);
  if (!stored) throw new Error("expected SQLite receipt");
  const changed = JSON.parse(stored.value_json) as { cwd: string };
  changed.cwd = "/drifted";
  db.query("UPDATE registry_rows SET value_json = ? WHERE collection = ? AND row_key = ?")
    .run(JSON.stringify(changed), "receipts", receipt.launchId);
  db.close();

  expect(() => new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" })).toThrow(RegistryParityError);
});

test("two SQLite registry processes preserve every concurrent write without registry locks", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-writers-"));
  const filename = path.join(directory, "agent-registry.json");
  const seed = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  seed.ensureConversation("codex", "/sessions/seed.jsonl", "seed");
  const start = path.join(directory, "start");
  const count = 40;
  const children = ["alpha", "beta"].map((label) => {
    const ready = path.join(directory, `${label}.ready`);
    const child = Bun.spawn([process.execPath, CHILD, "writer", filename, ready, start, label, String(count)], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { child, ready };
  });
  for (const { ready } of children) waitFor(ready);
  fs.writeFileSync(start, "start");

  const exits = await Promise.all(children.map(({ child }) => child.exited));
  const errors = await Promise.all(children.map(({ child }) => new Response(child.stderr).text()));
  expect(exits).toEqual([0, 0]);
  expect(errors).toEqual(["", ""]);

  const snapshot = seed.snapshot();
  const written = Object.values(snapshot.conversations).filter((conversation) =>
    conversation.generations.some((generation) => /\/(?:alpha|beta)-\d+\.jsonl$/.test(generation.path)));
  expect(written).toHaveLength(count * 2);
  expect(new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot()).toEqual(snapshot);
  expect(fs.existsSync(`${filename}.write-lock`)).toBeFalse();
});

test("WAL readers stay available during a writer transaction", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-reader-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  const existing = registry.ensureConversation("codex", "/sessions/reader-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const child = Bun.spawn([process.execPath, CHILD, "hold", filename, ready, release], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(registry.snapshot().conversations[existing.id]).toBeDefined();
  expect(registry.snapshot().conversations.conversation_crash_mid_write).toBeUndefined();

  fs.writeFileSync(release, "release");
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  expect(registry.snapshot().conversations.conversation_crash_mid_write).toBeDefined();
});

test("a process exit inside a SQLite transaction rolls the registry back", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-crash-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  const existing = registry.ensureConversation("codex", "/sessions/crash-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const unusedRelease = path.join(directory, "unused-release");
  const child = Bun.spawn([process.execPath, CHILD, "crash", filename, ready, unusedRelease], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(await child.exited).toBe(73);
  expect(await new Response(child.stderr).text()).toBe("");
  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(recovered.conversations[existing.id]).toBeDefined();
  expect(recovered.conversations.conversation_crash_mid_write).toBeUndefined();
});

test("restart refreshes the JSON rollback mirror after a post-commit process exit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-post-commit-"));
  const filename = path.join(directory, "agent-registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" });
  registry.ensureConversation("codex", "/sessions/post-commit-seed.jsonl", "seed");
  const ready = path.join(directory, "ready");
  const unusedRelease = path.join(directory, "unused-release");
  const child = Bun.spawn([process.execPath, CHILD, "commit-crash", filename, ready, unusedRelease], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  waitFor(ready);

  expect(await child.exited).toBe(74);
  expect(await new Response(child.stderr).text()).toBe("");
  const recovered = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(recovered.conversations.conversation_crash_mid_write).toBeDefined();
  expect(new AgentRegistry(filename).snapshot()).toEqual(recovered);
});

test("SQLite-only operations avoid JSON rewrites and the read mode prepares rollback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-only-"));
  const filename = path.join(directory, "agent-registry.json");
  const sqlite = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const before = fs.readFileSync(filename, "utf8");

  const conversation = sqlite.ensureConversation("codex", "/sessions/sqlite-only.jsonl", "work");

  expect(sqlite.snapshot().conversations[conversation.id]).toBeDefined();
  expect(fs.readFileSync(filename, "utf8")).toBe(before);
  const rollback = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "read" }).snapshot();
  expect(new AgentRegistry(filename).snapshot()).toEqual(rollback);
  expect(rollback.conversations[conversation.id]).toBeDefined();
});

test("SQLite adoption keeps structured-host writer epochs fenced across restarts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-sqlite-adoption-"));
  const filename = path.join(directory, "agent-registry.json");
  const key = { engine: "codex" as const, sessionId: "sqlite-adoption" };
  const structuredHost = {
    kind: "codex-app-server" as const,
    endpoint: "stdio:released",
    process: null,
    eventCursor: 4,
    protocolVersion: "1",
    writerClaimEpoch: 0,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
  const first = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "read" });
  first.upsert({
    key,
    artifactPath: "/sessions/sqlite-adoption.jsonl",
    cwd: "/repo",
    accountId: "work",
    status: "unhosted",
    host: null,
    structuredHost,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const firstClaim = first.claimStructuredHost(key, { pid: 41, startIdentity: "41:first" }, { allowUnhosted: true });
  if (!firstClaim?.claimOwner) throw new Error("expected the first writer claim");

  const restarted = new AgentRegistry(filename, () => false, undefined, { sqliteMode: "read" });
  const replacement = restarted.claimStructuredHost(key, { pid: 42, startIdentity: "42:replacement" }, { allowUnhosted: true });
  if (!replacement?.claimOwner) throw new Error("expected the replacement writer claim");

  expect(replacement.claimEpoch).toBe(firstClaim.claimEpoch + 1);
  expect(first.setStructuredHostClaimed(key, structuredHost, "idle", firstClaim.claimOwner, firstClaim.claimEpoch)).toBeNull();
  expect(restarted.setStructuredHostClaimed(
    key,
    { ...structuredHost, writerClaimEpoch: replacement.claimEpoch, eventCursor: 5 },
    "idle",
    replacement.claimOwner,
    replacement.claimEpoch,
    true,
  )).toMatchObject({ status: "idle", claimOwner: null, structuredHost: { eventCursor: 5 } });
});

test("synthetic ten-lane load records JSON and SQLite registry operation p95", async () => {
  async function measure(mode: "json" | "sqlite"): Promise<number> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-registry-${mode}-ten-lane-`));
    const filename = path.join(directory, "agent-registry.json");
    const seed = new AgentRegistry(filename);
    const template = seed.beginSpawn("codex", "/benchmark-seed");
    const productionShape = seed.snapshot();
    for (let index = 1; index < 5_000; index += 1) {
      const launchId = `benchmark-seed-${String(index).padStart(5, "0")}`;
      productionShape.receipts[launchId] = { ...structuredClone(template), launchId };
    }
    fs.writeFileSync(filename, JSON.stringify(productionShape));
    if (mode === "sqlite") new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const start = path.join(directory, "start");
    const children = Array.from({ length: 10 }, (_, lane) => {
      const label = `${mode}-lane-${lane}`;
      const ready = path.join(directory, `${label}.ready`);
      const result = path.join(directory, `${label}.json`);
      const child = Bun.spawn([
        process.execPath,
        CHILD,
        mode === "sqlite" ? "writer-sqlite" : "writer-json",
        filename,
        ready,
        start,
        label,
        "12",
        result,
      ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      return { child, ready, result };
    });
    for (const { ready } of children) waitFor(ready);
    fs.writeFileSync(start, "start");
    expect(await Promise.all(children.map(({ child }) => child.exited))).toEqual(Array(10).fill(0));
    expect(await Promise.all(children.map(({ child }) => new Response(child.stderr).text()))).toEqual(Array(10).fill(""));
    const durations = children.flatMap(({ result }) => JSON.parse(fs.readFileSync(result, "utf8")) as number[]);
    expect(durations).toHaveLength(120);
    return percentile(durations, 0.95);
  }

  const jsonP95 = await measure("json");
  const sqliteP95 = await measure("sqlite");
  console.info(`[agent registry benchmark] ten-lane operation p95: JSON=${jsonP95.toFixed(1)}ms SQLite=${sqliteP95.toFixed(1)}ms`);
  expect(jsonP95).toBeGreaterThan(0);
  expect(sqliteP95).toBeGreaterThan(0);
  expect(sqliteP95).toBeLessThan(5_000);
}, 30_000);
