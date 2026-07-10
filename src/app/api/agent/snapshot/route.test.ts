import { afterEach, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { FileEntry } from "@/lib/types";
import { collectSnapshot } from "@/lib/view/collect";
import { resetPresenceForTest, upsertPresence } from "@/lib/view/presenceStore";
import type { PresencePayloadV1 } from "@/lib/view/types";

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
    observeFiles: async () => { discoveries += 1; return [entry]; },
    resolveSiblings: async (_caller, files) => {
      expect(files).toEqual([entry]);
      return { selfResolution: "omitted" as const, agents: [] };
    },
  });
  expect(discoveries).toBe(1);
  expect(result.conversations[0]?.path).toBe(entry.path);
});
