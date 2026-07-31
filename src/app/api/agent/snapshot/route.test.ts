import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { FileEntry } from "@/lib/types";
import { fileObservationGenerations } from "@/lib/scanner/observe";
import { collectSnapshot } from "@/lib/view/collect";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

import { postSnapshot } from "./handler";
import { POST } from "./route";

afterEach(() => resetPresenceForTest());

const presence: PresencePayloadV1 = {
  schemaVersion: 1, viewSessionId: "route-view", deviceId: "route-device", device: { kind: "desktop", browser: "chrome" }, visibility: "visible", sequence: 1, inputSequence: 1,
  project: "viewer", mode: "scheme", viewport: { width: 100, height: 100, dpr: 1 }, camera: null, focusedPath: "/a.jsonl", selectedPaths: [], visiblePaths: ["/a.jsonl"],
  board: { renderedRevision: null, durableRevision: null, sync: "unavailable" },
};
const entry: FileEntry = { path: "/a.jsonl", root: "claude-projects", name: "a.jsonl", project: "viewer", title: "A", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null };

test("snapshot rejects hostile browser headers before body validation", async () => {
  const request = new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", { method: "POST", headers: { host: "127.0.0.1:8898", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "{}" });
  const response = await POST(request);
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("snapshot permits a headerless CLI request to reach strict validation", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", { method: "POST", headers: { host: "127.0.0.1:8898" }, body: "{}" }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "UNSUPPORTED_SCHEMA_VERSION" });
});

test("snapshot collection performs exactly one discovery and shares its entries", async () => {
  upsertPresence(presence);
  let discoveries = 0;
  const result = await collectSnapshot({ schemaVersion: 1, text: { include: false } }, {
    completedFileScan: async () => {
      discoveries += 1;
      return { snapshot: { files: [entry], projectCatalog: [], complete: true } } as never;
    },
    resolveSiblings: async (_caller, files) => {
      expect(files).toEqual([entry]);
      return { selfResolution: "omitted" as const, agents: [] };
    },
  });
  expect(discoveries).toBe(1);
  expect(result.conversations[0]?.path).toBe(entry.path);
});

test("transcript-only snapshot serves one completed 373-file projection without reading the registry", async () => {
  upsertPresence(presence);
  const files = Array.from({ length: 373 }, (_value, index): FileEntry => ({
    ...entry,
    path: index === 0 ? entry.path : `/fixture/project-${index % 41}/session-${index}.jsonl`,
    name: `session-${index}.jsonl`,
    project: `project-${index % 41}`,
    title: `Session ${index}`,
  }));
  const projectCatalog = Array.from({ length: 41 }, (_value, index) => ({
    project: `project-${index}`,
    smt: 1,
    conversations: files.filter((file) => file.project === `project-${index}`).length,
  }));
  let completedReads = 0;
  let registryReads = 0;
  const refreshedAt = Date.now() - 10_000;
  const corpusWalksBefore = fileObservationGenerations();
  const request = new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", {
    method: "POST",
    headers: { host: "127.0.0.1:8898" },
    body: JSON.stringify({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }),
  });

  const response = await Promise.race([
    postSnapshot(request, {
      completedFileScan: async () => {
        completedReads += 1;
        return {
          snapshot: { files, projectCatalog, complete: true as const },
          generation: 7,
          targetGeneration: 7,
          cacheStatus: "hit" as const,
          requestCount: completedReads,
          cloneDurationMs: 0,
          refreshedAt,
        };
      },
      resolveSiblings: async () => ({ selfResolution: "omitted" as const, agents: [] }),
      registrySnapshot: () => {
        registryReads += 1;
        throw new Error("transcript-only snapshot touched the poisoned registry");
      },
      snapshotDeadlineMs: 10_000,
      scheduler: { setTimeout, clearTimeout },
    }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("snapshot response exceeded its 1s bound")), 1_000)),
  ]);

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.scanner.entryCount).toBe(373);
  expect(payload.scanner.ageMs).toBeGreaterThanOrEqual(9_000);
  expect(payload.scanner.ageMs).toBeLessThan(11_000);
  expect(completedReads).toBe(1);
  expect(registryReads).toBe(0);
  expect(fileObservationGenerations()).toBe(corpusWalksBefore);
});

test("twenty concurrent transcript-only snapshots retain no registry or response corpus", async () => {
  upsertPresence(presence);
  const files = Array.from({ length: 373 }, (_value, index): FileEntry => ({
    ...entry,
    path: index === 0 ? entry.path : `/fixture/project-${index % 41}/session-${index}.jsonl`,
    name: `session-${index}.jsonl`,
    project: `project-${index % 41}`,
    title: `Session ${index}`,
  }));
  let wholeRegistrySnapshots = 0;
  let compactSpawnLookups = 0;
  Bun.gc(true);
  const rssBefore = process.memoryUsage.rss();
  let responses: Response[] | null = await Promise.all(Array.from({ length: 20 }, () => postSnapshot(
    new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", {
      method: "POST",
      headers: { host: "127.0.0.1:8898" },
      body: JSON.stringify({ schemaVersion: 1, scope: { kind: "visible" }, text: { include: false } }),
    }),
    {
      completedFileScan: async () => ({ snapshot: { files, projectCatalog: [], complete: true } }) as never,
      resolveSiblings: async () => ({ selfResolution: "omitted" as const, agents: [] }),
      registrySnapshot: () => {
        wholeRegistrySnapshots += 1;
        throw new Error("transcript-only snapshot materialized the whole registry");
      },
      snapshotSpawns: () => {
        compactSpawnLookups += 1;
        return {};
      },
      snapshotDeadlineMs: 10_000,
      scheduler: { setTimeout, clearTimeout },
    },
  )));

  expect(responses.every((response) => response.status === 200)).toBe(true);
  await Promise.all(responses.map((response) => response.text()));
  expect(wholeRegistrySnapshots).toBe(0);
  expect(compactSpawnLookups).toBe(0);
  responses = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  Bun.gc(true);
  const retainedRss = process.memoryUsage.rss() - rssBefore;
  expect(retainedRss).toBeLessThan(16 * 1024 * 1024);
});

test("snapshot route owns a deadline when the framework request signal stays live", async () => {
  upsertPresence(presence);
  let deadline!: () => void;
  let activeTimers = 0;
  let scanSignal: AbortSignal | null = null;
  const request = new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", {
    method: "POST",
    headers: { host: "127.0.0.1:8898" },
    body: JSON.stringify({ schemaVersion: 1, text: { include: false } }),
  });

  const responsePromise = postSnapshot(request, {
    completedFileScan: ({ signal } = {}) => new Promise((_resolve, reject) => {
      scanSignal = signal ?? null;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    resolveSiblings: async () => ({ selfResolution: "omitted" as const, agents: [] }),
    registrySnapshot: () => ({ conversations: {}, entries: {}, lineageEdges: {}, memberships: {}, conversationAliases: {}, receipts: {} }) as never,
    snapshotDeadlineMs: 10_000,
    scheduler: {
      setTimeout: (handler) => {
        activeTimers += 1;
        deadline = () => {
          activeTimers -= 1;
          handler();
        };
        return 1;
      },
      clearTimeout: () => { activeTimers -= 1; },
    },
  });
  for (let attempt = 0; attempt < 10 && activeTimers === 0; attempt += 1) await Promise.resolve();

  expect(request.signal.aborted).toBe(false);
  expect(activeTimers).toBe(1);
  deadline();
  const response = await responsePromise;

  expect(response.status).toBe(499);
  expect((scanSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(activeTimers).toBe(0);
});
