import { expect, test } from "bun:test";

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
