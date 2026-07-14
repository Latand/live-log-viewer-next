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

test("filesApiUrl keeps project switches on the bounded scheme feed", () => {
  expect(filesApiUrl()).toBe("/api/files");
  expect(filesApiUrl(null)).toBe("/api/files");
  expect(filesApiUrl("stikon-dispatcher")).toBe("/api/files");
  expect(filesApiUrl("space project")).toBe("/api/files");
  expect(filesApiUrl("space project", "/sessions/quiet.jsonl")).toBe("/api/files?path=%2Fsessions%2Fquiet.jsonl");
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

test("an ordinary hydration waits for an in-flight forced revision refresh", async () => {
  let calls = 0;
  let forcedResolved = false;
  let releaseForced!: () => void;
  const forcedGate = new Promise<void>((resolve) => { releaseForced = resolve; });
  const cache = createFilesClientCache(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ files: [file("/initial", "Initial")] }));
    }
    if (calls === 2) {
      await forcedGate;
      forcedResolved = true;
      return new Response(JSON.stringify({ files: [file("/fresh", "Fresh")] }));
    }
    const path = forcedResolved ? "/fresh" : "/stale";
    return new Response(JSON.stringify({ files: [file(path, path)] }));
  });

  await cache.revalidate();
  const forced = cache.revalidate(undefined, 17);
  const ordinary = cache.revalidate();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(2);

  releaseForced();
  await Promise.all([forced, ordinary]);
  expect(calls).toBe(3);
  expect(cache.read().files.map((entry) => entry.path)).toEqual(["/fresh"]);
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
    return new Response(JSON.stringify({
      files: [file("/global", "Global"), file("/pinned", "Pinned")],
      pinOverlayPaths: ["/pinned"],
    }), {
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

test("a global 304 restores its exact cached membership and values", async () => {
  let globalRequests = 0;
  const cache = createFilesClientCache(async (input, init) => {
    if (input === "/api/files") {
      globalRequests += 1;
      if (globalRequests === 2) {
        expect(new Headers(init?.headers).get("If-None-Match")).toBe('"global-1"');
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({
        files: [file("/global", "Global 1"), file("/restored", "Restored")],
        flows: [{ id: "flow-restored" }],
        tasks: [{ id: "task-restored" }],
      }), {
        headers: { ETag: '"global-1"' },
      });
    }
    return new Response(JSON.stringify({
      files: [file("/global", "Global 2"), file("/removed", "Removed"), file("/archive/pinned", "Pinned")],
      pinOverlayPaths: ["/archive/pinned"],
      flows: [{ id: "flow-removed" }],
      tasks: [{ id: "task-removed" }],
    }), { headers: { ETag: '"pinned-2"' } });
  });

  await cache.revalidate();
  const pinned = await cache.revalidate("/archive/pinned");
  expect(pinned.files.map((entry) => entry.title)).toEqual(["Global 2", "Removed", "Pinned"]);

  const restored = await cache.revalidate();
  expect(restored.files.map((entry) => entry.title)).toEqual(["Global 1", "Restored"]);
  expect(restored.flows.map((flow) => flow.id)).toEqual(["flow-restored"]);
  expect(restored.tasks.map((task) => task.id)).toEqual(["task-restored"]);
  expect(restored.requestScope).toBe("/api/files");
});

test("releasing a migrated deep-link pin removes every pin-only closure row on a global 304", async () => {
  const predecessor = "/archive/predecessor.jsonl";
  const current = "/sessions/current.jsonl";
  const closure = "/sessions/closure-parent.jsonl";
  let globalRequests = 0;
  const cache = createFilesClientCache(async (input, init) => {
    if (input === "/api/files") {
      globalRequests += 1;
      if (globalRequests === 2) {
        expect(new Headers(init?.headers).get("If-None-Match")).toBe('"global"');
        return new Response(null, { status: 304 });
      }
      return new Response(JSON.stringify({ files: [file("/global", "Global")] }), {
        headers: { ETag: '"global"' },
      });
    }
    return new Response(JSON.stringify({
      files: [
        file("/global", "Global"),
        file(predecessor, "Predecessor"),
        file(current, "Current"),
        file(closure, "Closure parent"),
      ],
      pinOverlayPaths: [predecessor, current, closure],
    }), { headers: { ETag: '"pinned"' } });
  });

  await cache.revalidate();
  await cache.revalidate(predecessor);
  const released = await cache.revalidate();

  expect(released.files.map((entry) => entry.path)).toEqual(["/global"]);
  expect(released.requestScope).toBe("/api/files");
});

test("a global 304 restores an ordinary lineage row from its cached representation", async () => {
  const globalChild = "/sessions/global-child.jsonl";
  const pinnedChild = "/archive/pinned-child.jsonl";
  const sharedParent = "/sessions/shared-parent.jsonl";
  let globalRequests = 0;
  const cache = createFilesClientCache(async (input) => {
    if (input === "/api/files") {
      globalRequests += 1;
      if (globalRequests === 2) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({
        files: [file(globalChild, "Global child"), file(sharedParent, "Shared parent")],
      }), { headers: { ETag: '"global"' } });
    }
    return new Response(JSON.stringify({
      files: [
        file(globalChild, "Global child fresh"),
        file(pinnedChild, "Pinned child"),
        file(sharedParent, "Shared parent fresh"),
      ],
      pinOverlayPaths: [pinnedChild, sharedParent],
    }), { headers: { ETag: '"pinned"' } });
  });

  await cache.revalidate();
  await cache.revalidate(pinnedChild);
  const released = await cache.revalidate();

  expect(released.files.map((entry) => entry.path)).toEqual([globalChild, sharedParent]);
  expect(released.files.find((entry) => entry.path === sharedParent)?.title).toBe("Shared parent");
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

function pipelineRow(id: string, task: string, over: Record<string, unknown> = {}) {
  return { id, task, project: "project-a", state: "draft", stages: [], runs: [], cursor: null, hiddenAt: null, ...over };
}

test("a pipeline echo applies without a refetch and survives a STALE in-flight scan (issue #221 §3)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let call = 0;
  const cache = createFilesClientCache(async () => {
    const index = call++;
    /* Scan 2 was requested BEFORE the echo landed server-side: it still carries
       the pre-mutation record. */
    if (index === 1) await gate;
    return new Response(JSON.stringify({ files: [], pipelines: [pipelineRow("p1", "old task")] }), { headers: { ETag: `"${index}"` } });
  });

  await cache.revalidate();
  const stale = cache.revalidate();
  /* Let the stale scan's request actually START (mint its generation) before
     the mutation echoes — that is the real race: a fetch already in flight
     when the PATCH persists. */
  await Promise.resolve();
  await Promise.resolve();
  cache.applyPipeline(pipelineRow("p1", "patched task") as never, true);
  expect(cache.read().pipelines[0]!.task).toBe("patched task");

  release();
  await stale;
  /* The stale scan must not roll the confirmed patch back… */
  expect(cache.read().pipelines[0]!.task).toBe("patched task");
  /* …but a scan REQUESTED after the echo is authoritative and retires the overlay. */
  await cache.revalidate();
  expect(cache.read().pipelines[0]!.task).toBe("old task");
});

test("an unconfirmed optimistic pipeline outlives every scan until reverted", async () => {
  const cache = createFilesClientCache(async () =>
    new Response(JSON.stringify({ files: [], pipelines: [pipelineRow("p1", "server")] })));
  await cache.revalidate();
  cache.applyPipeline(pipelineRow("p1", "optimistic") as never, false);
  await cache.revalidate();
  expect(cache.read().pipelines[0]!.task).toBe("optimistic");
  cache.revertPipeline("p1");
  expect(cache.read().pipelines[0]!.task).toBe("server");
});

test("a created-draft echo appears before any scan lists it; a hidden (deleted) echo disappears", async () => {
  const cache = createFilesClientCache(async () =>
    new Response(JSON.stringify({ files: [], pipelines: [] })));
  await cache.revalidate();
  cache.applyPipeline(pipelineRow("fresh", "new draft") as never, true);
  expect(cache.read().pipelines.map((pipeline) => pipeline.id)).toEqual(["fresh"]);
  cache.applyPipeline(pipelineRow("fresh", "new draft", { hiddenAt: "1970" }) as never, true);
  expect(cache.read().pipelines).toEqual([]);
});

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
