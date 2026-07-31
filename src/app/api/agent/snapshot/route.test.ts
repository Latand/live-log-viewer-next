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

test("snapshot route serves one completed 373-file projection without a second corpus walk", async () => {
  upsertPresence(presence);
  const files = Array.from({ length: 373 }, (_value, index): FileEntry => ({
    ...entry,
    path: index === 0 ? entry.path : `/fixture/project-${index % 41}/session-${index}.jsonl`,
    name: `session-${index}.jsonl`,
    project: `project-${index % 41}`,
    title: `Session ${index}`,
  }));
  let completedReads = 0;
  const refreshedAt = Date.now() - 10_000;
  const corpusWalksBefore = fileObservationGenerations();
  const request = new NextRequest("http://127.0.0.1:8898/api/agent/snapshot", {
    method: "POST",
    headers: { host: "127.0.0.1:8898" },
    body: JSON.stringify({ schemaVersion: 1, text: { include: false } }),
  });

  const response = await Promise.race([
    postSnapshot(request, {
      completedFileScan: async () => {
        completedReads += 1;
        return {
          snapshot: { files, projectCatalog: [], complete: true as const },
          generation: 7,
          targetGeneration: 7,
          cacheStatus: "hit" as const,
          requestCount: completedReads,
          cloneDurationMs: 0,
          refreshedAt,
        };
      },
      resolveSiblings: async () => ({ selfResolution: "omitted" as const, agents: [] }),
      registrySnapshot: () => ({ conversations: {}, entries: {}, lineageEdges: {}, memberships: {}, conversationAliases: {}, receipts: {} }) as never,
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
  expect(fileObservationGenerations()).toBe(corpusWalksBefore);
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
