import { expect, test } from "bun:test";

import { parseConversationHash, resolveConversationTarget } from "@/lib/accounts/identity";
import {
  filesRequestPin,
  pinForProject,
  releaseConversationPin,
  resolvedConversationPin,
  type ActiveConversationPin,
} from "@/components/conversationPin";

import { createFilesClientCache, filesApiUrl, filesPollCadence, filesRequestHeaders, type FilesData } from "./useFiles";

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

test("client cache subscriptions receive updates only for their request scope", async () => {
  const pinnedPath = "/archive/scoped-pin.jsonl";
  const cache = createFilesClientCache(async (input) => {
    const files = input === "/api/files"
      ? [file("/global", "Global")]
      : [file("/global", "Global"), file(pinnedPath, "Pinned")];
    return new Response(JSON.stringify({ files }));
  });
  const globalUpdates: string[][] = [];
  const pinnedUpdates: string[][] = [];
  const unsubscribeGlobal = cache.subscribe((data) => {
    globalUpdates.push(data.files.map((entry) => entry.path));
  });
  const unsubscribePinned = cache.subscribe((data) => {
    pinnedUpdates.push(data.files.map((entry) => entry.path));
  }, pinnedPath);

  await cache.revalidate(pinnedPath);
  expect(globalUpdates).toEqual([]);
  expect(pinnedUpdates).toEqual([["/global", pinnedPath]]);

  await cache.revalidate();
  expect(globalUpdates).toEqual([["/global"]]);
  expect(pinnedUpdates).toEqual([["/global", pinnedPath]]);
  unsubscribeGlobal();
  unsubscribePinned();
});

test("pipeline patches publish each cached URL representation without refetching", async () => {
  const pinnedPath = "/archive/scoped-pipeline-pin.jsonl";
  let fetches = 0;
  const cache = createFilesClientCache(async (input) => {
    fetches += 1;
    const pinned = input !== "/api/files";
    return new Response(JSON.stringify({
      files: pinned
        ? [file("/global", "Global"), file(pinnedPath, "Pinned")]
        : [file("/global", "Global")],
      pinOverlayPaths: pinned ? [pinnedPath] : [],
      pipelines: [pipelineRow("p1", "server")],
    }));
  });
  const notifications: Array<{ listener: "pinned" | "global"; scope: string | null; files: string[]; pins: string[]; task: string }> = [];
  const unsubscribePinned = cache.subscribe((data) => notifications.push({
    listener: "pinned",
    scope: data.requestScope,
    files: data.files.map((entry) => entry.path),
    pins: data.pinOverlayPaths,
    task: data.pipelines[0]?.task ?? "",
  }), pinnedPath);
  const unsubscribeGlobal = cache.subscribe((data) => notifications.push({
    listener: "global",
    scope: data.requestScope,
    files: data.files.map((entry) => entry.path),
    pins: data.pinOverlayPaths,
    task: data.pipelines[0]?.task ?? "",
  }));

  await cache.revalidate(pinnedPath);
  await cache.revalidate();
  notifications.length = 0;

  cache.applyPipeline(pipelineRow("p1", "patched") as never, false);
  expect(fetches).toBe(2);
  expect(notifications).toEqual([
    {
      listener: "pinned",
      scope: filesApiUrl(undefined, pinnedPath),
      files: ["/global", pinnedPath],
      pins: [pinnedPath],
      task: "patched",
    },
    {
      listener: "global",
      scope: "/api/files",
      files: ["/global"],
      pins: [],
      task: "patched",
    },
  ]);

  notifications.length = 0;
  cache.revertPipeline("p1");
  expect(fetches).toBe(2);
  expect(notifications.map(({ listener, scope, task }) => ({ listener, scope, task }))).toEqual([
    { listener: "pinned", scope: filesApiUrl(undefined, pinnedPath), task: "server" },
    { listener: "global", scope: "/api/files", task: "server" },
  ]);

  unsubscribePinned();
  notifications.length = 0;
  cache.applyPipeline(pipelineRow("p1", "patched again") as never, false);
  expect(notifications.map(({ listener }) => listener)).toEqual(["global"]);
  unsubscribeGlobal();
});

test("a pinned generation retry restores its ETag representation with the local pipeline overlay", async () => {
  const pinnedPath = "/archive/retrying-pipeline-pin.jsonl";
  const pinnedUrl = filesApiUrl(undefined, pinnedPath);
  let pinnedRequests = 0;
  const cache = createFilesClientCache(async (input, init) => {
    if (input === "/api/files") {
      return new Response(JSON.stringify({
        files: [file("/global", "Global")],
        pipelines: [pipelineRow("p1", "server")],
      }), { headers: { ETag: '"global"' } });
    }
    pinnedRequests += 1;
    if (pinnedRequests > 1) {
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"pinned"');
      expect(new Headers(init?.headers).get("x-llv-files-generation")).toBe(pinnedRequests === 2 ? null : "1");
      return new Response(null, {
        status: 304,
        headers: {
          "x-llv-files-generation": pinnedRequests === 2 ? "0" : "1",
          "x-llv-files-target-generation": "1",
        },
      });
    }
    return new Response(JSON.stringify({
      files: [file("/global", "Global"), file(pinnedPath, "Pinned")],
      pinOverlayPaths: [pinnedPath],
      pipelines: [pipelineRow("p1", "server")],
    }), { headers: { ETag: '"pinned"' } });
  });
  const notifications: string[] = [];
  const unsubscribePinned = cache.subscribe((data) => notifications.push(
    `pinned:${data.requestScope}:${data.files.map((entry) => entry.path).join(",")}:${data.pipelines[0]?.task}`,
  ), pinnedPath);
  const unsubscribeGlobal = cache.subscribe((data) => notifications.push(
    `global:${data.requestScope}:${data.files.map((entry) => entry.path).join(",")}:${data.pipelines[0]?.task}`,
  ));

  await cache.revalidate(pinnedPath);
  await cache.revalidate();
  cache.applyPipeline(pipelineRow("p1", "optimistic") as never, false);
  notifications.length = 0;
  await cache.revalidate(pinnedPath, 12);
  await Bun.sleep(60);

  expect(pinnedRequests).toBe(3);
  expect(notifications).toEqual([
    `pinned:${pinnedUrl}:/global,${pinnedPath}:optimistic`,
    `pinned:${pinnedUrl}:/global,${pinnedPath}:optimistic`,
  ]);
  unsubscribePinned();
  unsubscribeGlobal();
});

test("active scoped representations survive LRU pressure during a pipeline patch", async () => {
  const pinnedPaths = Array.from({ length: 10 }, (_, index) => `/archive/active-pin-${index}.jsonl`);
  const cache = createFilesClientCache(async (input) => {
    const url = new URL(input, "http://127.0.0.1");
    const pinnedPath = url.searchParams.get("path")!;
    return new Response(JSON.stringify({
      files: [file("/global", "Global"), file(pinnedPath, "Pinned")],
      pinOverlayPaths: [pinnedPath],
      pipelines: [pipelineRow("p1", "server")],
    }));
  });
  const updates = new Map<string, FilesData>();
  const unsubscribes = pinnedPaths.map((pinnedPath) => cache.subscribe((data) => {
    updates.set(pinnedPath, data);
  }, pinnedPath));
  for (const pinnedPath of pinnedPaths) await cache.revalidate(pinnedPath);
  updates.clear();

  cache.applyPipeline(pipelineRow("p1", "patched") as never, false);

  expect([...updates]).toHaveLength(pinnedPaths.length);
  for (const pinnedPath of pinnedPaths) {
    expect(updates.get(pinnedPath)?.files.map((entry) => entry.path)).toEqual(["/global", pinnedPath]);
    expect(updates.get(pinnedPath)?.pipelines[0]?.task).toBe("patched");
  }
  for (const unsubscribe of unsubscribes) unsubscribe();
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

test("a generation retry preserves a pipeline echo newer than the scan it completes", async () => {
  let call = 0;
  let releaseStale!: () => void;
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
  const cache = createFilesClientCache(async () => {
    call += 1;
    if (call === 2) await staleGate;
    const headers = call === 2
      ? { "x-llv-files-generation": "0", "x-llv-files-target-generation": "1" }
      : call === 3
        ? { "x-llv-files-generation": "1", "x-llv-files-target-generation": "1" }
        : undefined;
    return new Response(JSON.stringify({ files: [], pipelines: [pipelineRow("p1", "server")] }), { headers });
  });
  const unsubscribe = cache.subscribe(() => {});

  await cache.revalidate();
  const stale = cache.revalidate(undefined, 9);
  await Promise.resolve();
  await Promise.resolve();
  cache.applyPipeline(pipelineRow("p1", "patched") as never, true);
  releaseStale();
  await stale;
  await Bun.sleep(50);

  expect(call).toBe(3);
  expect(cache.read().pipelines[0]?.task).toBe("patched");
  await cache.revalidate();
  expect(cache.read().pipelines[0]?.task).toBe("server");
  unsubscribe();
});

test("multi-second generation completion uses one bounded retry chain per scope and stops after unsubscribe", async () => {
  const startedAt = performance.now();
  const requestedTargets: string[] = [];
  let calls = 0;
  const cache = createFilesClientCache(async (_input, init) => {
    calls += 1;
    const target = new Headers(init?.headers).get("x-llv-files-generation");
    if (target) requestedTargets.push(target);
    const complete = performance.now() - startedAt >= 2_100;
    return new Response(JSON.stringify({
      files: [file(complete ? "/complete" : "/stale", complete ? "Complete" : "Stale")],
      pipelines: [pipelineRow("p1", "server")],
    }), {
      headers: {
        "x-llv-files-generation": complete ? "1" : "0",
        "x-llv-files-target-generation": "1",
      },
    });
  });
  const firstUpdates: string[] = [];
  const secondUpdates: string[] = [];
  const unsubscribeFirst = cache.subscribe((data) => firstUpdates.push(data.files[0]?.path ?? ""));
  const unsubscribeSecond = cache.subscribe((data) => secondUpdates.push(data.files[0]?.path ?? ""));

  await Promise.all([
    cache.revalidate(undefined, 31),
    cache.revalidate(undefined, 31),
  ]);
  cache.applyPipeline(pipelineRow("p1", "patched") as never, true);
  for (let attempt = 0; attempt < 80 && cache.read().files[0]?.path !== "/complete"; attempt += 1) {
    await Bun.sleep(50);
  }

  expect(cache.read().files[0]?.path).toBe("/complete");
  expect(cache.read().pipelines[0]?.task).toBe("patched");
  expect(calls).toBeLessThanOrEqual(10);
  expect(requestedTargets.length).toBeGreaterThan(0);
  expect(new Set(requestedTargets)).toEqual(new Set(["1"]));
  expect(firstUpdates.at(-1)).toBe("/complete");
  expect(secondUpdates).toEqual(firstUpdates);

  await cache.revalidate();
  expect(cache.read().pipelines[0]?.task).toBe("server");
  unsubscribeFirst();
  unsubscribeSecond();

  let callsAfterResubscribe = 0;
  const cancellationCache = createFilesClientCache(async () => {
    callsAfterResubscribe += 1;
    return new Response(JSON.stringify({ files: [] }), {
      headers: {
        "x-llv-files-generation": "0",
        "x-llv-files-target-generation": "1",
      },
    });
  });
  const unsubscribe = cancellationCache.subscribe(() => {});
  await cancellationCache.revalidate();
  unsubscribe();
  const unsubscribeReplacement = cancellationCache.subscribe(() => {});
  await Bun.sleep(75);
  expect(callsAfterResubscribe).toBe(1);
  unsubscribeReplacement();
});

test("a queued completion retry stays canceled after final unsubscribe and resubscribe", async () => {
  const blockerPath = "/queue/blocker";
  const drainPath = "/queue/drain";
  let releaseBlocker!: () => void;
  let markBlockerStarted!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const blockerStarted = new Promise<void>((resolve) => { markBlockerStarted = resolve; });
  let globalCalls = 0;
  const cache = createFilesClientCache(async (input) => {
    if (input === filesApiUrl(undefined, blockerPath)) {
      markBlockerStarted();
      await blockerGate;
      return new Response(JSON.stringify({ files: [file(blockerPath, "Blocker")] }));
    }
    if (input === filesApiUrl(undefined, drainPath)) {
      return new Response(JSON.stringify({ files: [file(drainPath, "Drain")] }));
    }
    globalCalls += 1;
    return new Response(JSON.stringify({ files: [file(`/global/${globalCalls}`, "Global")] }), {
      headers: {
        "x-llv-files-generation": globalCalls === 1 ? "0" : "1",
        "x-llv-files-target-generation": "1",
      },
    });
  });
  const unsubscribe = cache.subscribe(() => {});

  await cache.revalidate();
  const blocker = cache.revalidate(blockerPath);
  await blockerStarted;
  await Bun.sleep(75);
  unsubscribe();
  const unsubscribeReplacement = cache.subscribe(() => {});
  releaseBlocker();
  await blocker;
  await cache.revalidate(drainPath);

  expect(globalCalls).toBe(1);
  await cache.revalidate();
  expect(globalCalls).toBe(2);
  unsubscribeReplacement();
});

test("disposing a cache aborts active completion and prevents timers and listeners from escaping", async () => {
  let calls = 0;
  let activeSignal: AbortSignal | undefined;
  let markActive!: () => void;
  const active = new Promise<void>((resolve) => { markActive = resolve; });
  const updates: string[] = [];
  const cache = createFilesClientCache(async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ files: [file("/stale", "Stale")] }), {
        headers: {
          "x-llv-files-generation": "0",
          "x-llv-files-target-generation": "1",
        },
      });
    }
    activeSignal = init?.signal ?? undefined;
    markActive();
    return new Promise<Response>((_resolve, reject) => {
      activeSignal?.addEventListener("abort", () => reject(activeSignal?.reason), { once: true });
    });
  });
  cache.subscribe((data) => updates.push(data.files[0]?.path ?? ""));

  await cache.revalidate();
  await active;
  cache.dispose();
  const updatesAtDispose = [...updates];
  await Bun.sleep(75);
  cache.applyPipeline(pipelineRow("p1", "escaped") as never, false);

  expect(activeSignal?.aborted).toBe(true);
  expect(calls).toBe(2);
  expect(updates).toEqual(updatesAtDispose);
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
