import { expect, test } from "bun:test";

import { parseConversationHash, resolveConversationTarget } from "@/lib/accounts/identity";
import {
  filesRequestPin,
  pinForProject,
  releaseConversationPin,
  resolvedConversationPin,
  type ActiveConversationPin,
} from "@/components/conversationPin";

import { createFilesClientCache, filesApiUrl, filesPollCadence, filesRequestHeaders } from "./useFiles";

test("filesApiUrl always addresses the global snapshot", () => {
  expect(filesApiUrl()).toBe("/api/files");
  expect(filesApiUrl(null)).toBe("/api/files");
  expect(filesApiUrl("/sessions/pinned.jsonl")).toBe("/api/files?path=%2Fsessions%2Fpinned.jsonl");
});

test("global client cache serves stale rows while revalidation patches changed files", async () => {
  const bodies = [
    { files: [file("/a", "A"), file("/b", "B")], flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" as const } } },
    { files: [file("/a", "A"), file("/b", "B2"), file("/c", "C")], flows: [], pipelines: [], workflows: [], tasks: [], systemHealth: { tmux: { status: "healthy" as const } } },
  ];
  let call = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = createFilesClientCache(async () => {
    const index = call++;
    if (index === 1) await gate;
    return new Response(JSON.stringify(bodies[index]), { status: 200, headers: { ETag: `"${index}"` } });
  });

  const first = await cache.revalidate();
  const refresh = cache.revalidate();

  expect(cache.read()).toBe(first);
  expect(cache.read().files.map((entry) => entry.title)).toEqual(["A", "B"]);
  release();
  const second = await refresh;
  expect(second.files.map((entry) => entry.title)).toEqual(["A", "B2", "C"]);
  expect(second.files[0]).toBe(first.files[0]);
  expect(second.files[1]).not.toBe(first.files[1]);
});

test("URL-specific 304 responses restore the matching cached representation", async () => {
  const cache = createFilesClientCache(async (input, init) => {
    const headers = new Headers(init?.headers);
    if (input === "/api/files" && headers.get("If-None-Match") === '"global"') {
      return new Response(null, { status: 304 });
    }
    if (input === "/api/files") {
      return new Response(JSON.stringify({ files: [file("/global", "Global")] }), {
        headers: { ETag: '"global"' },
      });
    }
    return new Response(JSON.stringify({ files: [file("/global", "Global"), file("/pinned", "Pinned")] }), {
      headers: { ETag: '"pinned"' },
    });
  });

  await cache.revalidate();
  await cache.revalidate("/pinned");
  const restored = await cache.revalidate();

  expect(restored.files.map((entry) => entry.path)).toEqual(["/global"]);
  expect(restored.requestScope).toBe("/api/files");
  expect(cache.read()).toBe(restored);
});

test("an out-of-cap #f target keeps its pinned representation through background revalidation", async () => {
  const targetPath = "/archive/out-of-cap.jsonl";
  const intent = parseConversationHash(`#f=${encodeURIComponent(targetPath)}`);
  const requests: string[] = [];
  let version = 0;
  const cache = createFilesClientCache(async (input) => {
    requests.push(input);
    version += 1;
    const files = input === "/api/files"
      ? [file("/global", "Global")]
      : [file("/global", "Global"), file(targetPath, `Target ${version}`)];
    return new Response(JSON.stringify({ files }), { headers: { ETag: `"${version}"` } });
  });

  let active: ActiveConversationPin | null = null;
  const pinned = await cache.revalidate(filesRequestPin(intent, active));
  const hit = resolveConversationTarget(pinned.files, intent, {});
  expect(hit?.path).toBe(targetPath);
  active = resolvedConversationPin(intent, hit!);

  const refreshed = await cache.revalidate(filesRequestPin(null, active));
  expect(refreshed.files.find((entry) => entry.path === targetPath)?.title).toBe("Target 2");
  expect(requests).toEqual([
    `/api/files?path=${encodeURIComponent(targetPath)}`,
    `/api/files?path=${encodeURIComponent(targetPath)}`,
  ]);
});

test("closing an out-of-cap #f card releases its pinned representation", async () => {
  const targetPath = "/archive/closed-target.jsonl";
  const intent = parseConversationHash(`#f=${encodeURIComponent(targetPath)}`);
  const requests: string[] = [];
  const cache = createFilesClientCache(async (input) => {
    requests.push(input);
    const files = input === "/api/files"
      ? [file("/global", "Global")]
      : [file("/global", "Global"), file(targetPath, "Pinned")];
    return new Response(JSON.stringify({ files }));
  });

  const pinned = await cache.revalidate(filesRequestPin(intent, null));
  const hit = resolveConversationTarget(pinned.files, intent, {})!;
  const active = resolvedConversationPin(intent, hit);
  const afterClose = releaseConversationPin(active, hit.path);
  const refreshed = await cache.revalidate(filesRequestPin(null, afterClose));

  expect(refreshed.files.map((entry) => entry.path)).toEqual(["/global"]);
  expect(requests).toEqual([
    `/api/files?path=${encodeURIComponent(targetPath)}`,
    "/api/files",
  ]);
});

test("project navigation releases an active #f pin after leaving its card project", () => {
  const targetPath = "/archive/navigation-target.jsonl";
  const intent = parseConversationHash(`#f=${encodeURIComponent(targetPath)}`);
  const target = file(targetPath, "Pinned");
  const active = resolvedConversationPin(intent, target);

  expect(pinForProject(active, target.project)).toBe(active);
  expect(pinForProject(active, "project-b")).toBeNull();
});

function file(path: string, title: string) {
  return {
    path,
    root: "codex-sessions" as const,
    name: path,
    project: path === "/c" ? "project-b" : "project-a",
    title,
    engine: "codex" as const,
    kind: "session",
    fmt: "codex" as const,
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent" as const,
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("files revision reads identify the revision and retain ETag revalidation", () => {
  expect(filesRequestHeaders("", undefined)).toBeUndefined();
  expect(filesRequestHeaders('"cached"', 42)).toEqual({
    "If-None-Match": '"cached"',
    "x-llv-files-revision": "42",
  });
});

test("a healthy live stream disables the recurring files poll; every other state restores it", () => {
  expect(filesPollCadence("live")).toBe("live");
  expect(filesPollCadence("reconnecting")).toBe("poll");
  expect(filesPollCadence("degraded")).toBe("poll");
  expect(filesPollCadence("offline")).toBe("poll");
});
