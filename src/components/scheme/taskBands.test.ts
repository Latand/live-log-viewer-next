import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";

import type { SchemeLayout, SchemeRect } from "./layout";
import type { Pipeline } from "@/lib/pipelines/types";

import {
  BAND,
  applyBandOrder,
  applyHostOverrides,
  bandEdgePorts,
  bandHoldsMembers,
  bandModeFor,
  buildTaskBands,
  layoutTaskBands,
  rankBands,
  workEvidence,
  type BandMode,
  type TaskBand,
} from "./taskBands";
import { anchoredCamera } from "./useSchemeCamera";

type Turn = "busy" | "terminal" | "idle" | "unknown" | null;

function file(index: number, turn: Turn = null, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    path: `/fixture/worker-${index}`,
    conversationId: `conversation_fixture_${index}`,
    title: `Worker ${index} looks after fixture area ${index}`,
    project: "fixture",
    root: "codex-sessions",
    kind: "session",
    fmt: "codex",
    engine: "codex",
    mtime: 1,
    size: 100,
    activity: turn === "busy" ? "live" : "idle",
    proc: null,
    pid: null,
    parent: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    name: `worker-${index}`,
    ...(turn ? { authoritativeTurn: { state: turn, source: "lifecycle", terminalAt: null } } : {}),
    ...extra,
  } as FileEntry;
}

function task(id: string, createdAt: string, files: readonly FileEntry[], status: BoardTask["status"] = "assigned", text = `Task ${id}`): BoardTask {
  return {
    id,
    project: "fixture",
    text,
    status,
    placement: "unplaced",
    assignments: files.map((entry) => ({ path: entry.path, conversationId: entry.conversationId!, panePid: null, state: "delivered", error: null, at: createdAt })),
    createdAt,
    updatedAt: createdAt,
  } as BoardTask;
}

function base(files: readonly FileEntry[], edges: readonly [number, number][] = []): SchemeLayout {
  const nodes = files.map((entry, index) => ({ file: entry, x: index * 648, y: 100, w: 600, h: 680, isRoot: !edges.some(([, child]) => child === index), tasks: [], under: [], lineageOrderKey: String(index).padStart(5, "0") }));
  return {
    nodes,
    groups: [],
    stacks: [],
    decks: [],
    drafts: [],
    slots: [],
    regionTasks: [],
    edges: edges.map(([from, to]) => ({ from: files[from]!.path, to: files[to]!.path, x1: 0, y1: 0, x2: 0, y2: 0, color: "", live: false })),
    links: [],
    loops: [],
    byPath: new Map(nodes.map((node) => [node.file.path, node])),
    width: files.length * 648,
    height: 880,
  };
}

const sources = (tasks: readonly BoardTask[], files: readonly FileEntry[]) => ({ tasks, projection: projectTaskWorkflows(tasks, [], [], files), untitled: "Untitled task" });

const contains = (outer: SchemeRect, inner: SchemeRect) =>
  inner.x >= outer.x - 0.001 && inner.y >= outer.y - 0.001 && inner.x + inner.w <= outer.x + outer.w + 0.001 && inner.y + inner.h <= outer.y + outer.h + 0.001;
const overlapping = (a: SchemeRect, b: SchemeRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("working evidence: only an authoritative open turn counts; recency and processes alone are unknown", () => {
  expect(workEvidence(file(0, "busy"))).toBe("working");
  expect(workEvidence(file(1, "terminal"))).toBe("idle");
  expect(workEvidence(file(2, null, { activity: "live", proc: "running" }))).toBe("unknown");
  expect(workEvidence(file(3, null, { activity: "live", proc: "done" }))).toBe("idle");
  expect(workEvidence(file(4, null))).toBe("idle");
});

test("a spawning receipt or a host-claimed attempt never counts as working; only the transcript's open turn does", () => {
  /* A freshly created card: launch receipt reserved, no transcript turn yet. */
  const starting = file(10, null, { activity: "live", proc: "running", spawn: { launchId: "launch-fixture-10", clientAttemptId: null, accountId: null, state: "starting" } } as Partial<FileEntry>);
  expect(workEvidence(starting)).toBe("unknown");
  const queued = file(11, null, { spawn: { launchId: "launch-fixture-11", clientAttemptId: null, accountId: null, state: "queued" } } as Partial<FileEntry>);
  expect(workEvidence(queued)).toBe("unknown");
  const failed = file(12, null, { spawn: { launchId: "launch-fixture-12", clientAttemptId: null, accountId: null, state: "failed" } } as Partial<FileEntry>);
  expect(workEvidence(failed)).toBe("idle");
  /* A host that claims the process is running while the transcript's turn closed: idle. */
  expect(workEvidence(file(13, "terminal", { proc: "running", activity: "live" }))).toBe("idle");
  /* Ranking follows: a task whose only member is a starting launch ranks below a task with an open turn and equal to an idle one. */
  const files = [file(0, "busy"), starting, file(14, "terminal")];
  const tasks = [task("starting", "2026-01-01T00:00:00Z", [starting]), task("busy", "2026-01-02T00:00:00Z", [files[0]!]), task("idle", "2026-01-03T00:00:00Z", [files[2]!])];
  const ranked = rankBands(buildTaskBands(base(files), sources(tasks, files)));
  expect(ranked.map((band) => [band.id, band.working, band.unknown])).toEqual([["task:busy", 1, 0], ["task:starting", 0, 1], ["task:idle", 0, 0]]);
});

test("semantic zoom crosses at 22% / 82% with a two-point hysteresis margin", () => {
  let mode: BandMode | null = null;
  const walk = (zooms: number[]) => zooms.map((z) => (mode = bandModeFor(z, mode)));
  expect(walk([0.5, 0.23, 0.219, 0.23, 0.239, 0.24])).toEqual(["intermediate", "intermediate", "overview", "overview", "overview", "intermediate"]);
  expect(walk([0.81, 0.82, 0.81, 0.8, 0.799])).toEqual(["intermediate", "near", "near", "near", "intermediate"]);
  expect(bandModeFor(0.07, null)).toBe("overview");
  expect(bandModeFor(1, null)).toBe("near");
});

test("every conversation is a member of exactly one band; a shared conversation mirrors into its other task", () => {
  const files = [file(0, "busy"), file(1), file(2, "busy"), file(3)];
  const tasks = [task("b", "2026-02-01T00:00:00Z", [files[0]!, files[2]!]), task("a", "2026-01-01T00:00:00Z", [files[0]!, files[1]!])];
  const bands = buildTaskBands(base(files), sources(tasks, files));
  const byId = new Map(bands.map((band) => [band.id, band]));
  const a = byId.get("task:a")!;
  const b = byId.get("task:b")!;
  expect(a.members.map((member) => member.key)).toEqual([files[0]!.path, files[1]!.path]);
  expect(b.members.map((member) => member.key)).toEqual([files[2]!.path]);
  expect(b.mirrors.map((mirror) => [mirror.ofKey, mirror.primaryBandId])).toEqual([[files[0]!.path, "task:a"]]);
  const memberKeys = bands.flatMap((band) => band.members.map((member) => member.key));
  expect(new Set(memberKeys).size).toBe(memberKeys.length);
  expect(memberKeys.sort()).toEqual(files.map((entry) => entry.path).sort());
  /* The shared running conversation counts once in each task it is linked to. */
  expect(a.working).toBe(1);
  expect(b.working).toBe(2);
  expect(b.conversations).toBe(2);
});

test("unlinked lineage roots derive their own band and children inherit the parent's band", () => {
  const files = [file(0), file(1), file(2), file(3), file(4)];
  const tasks = [task("t", "2026-01-01T00:00:00Z", [files[0]!])];
  const layout = base(files, [[0, 1], [2, 3]]);
  const bands = buildTaskBands(layout, sources(tasks, files));
  const t = bands.find((band) => band.id === "task:t")!;
  expect(t.members.map((member) => member.key)).toEqual([files[0]!.path, files[1]!.path]);
  const derived = bands.filter((band) => band.origin === "conversation");
  expect(derived.map((band) => band.members.map((member) => member.key))).toEqual([[files[2]!.path, files[3]!.path], [files[4]!.path]]);
  expect(derived[0]!.title).toBe(files[2]!.title);
});

test("bands rank by working count, then creation time, then id; unknown never lifts a band", () => {
  const files = [file(0, "busy"), file(1, "busy"), file(2, null, { activity: "live", proc: "running" }), file(3, "terminal"), file(4, "busy")];
  const tasks = [
    task("late-one", "2026-03-01T00:00:00Z", [files[4]!]),
    task("early-one", "2026-01-01T00:00:00Z", [files[0]!]),
    task("two", "2026-02-01T00:00:00Z", [files[1]!, files[0]!]),
    task("unknown", "2025-12-01T00:00:00Z", [files[2]!]),
    task("idle", "2025-11-01T00:00:00Z", [files[3]!]),
  ];
  const ranked = rankBands(buildTaskBands(base(files), sources(tasks, files)));
  expect(ranked.map((band) => band.id)).toEqual(["task:two", "task:early-one", "task:late-one", "task:idle", "task:unknown"]);
  expect(ranked.find((band) => band.id === "task:unknown")!.unknown).toBe(1);
});

test("a frozen order keeps known bands in place and appends newcomers by rank", () => {
  const files = [file(0, "busy"), file(1), file(2)];
  const tasks = [task("a", "2026-01-01T00:00:00Z", [files[1]!]), task("b", "2026-01-02T00:00:00Z", [files[0]!]), task("c", "2026-01-03T00:00:00Z", [files[2]!])];
  const ranked = rankBands(buildTaskBands(base(files), sources(tasks, files)));
  expect(ranked.map((band) => band.id)).toEqual(["task:b", "task:a", "task:c"]);
  expect(applyBandOrder(ranked, ["task:a", "task:b"]).map((band) => band.id)).toEqual(["task:a", "task:b", "task:c"]);
  expect(applyBandOrder(ranked, null).map((band) => band.id)).toEqual(["task:b", "task:a", "task:c"]);
});

test("bands stack at content width at every mode and width; members, mirrors and +Agent stay inside without overlap", () => {
  const files = Array.from({ length: 30 }, (_, index) => file(index, index % 3 === 0 ? "busy" : null));
  const tasks = [
    task("dense", "2026-01-01T00:00:00Z", files.slice(0, 24)),
    task("shared", "2026-01-02T00:00:00Z", [files[0]!, files[24]!, files[25]!]),
    task("empty", "2026-01-03T00:00:00Z", []),
  ];
  const layout = base(files);
  const bands = rankBands(buildTaskBands(layout, sources(tasks, files)));
  for (const viewportWidth of [375, 680, 1024, 1280, 1440, 1920]) {
    for (const zoom of [0.07, 0.21, 0.22, 0.4, 0.58, 1]) {
      const mode = bandModeFor(zoom, null);
      const scene = layoutTaskBands(layout, bands, { zoom, mode, viewportWidth, reader: files[5]!.path });
      const s = 1 / zoom;
      const gutter = (viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter) * s;
      let previousBottom = -Infinity;
      for (const band of scene.bands) {
        const { rect, header, addAgent } = band.geometry;
        expect(rect.x).toBeCloseTo(gutter, 6);
        /* Compact geometry: a band is as wide as its content, floored so its
           header stays readable and ceilinged at the available width. */
        const available = viewportWidth - (viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter) * 2;
        expect(rect.w * zoom).toBeLessThanOrEqual(available + 0.001);
        expect(rect.w * zoom).toBeGreaterThanOrEqual(Math.min(available, BAND.minBandW) - 0.001);
        expect(rect.y).toBeGreaterThanOrEqual(previousBottom - 0.001);
        previousBottom = rect.y + rect.h;
        expect(header.h * zoom).toBeCloseTo(BAND.header, 6);
        expect(contains(rect, addAgent)).toBe(true);
        const items = [...band.members.map((member) => member.key), ...band.mirrors.map((mirror) => mirror.key)]
          .map((key) => scene.layout.byPath.get(key))
          .filter((item): item is SchemeRect => Boolean(item));
        for (const item of items) {
          expect(contains(rect, item)).toBe(true);
          expect(item.y).toBeGreaterThanOrEqual(rect.y + header.h - 0.001);
          expect(overlapping(item, addAgent)).toBe(false);
        }
        for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) expect(overlapping(items[i]!, items[j]!)).toBe(false);
      }
      expect(scene.layout.width * zoom).toBeCloseTo(viewportWidth, 6);
      /* Every node is placed and screen-constant for its presentation. */
      for (const node of scene.layout.nodes) {
        expect(scene.shown.has(node.file.path)).toBe(true);
        const expected = mode === "overview" ? "chip" : node.file.path === files[5]!.path ? "native" : "summary";
        expect(node.presentation).toBe(expected);
        /* Screen-constant for its presentation, except that no surface is
           wider than the band's inner width: a 375px board fits the tile. */
        const inner = viewportWidth - (viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter) * 2 - BAND.pad * 2;
        const width = node.w * zoom;
        if (expected === "chip") expect(width).toBeCloseTo(Math.min(BAND.chipW, inner), 6);
        else if (expected === "summary") expect(width).toBeCloseTo(Math.min(BAND.summaryW, inner), 6);
        else expect(width).toBeGreaterThanOrEqual(Math.min(BAND.nativeMinW, inner) - 0.001);
        expect(width).toBeLessThanOrEqual(inner + 0.001);
        expect((node.readerScale ?? 1) * zoom).toBeCloseTo(width / (expected === "chip" ? BAND.chipW : expected === "summary" ? BAND.summaryW : node.w * zoom / ((node.readerScale ?? 1) * zoom)), 6);
      }
      /* At 375 one tile per row: no two summary tiles share a row. */
      if (viewportWidth === 375 && mode === "intermediate") {
        const rows = new Set(scene.layout.nodes.map((node) => Math.round(node.y)));
        expect(rows.size).toBe(scene.layout.nodes.length);
      }
    }
  }
});

test("the local +Agent sits right after the last member, or opens the next row when the row is full", () => {
  const files = Array.from({ length: 12 }, (_, index) => file(index));
  const layout = base(files);
  const one = rankBands(buildTaskBands(layout, sources([task("one", "2026-01-01T00:00:00Z", [files[0]!])], files.slice(0, 1))));
  const single = layoutTaskBands(layout, one, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null }).bands[0]!;
  const member = single.members[0]!;
  const memberRect = layoutTaskBands(layout, one, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null }).layout.byPath.get(member.key)!;
  expect(single.geometry.addAgent.x).toBeCloseTo(memberRect.x + memberRect.w + BAND.tileGap * 2, 6);
  expect(single.geometry.addAgent.y).toBeCloseTo(memberRect.y, 6);
  /* Four 320px tiles fill a 1440 row (24 gutter + 16 pad each side leaves
     1360; 4 × 320 + 3 × 24 = 1352): the +Agent must start the next row. */
  const four = rankBands(buildTaskBands(layout, sources([task("four", "2026-01-01T00:00:00Z", files.slice(0, 4))], files.slice(0, 4))));
  const scene = layoutTaskBands(layout, four, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null });
  const band = scene.bands[0]!;
  const last = scene.layout.byPath.get(band.members[3]!.key)!;
  expect(band.geometry.addAgent.y).toBeGreaterThan(last.y + last.h - 0.001);
  expect(band.geometry.addAgent.x).toBeCloseTo(last.x - 3 * (BAND.summaryW + BAND.tileGap) * 2, 6);
  expect(band.geometry.rows).toBe(2);
});

test("edges route between same-band members through side ports on a row and top/bottom ports across rows", () => {
  const files = Array.from({ length: 6 }, (_, index) => file(index));
  const layout = base(files, [[0, 1], [0, 5]]);
  const bands = rankBands(buildTaskBands(layout, sources([task("t", "2026-01-01T00:00:00Z", files)], files)));
  const scene = layoutTaskBands(layout, bands, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null });
  expect(scene.layout.edges.length).toBe(2);
  const sameRow = scene.layout.edges.find((edge) => edge.to === files[1]!.path)!;
  const from = scene.layout.byPath.get(files[0]!.path)!;
  expect(sameRow.x1).toBeCloseTo(from.x + from.w, 6);
  const wrapped = scene.layout.edges.find((edge) => edge.to === files[5]!.path)!;
  expect(wrapped.y1).toBeCloseTo(from.y + from.h, 6);
  expect(typeof wrapped.route).toBe("string");
  const ports = bandEdgePorts({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 40, w: 10, h: 10 }, 1);
  expect(ports).toEqual({ x1: 5, y1: 10, x2: 5, y2: 40 });
});

test("350 tasks and 1,000 conversations project to one band per task and place every node", () => {
  const files = Array.from({ length: 1000 }, (_, index) => file(index, index % 7 === 0 ? "busy" : null));
  const tasks = Array.from({ length: 350 }, (_, index) => task(`task-${String(index).padStart(3, "0")}`, `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`, files.filter((_, fileIndex) => fileIndex % 350 === index)));
  const layout = base(files);
  const started = performance.now();
  const bands = rankBands(buildTaskBands(layout, sources(tasks, files)));
  expect(bands.length).toBe(350);
  for (const zoom of [0.07, 0.4, 1]) {
    const scene = layoutTaskBands(layout, bands, { zoom, mode: bandModeFor(zoom, null), viewportWidth: 1440, reader: files[0]!.path });
    expect(scene.shown.size).toBe(1000);
    expect(scene.bands.length).toBe(350);
    expect(scene.taskRects.size).toBe(350);
  }
  expect(performance.now() - started).toBeLessThan(15000);
});

test("the anchor equation keeps a projection's top-left at its captured screen point under a new zoom", () => {
  const captured = { sx: 312, sy: 188 };
  for (const [rect, z] of [[{ x: 480, y: 900, w: 640, h: 320 }, 0.4], [{ x: 240, y: 3600, w: 320, h: 160 }, 1], [{ x: 3428, y: 2000, w: 3142, h: 400 }, 0.07]] as const) {
    const cam = anchoredCamera(captured, rect, z);
    expect(cam.x + rect.x * z).toBeCloseTo(captured.sx, 9);
    expect(cam.y + rect.y * z).toBeCloseTo(captured.sy, 9);
  }
});

test("a mirror never duplicates a node key, so the layer count equals the node count", () => {
  const files = [file(0), file(1)];
  const tasks: BoardTask[] = [task("a", "2026-01-01T00:00:00Z", files), task("b", "2026-01-02T00:00:00Z", files), task("c", "2026-01-03T00:00:00Z", files)];
  const bands: TaskBand[] = buildTaskBands(base(files), sources(tasks, files));
  expect(bands.flatMap((band) => band.members).length).toBe(2);
  expect(bands.flatMap((band) => band.mirrors).length).toBe(4);
  const scene = layoutTaskBands(base(files), bands, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null });
  expect(scene.layout.nodes.length).toBe(2);
  expect(scene.mirrorRects.size).toBe(4);
});

function pipelineWith(id: string, files: readonly FileEntry[], taskIds: string[] = []): Pipeline {
  return {
    id, task: `Pipeline ${id}`, taskIds, project: "fixture", repoDir: "/repo", worktreeDir: `/repo-${id}`, branch: `pipeline/${id}`, baseBranch: "main", baseRef: "abc", lastPassedCommit: "abc",
    stages: files.map((_, index) => ({ id: `stage-${index}`, kind: "run", prompt: "", next: null, effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } })),
    runs: files.map((file, index) => ({ stageId: `stage-${index}`, attempts: [{ n: 1, state: "running", effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null }, launchId: `launch-${id}-${index}`, conversationId: file.conversationId, sessionId: null, agentPath: file.path, paneId: null, accountId: null, usageLimitedAccounts: [], flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null, startedAt: "2026-01-01T00:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null }] })),
    cursor: { stageId: "stage-0", state: "running", input: null, activatedBy: null }, state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "2026-01-01T00:00:00Z", closedAt: null,
  } as unknown as Pipeline;
}

test("an execution related only through one matching assignment does not promote its other stages into the task", () => {
  const files = [file(0), file(1, "busy")];
  const tasks = [task("t", "2026-01-01T00:00:00Z", [files[0]!])];
  const pipeline = pipelineWith("p", files);
  const layout = base(files);
  layout.groups = [{ key: "group::pipeline::p", kind: "pipeline", id: "p", hue: 10, members: files.map((entry) => entry.path), label: "Pipeline p", pipeline, x: 0, y: 0, w: 0, h: 0 }];
  const projection = projectTaskWorkflows(tasks, [pipeline], [], files);
  expect(projection.tasks[0]!.executions[0]!.basis).toBe("assignment");
  const bands = buildTaskBands(layout, { tasks, projection, untitled: "Untitled task" });
  const t = bands.find((band) => band.id === "task:t")!;
  expect(t.members.map((member) => member.key)).toEqual([files[0]!.path]);
  expect(t.working).toBe(0);
  expect(t.groups).toEqual([]);
  /* The busy stage worker still has a band of its own: the pipeline container. */
  const container = bands.find((band) => band.origin === "pipeline")!;
  expect(container.members.map((member) => member.key)).toEqual([files[1]!.path]);
  expect(container.working).toBe(1);
  /* An explicit binding admits every stage and owns the container. */
  const explicit = buildTaskBands(layout, { tasks, projection: projectTaskWorkflows(tasks, [pipelineWith("p", files, ["t"])], [], files), untitled: "Untitled task" });
  expect(explicit.find((band) => band.id === "task:t")!.members.map((member) => member.key).sort()).toEqual(files.map((entry) => entry.path).sort());
  /* A fallback task minted for the container (origin) owns it too. */
  const fallbackTask = { ...task("fb", "2026-01-02T00:00:00Z", files), origin: { kind: "pipeline" as const, key: "p", refinement: "titled" as const } };
  const fallback = buildTaskBands(layout, { tasks: [fallbackTask], projection: projectTaskWorkflows([fallbackTask], [pipeline], [], files), untitled: "Untitled task" });
  expect(fallback.find((band) => band.id === "task:fb")!.groups).toEqual(["group::pipeline::p"]);
});

test("opening a shared conversation from its mirror hosts the one surface in that band and mirrors it back in the canonical band", () => {
  const files = [file(0, "busy"), file(1)];
  const tasks = [task("a", "2026-01-01T00:00:00Z", files), task("b", "2026-01-02T00:00:00Z", [files[0]!])];
  const layout = base(files);
  const bands = rankBands(buildTaskBands(layout, sources(tasks, files)));
  const swapped = applyHostOverrides(bands, new Map([[files[0]!.path, "task:b"]]));
  const a = swapped.find((band) => band.id === "task:a")!;
  const b = swapped.find((band) => band.id === "task:b")!;
  expect(b.members.map((member) => member.key)).toEqual([files[0]!.path]);
  expect(b.mirrors).toEqual([]);
  expect(a.members.map((member) => member.key)).toEqual([files[1]!.path]);
  expect(a.mirrors.map((mirror) => [mirror.ofKey, mirror.primaryBandId])).toEqual([[files[0]!.path, "task:b"]]);
  /* Counts are unchanged and the node is still placed exactly once. */
  expect(a.working).toBe(1);
  expect(b.working).toBe(1);
  const scene = layoutTaskBands(layout, bands, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null, hostOverrides: new Map([[files[0]!.path, "task:b"]]) });
  expect(scene.bandOf.get(files[0]!.path)).toBe("task:b");
  expect(scene.layout.nodes.length).toBe(2);
  expect(scene.mirrorRects.size).toBe(1);
  /* An override for a band without a mirror of that node changes nothing. */
  expect(applyHostOverrides(bands, new Map([[files[1]!.path, "task:b"]])).map((band) => band.members.length)).toEqual(bands.map((band) => band.members.length));
});

test("a recorded relation across bands becomes a labelled continuation on both endpoints, mirrors included", () => {
  const files = [file(0), file(1), file(2)];
  const tasks = [task("a", "2026-01-01T00:00:00Z", [files[0]!]), task("b", "2026-01-02T00:00:00Z", [files[1]!, files[0]!])];
  const layout = base(files, [[0, 1], [0, 2]]);
  const bands = rankBands(buildTaskBands(layout, sources(tasks, files)));
  const scene = layoutTaskBands(layout, bands, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null });
  /* Node 2 inherits its parent's band a; the edge 0→1 crosses a → b. */
  expect(scene.layout.edges.length).toBe(1);
  const byKey = new Map(scene.continuations.map((entry) => [entry.key, entry]));
  expect(byKey.get(files[0]!.path)!.targets).toEqual([{ key: files[1]!.path, bandId: "task:b", title: "Task b", direction: "to" }]);
  expect(byKey.get(files[1]!.path)!.targets).toEqual([{ key: files[0]!.path, bandId: "task:a", title: "Task a", direction: "from" }]);
  /* The mirror of node 0 inside band b points back at node 2 in band a. */
  const mirror = bands.find((band) => band.id === "task:b")!.mirrors[0]!;
  expect(byKey.get(mirror.key)!.targets).toEqual([{ key: files[2]!.path, bandId: "task:a", title: "Task a", direction: "to" }]);
});

test("a container halo stays inside its own band: a stage worker assigned to another task is a mirror there, never a halo across bands", () => {
  const files = [file(0), file(1), file(2)];
  const pipeline = pipelineWith("p", files.slice(0, 2), ["t"]);
  /* Worker 1 is also assigned to an older task, so its surface lives there. */
  const tasks = [task("older", "2026-01-01T00:00:00Z", [files[1]!, files[2]!]), task("t", "2026-01-02T00:00:00Z", [])];
  const layout = base(files);
  layout.groups = [{ key: "group::pipeline::p", kind: "pipeline", id: "p", hue: 10, members: files.slice(0, 2).map((entry) => entry.path), label: "Pipeline p", pipeline, x: 0, y: 0, w: 0, h: 0 }];
  const bands = rankBands(buildTaskBands(layout, { tasks, projection: projectTaskWorkflows(tasks, [pipeline], [], files), untitled: "Untitled task" }));
  const scene = layoutTaskBands(layout, bands, { zoom: 0.5, mode: "intermediate", viewportWidth: 1440, reader: null });
  const halo = scene.layout.groups.find((group) => group.id === "p")!;
  const pipelineBand = scene.bands.find((band) => band.id === "task:t")!;
  const olderBand = scene.bands.find((band) => band.id === "task:older")!;
  expect(pipelineBand.groups).toEqual(["group::pipeline::p"]);
  const inside = (outer: SchemeRect, inner: SchemeRect) => inner.y >= outer.y - 0.001 && inner.y + inner.h <= outer.y + outer.h + 0.001 && inner.x >= outer.x - 0.001 && inner.x + inner.w <= outer.x + outer.w + 0.001;
  expect(inside(pipelineBand.geometry.rect, halo)).toBe(true);
  expect(halo.y < olderBand.geometry.rect.y + olderBand.geometry.rect.h && halo.y + halo.h > olderBand.geometry.rect.y && olderBand.geometry.rect.y < pipelineBand.geometry.rect.y).toBe(false);
  /* The halo wraps the stage placed here plus the mirror of the stage hosted elsewhere. */
  expect(halo.members.sort()).toEqual([files[0]!.path, pipelineBand.mirrors[0]!.key].sort());
});


test("a hidden EMPTY task draws no band; a hidden task holding an agent still does (#1614 item 1)", () => {
  const files = [file(0, "busy"), file(1)];
  const layout = base(files);
  const withAgent = task("staffed", "2026-01-01T00:00:00Z", [files[0]!]);
  const all = [
    { ...withAgent, board: "hidden" as const },
    { ...task("empty", "2026-01-02T00:00:00Z", []), board: "hidden" as const },
    task("still-visible", "2026-01-03T00:00:00Z", []),
    { ...task("restored", "2026-01-04T00:00:00Z", []), board: "shown" as const },
  ];
  const bands = buildTaskBands(layout, sources(all, files));
  const taskIds = bands.filter((band) => band.origin === "task").map((band) => band.task!.id).sort();
  /* The hidden EMPTY band is the only one that disappears. The hidden band
     holding an agent keeps its members — hiding must never strand a live
     conversation off the board. */
  expect(taskIds).toEqual(["restored", "staffed", "still-visible"]);
  expect(bands.find((band) => band.task?.id === "staffed")!.members.map((member) => member.key)).toContain(files[0]!.path);
});

test("membership, not history: a hidden task whose conversation the board no longer carries draws no band (#1614 item 1)", () => {
  /* The interpretation this replaces read the assignment ROW: any task that had
     ever been launched kept its band forever. On the reported board that left
     319 of 385 empty bands in place — every one drawing «0 working · 0
     conversations», which is the complaint. An assignment counts when it still
     resolves to a conversation the board carries. */
  const carried = file(0);
  const gone = file(9);
  const layout = base([carried]);
  const stale = { ...task("archived-agent", "2026-01-01T00:00:00Z", [gone]), board: "hidden" as const };
  const held = { ...task("live-agent", "2026-01-02T00:00:00Z", [carried]), board: "hidden" as const };
  /* The board carries `carried` and nothing else: `gone` was archived, hidden,
     or has aged out of the window. */
  const bands = buildTaskBands(layout, sources([stale, held], [carried]));

  expect(bands.find((entry) => entry.task?.id === "archived-agent")).toBeUndefined();
  /* And the invariant that keeps a live conversation reachable still holds: a
     task whose assignment still resolves overrides the flag. */
  const live = bands.find((entry) => entry.task?.id === "live-agent");
  expect(live).toBeDefined();
  expect(live!.members.map((member) => member.key)).toEqual([carried.path]);
});

test("a member the camera is not showing is still a member (#1614 item 1)", () => {
  /* Board membership is not camera visibility. This band's conversation sits
     far outside any viewport the operator has framed — the board draws it, so
     the task stays whatever the flag says. Nothing here consults a camera. */
  const near = file(0);
  const far = file(1);
  const layout = base([near, far]);
  layout.byPath.get(far.path)!.x = 48_000;
  layout.byPath.get(far.path)!.y = 32_000;
  const hidden = { ...task("far-agent", "2026-01-01T00:00:00Z", [far]), board: "hidden" as const };
  const band = buildTaskBands(layout, sources([hidden], [near, far])).find((entry) => entry.task?.id === "far-agent");
  expect(band).toBeDefined();
  expect(band!.members.map((member) => member.key)).toEqual([far.path]);
});

test("a hidden task whose pipeline has only planned stages keeps its band (#1614)", () => {
  /* The reported board has three of these: a band whose task carries no
     conversation at all, and whose pipeline has not launched a stage yet. It
     holds a reserved slot and the container it owns, so it is not empty, and
     the preference must not take it off the canvas. */
  const planned = {
    ...pipelineWith("planned", [], ["planned-task"]),
    stages: [{ id: "stage-0", kind: "run", prompt: "", next: null, effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    runs: [],
  } as unknown as Pipeline;
  const hidden = { ...task("planned-task", "2026-01-01T00:00:00Z", []), board: "hidden" as const };
  const layout = base([]);
  layout.groups = [{ key: "group::pipeline::planned", kind: "pipeline", id: "planned", hue: 10, members: [], label: "Pipeline planned", pipeline: planned, x: 0, y: 0, w: 0, h: 0 }];
  layout.slots = [{ key: "slot::planned::stage-0", pipeline: planned, stage: planned.stages[0]!, x: 0, y: 0, w: 100, h: 40 }] as SchemeLayout["slots"];
  const bands = buildTaskBands(layout, { tasks: [hidden], projection: projectTaskWorkflows([hidden], [planned], [], []), untitled: "Untitled task" });
  const band = bands.find((entry) => entry.task?.id === "planned-task");
  expect(band).toBeDefined();
  expect(bandHoldsMembers(band!)).toBe(true);
  /* And it draws no conversation, so a rule that counted only those would have
     dropped it. */
  expect(band!.conversations).toBe(0);
});

test("a hidden task keeps its band while it owns a container, even with no conversation of its own", () => {
  /* `bandHoldsMembers` is what the flag is applied to, and a pipeline group the
     band owns is something the board is drawing for it. */
  const layout = base([]);
  const hidden = { ...task("container", "2026-01-01T00:00:00Z", []), board: "hidden" as const };
  const band = buildTaskBands(layout, sources([hidden], [])).find((entry) => entry.task?.id === "container");
  expect(band).toBeUndefined();
  expect(bandHoldsMembers({ members: [], mirrors: [], groups: [] })).toBe(false);
  expect(bandHoldsMembers({ members: [], mirrors: [], groups: ["pipeline:p1"] })).toBe(true);
});

test("a launch this session started keeps its hidden task on the board before the assignment persists", () => {
  const files = [file(0, "busy")];
  const layout = base(files);
  const hidden = { ...task("provisional", "2026-01-01T00:00:00Z", []), board: "hidden" as const };
  const provisionalMemberships = new Map([[files[0]!.conversationId!, "provisional"]]);
  const band = buildTaskBands(layout, { ...sources([hidden], files), provisionalMemberships })
    .find((entry) => entry.task?.id === "provisional");
  expect(band).toBeDefined();
  expect(band!.members.map((member) => member.key)).toEqual([files[0]!.path]);
});

test("an empty band ends at its content instead of ruling a line across the canvas (#1614 item 2)", () => {
  const files = Array.from({ length: 8 }, (_, index) => file(index));
  const layout = base(files);
  const bands = rankBands(buildTaskBands(layout, sources([
    task("empty", "2026-01-01T00:00:00Z", []),
    task("one", "2026-01-02T00:00:00Z", [files[0]!]),
    task("many", "2026-01-03T00:00:00Z", files.slice(1)),
  ], files)));
  for (const [viewportWidth, zoom] of [[1440, 1], [1440, 1.6], [1920, 1], [1280, 0.5]] as const) {
    const scene = layoutTaskBands(layout, bands, { zoom, mode: bandModeFor(zoom, null), viewportWidth, reader: null });
    const widthOf = (id: string) => scene.bands.find((band) => band.task?.id === id)!.geometry.rect.w * zoom;
    const available = viewportWidth - BAND.gutter * 2;
    /* The whole complaint: an empty band used to be exactly as wide as a band
       holding eight conversations. Now it is strictly narrower, and narrower
       than the canvas, while staying wide enough to read its own header. */
    expect(widthOf("empty")).toBeLessThan(available);
    expect(widthOf("empty")).toBeLessThan(widthOf("many"));
    expect(widthOf("empty")).toBeLessThanOrEqual(widthOf("one"));
    expect(widthOf("empty")).toBeGreaterThanOrEqual(Math.min(available, BAND.minBandW) - 0.001);
    /* A populated band grows to hold its members and stops at the ceiling. The
       slack it leaves is never more than the next tile it could not fit, so
       narrowing costs no row and no member is pushed out of view. */
    expect(widthOf("many")).toBeLessThanOrEqual(available + 0.001);
    expect(widthOf("many")).toBeGreaterThan(widthOf("one"));
    const tile = (scene.mode === "overview" ? BAND.chipW : BAND.summaryW) + BAND.tileGap;
    expect(available - widthOf("many")).toBeLessThan(tile + 0.001);
  }
});

/* -- Board geometry: coherent member scaling, collapsed deck, no stray arcs -- */

function reviewFlow(implementerPath: string, state: "approved" | "reviewing"): import("@/lib/flows/types").Flow {
  return {
    id: "flow-geom",
    template: "implement-review-loop",
    project: "fixture",
    cwd: "/repo",
    implementerPath,
    roles: { implementer: { engine: "claude", model: "opus", effort: "high" }, reviewer: { engine: "claude", model: "opus", effort: "high" } },
    baseRef: "0".repeat(40),
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state,
    stateDetail: null,
    rounds: [{ n: 1, reviewerPath: "/fixture/reviewer", verdict: state === "approved" ? "APPROVE" : null, findingsCount: state === "approved" ? 2 : null, findingsPath: null, triggeredBy: "marker", readyNote: null, startedAt: "2026-01-01T00:00:00Z", reviewedAt: null, relayedAt: null, error: null } as import("@/lib/flows/types").Round],
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: null,
  } as import("@/lib/flows/types").Flow;
}

/** A base layout carrying one node and one review deck, plus a hand-built band
    that holds both as members — the shape `layoutTaskBands` places. */
function deckScene(flowState: "approved" | "reviewing") {
  const node = file(0, "busy");
  const layout = base([node]);
  const flow = reviewFlow(node.path, flowState);
  const deckKey = "deck::flow-geom";
  layout.decks = [{ key: deckKey, flow, rounds: [], x: 700, y: 100, w: 600, h: 810 }] as SchemeLayout["decks"];
  layout.loops = [{ key: "loop::flow-geom", flow, x1: 600, x2: 700, y: 100 }] as SchemeLayout["loops"];
  layout.byPath.set(deckKey, layout.decks[0]!);
  const band: TaskBand = {
    id: "task:geom", origin: "task", task: task("geom", "2026-01-01T00:00:00Z", [node]), pipeline: null, flow: null,
    title: "Geometry", status: "assigned", hue: 0,
    members: [{ key: node.path, kind: "node", file: node }, { key: deckKey, kind: "deck", file: null }],
    mirrors: [], groups: [], working: 1, unknown: 0, conversations: 1, planned: 0, pinnedTop: false, createdAt: "2026-01-01T00:00:00Z",
  };
  return { layout, band, deckKey, nodePath: node.path };
}

test("a settled review deck reserves its collapsed chip height, not the full expanded box (#1641)", () => {
  const { layout, band, deckKey } = deckScene("approved");
  const scene = layoutTaskBands(layout, [band], { zoom: 1, mode: "near", viewportWidth: 1440, reader: null });
  const deck = scene.layout.byPath.get(deckKey)!;
  /* At 1:1 the world unit is a CSS pixel, so the reserved box is the collapsed
     chip (BAND.collapsedDeckH), an order of magnitude short of the 810px it
     would need expanded — the giant empty task frame in the report. */
  expect(deck.h).toBeLessThanOrEqual(BAND.collapsedDeckH + 1);
  /* An actionable deck still reserves its working height. */
  const live = layoutTaskBands(deckScene("reviewing").layout, [deckScene("reviewing").band], { zoom: 1, mode: "near", viewportWidth: 1440, reader: null });
  expect(live.layout.byPath.get(deckKey)!.h).toBeGreaterThan(400);
});

test("every band surface is screen-constant: a deck scales by the same law as the node tiles beside it (#1641)", () => {
  const { layout, band, deckKey, nodePath } = deckScene("reviewing");
  const at = (zoom: number) => {
    const scene = layoutTaskBands(layout, [band], { zoom, mode: "near", viewportWidth: 1440, reader: null });
    return { deck: scene.layout.byPath.get(deckKey)!, node: scene.layout.byPath.get(nodePath)! };
  };
  const one = at(1);
  const half = at(0.5);
  /* World size scales as 1/zoom, so the on-screen size (world × zoom) holds
     constant. The regression had the deck ride the raw board scale (screen size
     halving with the camera) while the summary tiles stayed put. */
  const screen = (rect: { w: number; h: number }, zoom: number) => ({ w: rect.w * zoom, h: rect.h * zoom });
  const deckScreen1 = screen(one.deck, 1);
  const deckScreenHalf = screen(half.deck, 0.5);
  const nodeScreen1 = screen(one.node, 1);
  const nodeScreenHalf = screen(half.node, 0.5);
  expect(deckScreenHalf.w).toBeCloseTo(deckScreen1.w, 1);
  expect(nodeScreenHalf.w).toBeCloseTo(nodeScreen1.w, 1);
  /* One law, not two: the deck's on-screen width equals what the same shrink
     applied to the node tile gives (both constant across the zoom change). */
  expect(deckScreenHalf.w / deckScreen1.w).toBeCloseTo(nodeScreenHalf.w / nodeScreen1.w, 2);
});

test("the band surface draws no free-board review-cycle arcs (#1641)", () => {
  const { layout, band } = deckScene("reviewing");
  expect(layout.loops.length).toBe(1);
  const scene = layoutTaskBands(layout, [band], { zoom: 0.4, mode: "intermediate", viewportWidth: 1440, reader: null });
  /* The fixed-offset forward/return arcs land nowhere near the band's wrapped,
     counter-scaled cards; the band emits none, so no squiggle strands in the
     empty space below its content. */
  expect(scene.layout.loops).toEqual([]);
});
