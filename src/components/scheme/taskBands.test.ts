import { historicalAttemptLabels } from "./boardPresentation";
import { expect, test } from "bun:test";

import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { COLLAPSED_DECK_CHIP_H } from "@/components/flows/reviewDeckDisclosure";
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
import { FLOW_HUB } from "@/components/flows/flowHubGeometry";
import { sampleRoute } from "./taskGeometry";
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
      const scene = layoutTaskBands(layout, bands, { mode, viewportWidth, reader: files[5]!.path });
      /* Stable world geometry (#1641): a band member is one rectangle in board
         pixels and the camera's own scale grows or shrinks it, so nothing here
         divides by the zoom. The geometry depends on the zoom only through the
         presentation mode, so two zooms in one mode place identical rectangles;
         physical card scaling is verified separately. */
      const gutter = viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter;
      const available = viewportWidth - gutter * 2;
      let previousBottom = -Infinity;
      for (const band of scene.bands) {
        const { rect, header } = band.geometry;
        expect(rect.x).toBeCloseTo(gutter, 6);
        /* Compact geometry: a band is as wide as its content, floored so its
           header stays readable and ceilinged at the available width. */
        expect(rect.w).toBeLessThanOrEqual(available + 0.001);
        expect(rect.w).toBeGreaterThanOrEqual(Math.min(available, BAND.minBandW) - 0.001);
        expect(rect.y).toBeGreaterThanOrEqual(previousBottom - 0.001);
        previousBottom = rect.y + rect.h;
        expect(header.h).toBeCloseTo(BAND.header + (available < 600 ? 40 : 0), 6);
        const items = [...band.members.map((member) => member.key), ...band.mirrors.map((mirror) => mirror.key)]
          .map((key) => scene.layout.byPath.get(key))
          .filter((item): item is SchemeRect => Boolean(item));
        for (const item of items) {
          expect(contains(rect, item)).toBe(true);
          expect(item.y).toBeGreaterThanOrEqual(rect.y + header.h - 0.001);
        }
        for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) expect(overlapping(items[i]!, items[j]!)).toBe(false);
      }
      /* The band world is exactly the available viewport at 1:1; the camera
         scales it from there. */
      expect(scene.layout.width).toBeCloseTo(viewportWidth, 6);
      for (const node of scene.layout.nodes) {
        expect(scene.shown.has(node.file.path)).toBe(true);
        const expected = mode === "overview" ? "chip" : node.file.path === files[5]!.path ? "native" : "summary";
        expect(node.presentation).toBe(expected);
        /* Board-pixel footprint for its presentation, capped only so no surface
           is wider than the band's inner width (a 375px board fits the tile). */
        const inner = viewportWidth - gutter * 2 - BAND.pad * 2;
        const width = node.w;
        if (expected === "chip") expect(width).toBeCloseTo(Math.min(BAND.chipW, inner), 6);
        else if (expected === "summary") expect(width).toBeCloseTo(Math.min(BAND.summaryW, inner), 6);
        else expect(width).toBeGreaterThanOrEqual(Math.min(BAND.nativeMinW, inner) - 0.001);
        expect(width).toBeLessThanOrEqual(inner + 0.001);
        /* The shell scales its content back to the tile's own footprint. */
        if (expected !== "native") expect(width).toBeCloseTo((expected === "chip" ? BAND.chipW : BAND.summaryW) * (node.readerScale ?? 1), 6);
      }
      /* At 375 one tile per row: no two summary tiles share a row. */
      if (viewportWidth === 375 && mode === "intermediate") {
        const rows = new Set(scene.layout.nodes.map((node) => Math.round(node.y)));
        expect(rows.size).toBe(scene.layout.nodes.length);
      }
    }
  }
});

test("header actions reserve no empty card row, even when the member row fills", () => {
  const files = Array.from({ length: 4 }, (_, index) => file(index));
  const layout = base(files);
  for (const count of [0, 1, 4]) {
    const bands = buildTaskBands(base(files.slice(0, count)), sources([task("one", "2026-01-01T00:00:00Z", files.slice(0, count))], files.slice(0, count)));
    const scene = layoutTaskBands(layout, bands, { mode: "near", viewportWidth: 1440, reader: null });
    const band = scene.bands[0]!;
    const bottom = Math.max(band.geometry.header.y + band.geometry.header.h, ...band.members.map(member => { const rect = scene.layout.byPath.get(member.key)!; return rect.y + rect.h; }));
    expect(band.geometry.rect.y + band.geometry.rect.h - bottom).toBeLessThanOrEqual(44);
    if (!count) expect(band.geometry.rect.h).toBe(band.geometry.header.h);
  }
});

test("edges route between same-band members through side ports on a row and top/bottom ports across rows", () => {
  const files = Array.from({ length: 6 }, (_, index) => file(index));
  const layout = base(files, [[0, 1], [0, 5]]);
  const bands = rankBands(buildTaskBands(layout, sources([task("t", "2026-01-01T00:00:00Z", files)], files)));
  const scene = layoutTaskBands(layout, bands, { mode: "intermediate", viewportWidth: 1440, reader: null });
  expect(scene.layout.edges.length).toBe(2);
  const sameRow = scene.layout.edges.find((edge) => edge.to === files[1]!.path)!;
  const from = scene.layout.byPath.get(files[0]!.path)!;
  expect(sameRow.x1).toBeCloseTo(from.x + from.w, 6);
  const wrapped = scene.layout.edges.find((edge) => edge.to === files[5]!.path)!;
  expect(wrapped.y1).toBeCloseTo(from.y + from.h, 6);
  expect(typeof wrapped.route).toBe("string");
  const ports = bandEdgePorts({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 40, w: 10, h: 10 });
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
    const scene = layoutTaskBands(layout, bands, { mode: bandModeFor(zoom, null), viewportWidth: 1440, reader: files[0]!.path });
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
  const scene = layoutTaskBands(base(files), bands, { mode: "intermediate", viewportWidth: 1440, reader: null });
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
  const scene = layoutTaskBands(layout, bands, { mode: "intermediate", viewportWidth: 1440, reader: null, hostOverrides: new Map([[files[0]!.path, "task:b"]]) });
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
  const scene = layoutTaskBands(layout, bands, { mode: "intermediate", viewportWidth: 1440, reader: null });
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
  const scene = layoutTaskBands(layout, bands, { mode: "intermediate", viewportWidth: 1440, reader: null });
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
    const scene = layoutTaskBands(layout, bands, { mode: bandModeFor(zoom, null), viewportWidth, reader: null });
    const widthOf = (id: string) => scene.bands.find((band) => band.task?.id === id)!.geometry.rect.w;
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

test("a review deck reserves its collapsed chip height by the operator's actual disclosure state (#1641)", () => {
  const { layout, band, deckKey } = deckScene("reviewing");
  const at = (collapsedDecks?: ReadonlySet<string>) =>
    layoutTaskBands(layout, [band], { mode: "near", viewportWidth: 1440, reader: null, collapsedDecks }).layout.byPath.get(deckKey)!;
  /* Told the deck is collapsed, the band reserves the chip height — an order of
     magnitude short of the 810px it needs expanded, the empty task frame in the
     report. Told it is expanded (a manual expand of a settled deck), it reserves
     the full footprint. The set is authoritative over flow terminality. */
  expect(at(new Set([deckKey])).h).toBe(COLLAPSED_DECK_CHIP_H);
  expect(at(new Set()).h).toBeGreaterThan(400);
  /* Without a set, an actionable flow's lifecycle default is expanded. */
  expect(at(undefined).h).toBeGreaterThan(400);
  /* And a settled flow's lifecycle default is collapsed. */
  const settled = deckScene("approved");
  expect(layoutTaskBands(settled.layout, [settled.band], { mode: "near", viewportWidth: 1440, reader: null }).layout.byPath.get(deckKey)!.h).toBe(COLLAPSED_DECK_CHIP_H);
});

test("band geometry is board pixels the camera scales as one: the zoom is not a layout input (#1641)", () => {
  const { layout, band, deckKey, nodePath } = deckScene("reviewing");
  const at = (mode: "intermediate" | "near") => {
    const scene = layoutTaskBands(layout, [band], { mode, viewportWidth: 1440, reader: null });
    return { deck: scene.layout.byPath.get(deckKey)!, node: scene.layout.byPath.get(nodePath)!, header: scene.bands[0]!.geometry.header };
  };
  /* The two tile-scale modes place identical rectangles: the layout knows no
     zoom, so the camera's own `scale(zoom)` is the only thing that changes a
     card's on-screen size — and it changes the deck, the band frame and the
     connectors by the same factor. (The browser harness measures that factor;
     what a pure test can pin is that nothing here is counter-scaled.) */
  const near = at("near");
  const intermediate = at("intermediate");
  expect(near.node).toEqual(intermediate.node);
  expect(near.deck).toEqual(intermediate.deck);
  expect(near.header.h).toBe(BAND.header);
  expect(near.node.w).toBe(BAND.summaryW);
});

test("the band routes the review connector between the placed implementer and deck, across wrapped rows (#1641)", () => {
  const wide = deckScene("reviewing");
  const scene = layoutTaskBands(wide.layout, [wide.band], { mode: "near", viewportWidth: 1440, reader: null });
  expect(scene.layout.loops.length).toBe(1);
  const loop = scene.layout.loops[0]!;
  const impl = scene.layout.byPath.get(wide.nodePath)!;
  const deck = scene.layout.byPath.get(wide.deckKey)!;
  /* The connector is drawn between the cards AS PLACED, not at fixed offsets:
     both endpoints touch the actual implementer and deck rectangles, and it
     carries a routed path — never a stranded squiggle. */
  expect(loop.route).toBeTruthy();
  expect(loop.y1).toBeDefined();
  const onImpl = loop.x1! >= impl.x - 1 && loop.x1! <= impl.x + impl.w + 1 && loop.y1! >= impl.y - 1 && loop.y1! <= impl.y + impl.h + 1;
  const onDeck = loop.x2! >= deck.x - 1 && loop.x2! <= deck.x + deck.w + 1 && loop.y2! >= deck.y - 1 && loop.y2! <= deck.y + deck.h + 1;
  expect(onImpl).toBe(true);
  expect(onDeck).toBe(true);
  /* On a narrow board the deck wraps below the implementer; the connector
     still attaches to both — top/bottom ports instead of side ports. */
  const narrow = layoutTaskBands(wide.layout, [wide.band], { mode: "near", viewportWidth: 700, reader: null });
  const nLoop = narrow.layout.loops[0]!;
  const nImpl = narrow.layout.byPath.get(wide.nodePath)!;
  const nDeck = narrow.layout.byPath.get(wide.deckKey)!;
  expect(Math.round(nImpl.y)).not.toBe(Math.round(nDeck.y));
  expect(nLoop.route).toBeTruthy();
  expect(nLoop.y1! >= nImpl.y - 1 && nLoop.y1! <= nImpl.y + nImpl.h + 1).toBe(true);
  expect(nLoop.y2! >= nDeck.y - 1 && nLoop.y2! <= nDeck.y + nDeck.h + 1).toBe(true);
});

test("the review hub sits on the routed connector, clear of every card but its two endpoints (#1641)", () => {
  /* Implementer, two helpers and the deck: on a 900px board the third card
     wraps under the implementer and the deck wraps below that, so the
     connector must thread past the wrapped helper — and the hub must not land
     on it, which is where the corridor formula put it (inside the helper). */
  const files = [file(0, "busy"), file(1), file(2)];
  const layout = base(files);
  const flow = reviewFlow(files[0]!.path, "reviewing");
  const deckKey = "deck::flow-geom";
  layout.decks = [{ key: deckKey, flow, rounds: [], x: 700, y: 100, w: 600, h: 810 }] as SchemeLayout["decks"];
  layout.loops = [{ key: "loop::flow-geom", flow, x1: 600, x2: 700, y: 100 }] as SchemeLayout["loops"];
  layout.byPath.set(deckKey, layout.decks[0]!);
  const band: TaskBand = {
    id: "task:geom", origin: "task", task: task("geom", "2026-01-01T00:00:00Z", files), pipeline: null, flow: null,
    title: "Geometry", status: "assigned", hue: 0,
    members: [...files.map((entry) => ({ key: entry.path, kind: "node" as const, file: entry })), { key: deckKey, kind: "deck", file: null }],
    mirrors: [], groups: [], working: 1, unknown: 0, conversations: 3, planned: 0, pinnedTop: false, createdAt: "2026-01-01T00:00:00Z",
  };
  for (const viewportWidth of [1440, 900]) {
    const scene = layoutTaskBands(layout, [band], { mode: "near", viewportWidth, reader: null });
    const loop = scene.layout.loops[0]!;
    expect(loop.hub).toBeDefined();
    const hub = loop.hub!;
    /* On the path: within a sample step of the drawn connector. */
    const samples = sampleRoute(loop.route!);
    const gap = Math.min(...samples.map((point) => Math.hypot(point.x - hub.x, point.y - hub.y)));
    expect(gap).toBeLessThanOrEqual(1e-6);
    /* And its box overlaps no card that is not an endpoint of the loop. */
    for (const helper of files.slice(1)) {
      const rect = scene.layout.byPath.get(helper.path)!;
      const overlaps = hub.x + FLOW_HUB.w / 2 > rect.x && hub.x - FLOW_HUB.w / 2 < rect.x + rect.w && hub.y + FLOW_HUB.h / 2 > rect.y && hub.y - FLOW_HUB.h / 2 < rect.y + rect.h;
      expect(overlaps).toBe(false);
    }

  }
});


test("completed-task history folds without discarding targets or rewriting states", () => {
  const files = [file(0, "idle")];
  const layout = base(files);
  const done = task("done", "2026-01-01T00:00:00Z", files, "done");
  const bands = buildTaskBands(layout, sources([done], files));
  const options = { mode: "near" as const, viewportWidth: 1440, reader: null };
  const folded = layoutTaskBands(layout, bands, options);
  expect(folded.bands[0]!.geometry.historyCollapsed).toBe(true);
  expect(folded.shown.has(files[0]!.path)).toBe(false);
  expect(folded.layout.nodes[0]!.file).toBe(files[0]!);
  const opened = layoutTaskBands(layout, bands, { ...options, reader: files[0]!.path });
  expect(opened.bands[0]!.geometry.historyCollapsed).toBe(false);
  expect(opened.layout.byPath.get(files[0]!.path)?.h).toBe(BAND.nativeH);
  const deliberate = layoutTaskBands(layout, bands, { ...options, historyOverrides: new Map([[bands[0]!.id, true]]) });
  expect(deliberate.shown.has(files[0]!.path)).toBe(true);
  expect(done.status).toBe("done");
  for (const turn of ["busy", "unknown"] as const) {
    const activeFiles = [file(1, turn)];
    const activeBase = base(activeFiles);
    const activeBands = buildTaskBands(activeBase, sources([task("active", "2026-01-01T00:00:00Z", activeFiles, "done")], activeFiles));
    const active = layoutTaskBands(activeBase, activeBands, { ...options, historyOverrides: new Map([["task:active", false]]) });
    expect(active.bands[0]!.geometry.historyCollapsed).toBe(false);
    expect(active.shown.has(activeFiles[0]!.path)).toBe(true);
  }
});

/** A completed task whose idle implementer ran a review loop: its flow group
    and deck, the task finished on `finishedAt`. */
function reviewedTaskScene(flow: import("@/lib/flows/types").Flow, finishedAt: string) {
  const files = [file(0, "idle")];
  const layout = base(files);
  const deckKey = `deck::${flow.id}`;
  layout.decks = [{ key: deckKey, flow, rounds: [], x: 700, y: 100, w: 600, h: 810 }] as SchemeLayout["decks"];
  layout.groups = [{ key: `group::flow::${flow.id}`, kind: "flow", id: flow.id, flow, hue: 0, label: "Review", members: [files[0]!.path, deckKey], x: 0, y: 0, w: 1300, h: 900 }];
  layout.byPath.set(deckKey, layout.decks[0]!);
  const done = { ...task("done", "2026-01-01T00:00:00Z", files, "done"), updatedAt: finishedAt };
  const bands = buildTaskBands(layout, { tasks: [done], projection: projectTaskWorkflows([done], [], [flow], files), untitled: "Untitled task" });
  return { layout, bands, deckKey, options: { mode: "near" as const, viewportWidth: 1440, reader: null } };
}

test("an expanded deck keeps a completed task's automatic history open; the band's own control still decides", () => {
  const flow = reviewFlow(file(0).path, "approved");
  const { layout, bands, deckKey, options } = reviewedTaskScene(flow, "2026-01-02T00:00:00Z");
  expect(bands[0]!.members.some(member => member.key === deckKey)).toBe(true);
  const automatic = layoutTaskBands(layout, bands, options);
  expect(automatic.bands[0]!.geometry).toMatchObject({ historyAvailable: true, historyCollapsed: true });
  expect(automatic.shown.has(deckKey)).toBe(false);
  // SchemeBoard's disclosure: the operator's valid "expanded" override.
  const expandedDecks = new Set([deckKey]);
  const kept = layoutTaskBands(layout, bands, { ...options, collapsedDecks: new Set(), expandedDecks });
  expect(kept.bands[0]!.geometry).toMatchObject({ historyAvailable: true, historyCollapsed: false });
  expect(kept.shown.has(deckKey)).toBe(true);
  expect(kept.layout.decks[0]!.h).toBe(810);
  const folded = layoutTaskBands(layout, bands, { ...options, expandedDecks, historyOverrides: new Map([["task:done", false]]) });
  expect(folded.bands[0]!.geometry.historyCollapsed).toBe(true);
  expect(folded.shown.has(deckKey)).toBe(false);
  const shown = layoutTaskBands(layout, bands, { ...options, historyOverrides: new Map([["task:done", true]]) });
  expect(shown.shown.has(deckKey)).toBe(true);
  expect(flow.state).toBe("approved");
});

test("a round recorded after the task finished is current work, never folded history", () => {
  const round = (n: number, startedAt: string) => ({ ...reviewFlow("", "approved").rounds[0]!, n, verdict: "REQUEST_CHANGES" as const, startedAt });
  const withRounds = (...rounds: ReturnType<typeof round>[]) => ({ ...reviewFlow(file(0).path, "approved"), state: "needs_decision" as const, decisionRequired: true, rounds });
  const collapsedWith = (flow: ReturnType<typeof withRounds>, finishedAt: string) => {
    const { layout, bands, deckKey, options } = reviewedTaskScene(flow, finishedAt);
    const scene = layoutTaskBands(layout, bands, { ...options, historyOverrides: new Map([["task:done", false]]) });
    return { available: scene.bands[0]!.geometry.historyAvailable, deckShown: scene.shown.has(deckKey) };
  };
  // An old flow that was created before completion gets a new round after it.
  const renewed = withRounds(round(1, "2026-01-01T00:00:00Z"), round(2, "2026-01-03T00:00:00Z"));
  expect(collapsedWith(renewed, "2026-01-02T00:00:00Z")).toEqual({ available: false, deckShown: true });
  expect(renewed.state).toBe("needs_decision");
  // A decision recorded before completion is still history.
  expect(collapsedWith(withRounds(round(1, "2026-01-01T00:00:00Z")), "2026-01-02T00:00:00Z")).toEqual({ available: true, deckShown: false });
  // Dates compare as instants: half a second later is later, whatever the precision.
  expect(collapsedWith(withRounds(round(1, "2026-01-02T00:00:00.500Z")), "2026-01-02T00:00:00Z").available).toBe(false);
  // A missing or unreadable date cannot place work before completion.
  expect(collapsedWith(withRounds(round(1, "")), "2026-01-02T00:00:00Z").available).toBe(false);
  expect(collapsedWith(withRounds(round(1, "2026-01-01T00:00:00Z")), "not a date").available).toBe(false);
});

/** A completed task that owns a parked pipeline whose one stage ran on an idle
    conversation; the task finished on 2026-01-02. */
function pipelineTaskScene(attempt: Partial<import("@/lib/pipelines/types").PipelineStageAttempt>, flows: import("@/lib/flows/types").Flow[] = []) {
  const files = [file(0, "idle")];
  const pipeline = pipelineWith("p", files, ["done"]);
  pipeline.state = "needs_decision";
  Object.assign(pipeline.runs[0]!.attempts[0]!, { state: "needs_decision", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z" }, attempt);
  const layout = base(files);
  layout.groups = [{ key: "group::pipeline::p", kind: "pipeline", id: "p", hue: 0, members: [files[0]!.path], label: "Pipeline p", pipeline, x: 0, y: 0, w: 0, h: 0 }];
  const done = { ...task("done", "2026-01-01T00:00:00Z", files, "done"), updatedAt: "2026-01-02T00:00:00Z" };
  const bands = buildTaskBands(layout, { tasks: [done], projection: projectTaskWorkflows([done], [pipeline], flows, files), untitled: "Untitled task" });
  expect(bands[0]!.groups).toEqual(["group::pipeline::p"]);
  const scene = layoutTaskBands(layout, bands, { mode: "near", viewportWidth: 1440, reader: null, flows });
  return { available: scene.bands[0]!.geometry.historyAvailable, shown: scene.shown.has(files[0]!.path), pipeline };
}

test("a parked pipeline attempt started after completion, or never dated, is current work", () => {
  // Parked before completion: history.
  expect(pipelineTaskScene({})).toMatchObject({ available: true, shown: false });
  // Started after completion and parked without a completion date.
  const renewed = pipelineTaskScene({ startedAt: "2026-01-03T00:00:00Z", completedAt: null });
  expect(renewed).toMatchObject({ available: false, shown: true });
  expect(renewed.pipeline.state).toBe("needs_decision");
  // Parked before it ever launched: nothing dates it before completion.
  expect(pipelineTaskScene({ startedAt: null, completedAt: null })).toMatchObject({ available: false, shown: true });
});

test("a pipeline's review loop with a round after completion is current work, read from the flow catalog", () => {
  const round = (startedAt: string) => ({ ...reviewFlow("", "approved").rounds[0]!, verdict: "REQUEST_CHANGES" as const, startedAt });
  const loop = (startedAt: string) => ({ ...reviewFlow(file(0).path, "approved"), id: "flow-p", state: "needs_decision" as const, rounds: [round("2026-01-01T00:30:00Z"), round(startedAt)] });
  const attempt = { state: "passed" as const, flowId: "flow-p" };
  // The loop is not a board deck, so only the catalog carries its new round.
  expect(pipelineTaskScene(attempt, [loop("2026-01-03T00:00:00Z")])).toMatchObject({ available: false, shown: true });
  expect(pipelineTaskScene(attempt, [loop("2026-01-01T00:40:00Z")])).toMatchObject({ available: true, shown: false });
  expect(pipelineTaskScene(attempt, [{ ...loop("2026-01-01T00:40:00Z"), state: "reviewing" }])).toMatchObject({ available: false, shown: true });
});

test("an incomplete scan of a completed task's conversation keeps its history open", () => {
  const scene = (extra: Partial<FileEntry>) => {
    const files = [file(0, null, extra)];
    const layout = base(files);
    const bands = buildTaskBands(layout, sources([task("done", "2026-01-01T00:00:00Z", files, "done")], files));
    return layoutTaskBands(layout, bands, { mode: "near", viewportWidth: 1440, reader: null }).bands[0]!.geometry.historyAvailable;
  };
  // No turn evidence and an idle mtime: complete, it is idle; incomplete, it is unread.
  expect(scene({ derivationComplete: true })).toBe(true);
  expect(scene({ derivationComplete: false })).toBe(false);
});

test("461 empty tasks pack into readable header surfaces without dropping visibility choices", () => {
  const tasks = Array.from({ length: 461 }, (_, i) => ({ ...task(String(i), "2026-01-01T00:00:00Z", [], i === 0 ? "done" : "assigned"), showOnBoard: true }));
  const layout = base([]);
  const bands = buildTaskBands(layout, sources(tasks, []));
  for (const viewportWidth of [1440, 830, 390]) {
    const scene = layoutTaskBands(layout, bands, { mode: "near", viewportWidth, reader: null });
    expect(scene.bands).toHaveLength(461);
    for (const band of scene.bands) {
      expect(band.geometry.rect.h).toBe(band.geometry.header.h);
      expect(band.geometry.rect.x + band.geometry.rect.w).toBeLessThanOrEqual(viewportWidth);
    }
    if (viewportWidth === 1440) {
      expect(scene.bands[0]!.geometry.rect.y).toBe(scene.bands[1]!.geometry.rect.y);
      expect(scene.bands[1]!.geometry.rect.x).toBeGreaterThan(scene.bands[0]!.geometry.rect.x + scene.bands[0]!.geometry.rect.w);
    }
  }
});

test("placeholder disclosure reserves its actual surface and reflows the following band both ways", () => {
  const layout = base([]);
  const pipeline = pipelineWith("planned", [file(1)], ["t"]);
  pipeline.runs = [];
  pipeline.state = "needs_decision";
  const key = "slot::planned::stage-0";
  layout.slots = [{ key, pipeline, stage: pipeline.stages[0]!, index: 0, total: 1, presentation: "placeholder", x: 0, y: 0, w: 600, h: 620 }];
  layout.groups = [{ key: "group::pipeline::planned", kind: "pipeline", id: pipeline.id, pipeline, hue: 0, label: "Planned", members: [key], x: 0, y: 0, w: 600, h: 620 }];
  const tasks = [task("t", "2026-01-01T00:00:00Z", []), task("next", "2026-01-02T00:00:00Z", [])];
  const bands = buildTaskBands(layout, { tasks, projection: projectTaskWorkflows(tasks, [pipeline], [], []), untitled: "Untitled" });
  const options = { mode: "near" as const, viewportWidth: 830, reader: null };
  const compact = layoutTaskBands(layout, bands, options);
  expect(compact.layout.slots[0]!.h).toBe(104);
  const expanded = layoutTaskBands(layout, bands, { ...options, expandedStages: new Set([key]) });
  expect(expanded.layout.slots[0]!.h).toBe(724);
  expect(expanded.bands[1]!.geometry.rect.y - compact.bands[1]!.geometry.rect.y).toBe(620);
  expect(layoutTaskBands(layout, bands, options).bands.map(band => band.geometry)).toEqual(compact.bands.map(band => band.geometry));
  expect(pipeline.state).toBe("needs_decision");
});


test("older attempt labels retain the old verdict and never label a reused current path as history", () => {
  const pipeline = pipelineWith("retry", [file(0)]);
  const old = { n: 1, state: "failed", agentPath: "/fixture/old" } as import("@/lib/pipelines/types").PipelineStageAttempt;
  const current = { n: 2, state: "passed", agentPath: "/fixture/current" } as import("@/lib/pipelines/types").PipelineStageAttempt;
  pipeline.runs = [{ stageId: "stage-0", attempts: [old, current] }];
  expect(historicalAttemptLabels([pipeline]).get(old.agentPath!)?.state).toBe("failed");
  expect(historicalAttemptLabels([pipeline]).has(current.agentPath!)).toBe(false);
  current.agentPath = old.agentPath;
  expect(historicalAttemptLabels([pipeline]).size).toBe(0);
});


test("a dependency into folded history retains a continuation to its actual conversation", () => {
  const files = [file(0, "busy"), file(1, "idle")];
  const layout = base(files, [[0, 1]]);
  const tasks = [task("current", "2026-01-01T00:00:00Z", [files[0]!]), task("old", "2026-01-02T00:00:00Z", [files[1]!], "done")];
  const bands = buildTaskBands(layout, sources(tasks, files));
  const options = { mode: "near" as const, viewportWidth: 1440, reader: null };
  const folded = layoutTaskBands(layout, bands, options);
  expect(folded.shown.has(files[1]!.path)).toBe(false);
  expect(folded.continuations[0]!.targets[0]).toMatchObject({ key: files[1]!.path, bandId: "task:old" });
  const revealed = layoutTaskBands(layout, bands, { ...options, reader: folded.continuations[0]!.targets[0]!.key });
  expect(revealed.shown.has(files[1]!.path)).toBe(true);
  expect(revealed.layout.byPath.get(files[1]!.path)?.h).toBe(BAND.nativeH);
});
