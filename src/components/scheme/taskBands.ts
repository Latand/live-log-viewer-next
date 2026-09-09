import { conversationIdentity } from "@/lib/accounts/identity";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { taskTitle } from "@/components/tasks/taskModel";
import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import { cleanTitle } from "@/components/utils";

import { hueFromId } from "./agentLinks";
import type { SchemeEdge, SchemeGroup, SchemeLayout, SchemeNode, SchemeRect } from "./layout";
import { routeTaskEdge } from "./taskGeometry";

/**
 * Task-centered board (#1586): every admitted conversation belongs to exactly
 * one horizontal band per task it is linked to. Bands stack vertically, span the
 * full available width, wrap their members into rows and sort by the number of
 * distinct conversations with authoritative working evidence. This module is
 * the pure projection + geometry; `TaskBandsLayer` draws the band chrome and
 * `SchemeBoard` feeds the node/edge layers the resulting layout.
 */

/* ------------------------------------------------------------------------- */
/* Semantic zoom                                                              */
/* ------------------------------------------------------------------------- */

export type BandMode = "overview" | "intermediate" | "near";

/** Overview below 22%, near from 82%; a 2-point hysteresis margin at both
    boundaries so a wheel resting on the threshold never oscillates. */
export const OVERVIEW_ENTER_Z = 0.22;
export const OVERVIEW_EXIT_Z = 0.24;
export const NEAR_ENTER_Z = 0.82;
export const NEAR_EXIT_Z = 0.8;

export function bandModeFor(zoom: number, previous: BandMode | null): BandMode {
  if (previous === "overview") {
    if (zoom < OVERVIEW_EXIT_Z) return "overview";
    return zoom >= NEAR_ENTER_Z ? "near" : "intermediate";
  }
  if (previous === "near") {
    if (zoom >= NEAR_EXIT_Z) return "near";
    return zoom < OVERVIEW_ENTER_Z ? "overview" : "intermediate";
  }
  if (zoom < OVERVIEW_ENTER_Z) return "overview";
  return zoom >= NEAR_ENTER_Z ? "near" : "intermediate";
}

/* ------------------------------------------------------------------------- */
/* Working evidence                                                           */
/* ------------------------------------------------------------------------- */

export type WorkEvidence = "working" | "unknown" | "idle";

/** Only a provider-authoritative open turn counts as working. A live mtime, a
    mapped process or a spawning receipt without turn evidence is `unknown` and
    contributes zero to the ranking; a closed turn is idle. */
export function workEvidence(file: FileEntry): WorkEvidence {
  const turn = file.authoritativeTurn?.state;
  if (turn === "busy") return "working";
  if (turn === "terminal" || turn === "idle") return "idle";
  if (file.proc === "done" || file.proc === "killed") return "idle";
  if (file.spawn && file.spawn.state !== "failed") return "unknown";
  if (file.proc === "running" || file.activity === "live" || file.activity === "stalled") return "unknown";
  return "idle";
}

/* ------------------------------------------------------------------------- */
/* Band model                                                                 */
/* ------------------------------------------------------------------------- */

export type BandOrigin = "task" | "pipeline" | "flow" | "conversation" | "draft";

export interface BandMember {
  /** Board key (`layout.byPath`): a node path, `slot::…`, `deck::…`, `draft::…`, `stack::…`. */
  key: string;
  kind: "node" | "slot" | "deck" | "draft" | "stack";
  file: FileEntry | null;
}

/** A conversation whose canonical surface lives in another band: this band
    shows a labelled reference tile instead of a second reader owner. */
export interface BandMirror {
  key: string;
  ofKey: string;
  file: FileEntry;
  primaryBandId: string;
  primaryTitle: string;
}

export interface TaskBand {
  id: string;
  origin: BandOrigin;
  task: BoardTask | null;
  pipeline: Pipeline | null;
  flow: Flow | null;
  title: string;
  status: TaskStatus | null;
  hue: number;
  members: BandMember[];
  mirrors: BandMirror[];
  /** Base pipeline/flow group keys this band hosts; a container whose stages
      are not placed (overview, unmaterialized draft) keeps a reserved label
      slot so its header chip and controls always have a place. */
  groups: string[];
  /** Distinct conversations with authoritative working evidence. */
  working: number;
  /** Distinct conversations whose current evidence is incomplete. */
  unknown: number;
  /** Distinct conversations represented (members and mirrors). */
  conversations: number;
  /** Planned pipeline stages without a launch. */
  planned: number;
  /** A just-created draft: shown first regardless of activity. */
  pinnedTop: boolean;
  createdAt: string;
}

export interface BandSources {
  tasks: readonly BoardTask[];
  projection: TaskWorkflowProjection;
  /** Draft id → band id for drafts opened from a band's local «+ Agent». */
  draftBands?: ReadonlyMap<string, string>;
  /** Conversation id or path → task id for launches whose durable assignment
      is still being recorded (client-side pending link). */
  provisionalMemberships?: ReadonlyMap<string, string>;
  /** Localized «Untitled task» for derived bands without a task record. */
  untitled: string;
  /** Localized fallback for a review flow without a resolvable implementer. */
  reviewFlow?: string;
}

interface Claims {
  nodes: Set<string>;
  keys: Set<string>;
  primary: Map<string, { bandId: string; title: string }>;
}

function fileIdentity(file: FileEntry): string {
  return conversationIdentity(file);
}

/**
 * Project recorded task membership, pipeline/flow containers and remaining
 * lineage roots onto bands. Every node of `base` ends up in exactly one band as
 * a member; a conversation linked to several tasks is a member of the earliest
 * created task and a mirror in the others. Order of the result is the claim
 * order, not the activity rank — see {@link rankBands}.
 */
export function buildTaskBands(base: SchemeLayout, sources: BandSources): TaskBand[] {
  const { tasks, projection, draftBands, provisionalMemberships, untitled } = sources;
  const nodeByKey = new Map(base.nodes.map((node) => [node.file.path, node] as const));
  const slotKeys = new Set(base.slots.map((slot) => slot.key));
  const deckKeys = new Set(base.decks.map((deck) => deck.key));
  const draftKeys = new Set(base.drafts.map((draft) => draft.key));
  const stacksByParent = new Map<string, string[]>();
  for (const stack of base.stacks) {
    const list = stacksByParent.get(stack.parent) ?? [];
    list.push(stack.key);
    stacksByParent.set(stack.parent, list);
  }
  const claims: Claims = { nodes: new Set(), keys: new Set(), primary: new Map() };
  const bands: TaskBand[] = [];
  const bandOfKey = new Map<string, TaskBand>();

  const kindOf = (key: string): BandMember["kind"] | null => {
    if (nodeByKey.has(key)) return "node";
    if (slotKeys.has(key)) return "slot";
    if (deckKeys.has(key)) return "deck";
    if (draftKeys.has(key)) return "draft";
    return null;
  };

  /** Adds a key to a band: nodes claimed elsewhere become mirrors, other
      surfaces are projected once (first band wins). */
  const admit = (band: TaskBand, key: string) => {
    const kind = kindOf(key);
    if (!kind) return;
    if (kind === "node") {
      const node = nodeByKey.get(key)!;
      const identity = fileIdentity(node.file);
      const owner = claims.primary.get(identity);
      if (owner && owner.bandId !== band.id) {
        const mirrorKey = `mirror::${band.id}::${identity}`;
        if (!band.mirrors.some((mirror) => mirror.key === mirrorKey)) {
          band.mirrors.push({ key: mirrorKey, ofKey: key, file: node.file, primaryBandId: owner.bandId, primaryTitle: owner.title });
        }
        return;
      }
      if (claims.nodes.has(key)) return;
      claims.nodes.add(key);
      claims.primary.set(identity, { bandId: band.id, title: band.title });
      band.members.push({ key, kind, file: node.file });
      bandOfKey.set(key, band);
      for (const stackKey of stacksByParent.get(key) ?? []) {
        if (claims.keys.has(stackKey)) continue;
        claims.keys.add(stackKey);
        band.members.push({ key: stackKey, kind: "stack", file: null });
        bandOfKey.set(stackKey, band);
      }
      return;
    }
    if (claims.keys.has(key)) return;
    claims.keys.add(key);
    band.members.push({ key, kind, file: null });
    bandOfKey.set(key, band);
  };

  const groupFor = (kind: "pipeline" | "flow", id: string): SchemeGroup | undefined =>
    base.groups.find((group) => group.kind === kind && group.id === id);
  const slotFor = (pipelineId: string, stageId: string): string | null =>
    base.slots.find((slot) => slot.pipeline.id === pipelineId && slot.stage.id === stageId)?.key ?? null;
  /** Drafts opened from this band's local «+ Agent» sit after its members. */
  const admitDrafts = (band: TaskBand) => {
    if (!draftBands?.size) return;
    for (const draft of base.drafts) if (draftBands.get(draft.id) === band.id) admit(band, draft.key);
  };
  const ownedGroups = new Set<string>();
  const own = (band: TaskBand, group: SchemeGroup | undefined) => {
    if (!group || ownedGroups.has(group.key)) return;
    ownedGroups.add(group.key);
    band.groups.push(group.key);
  };
  const makeBand = (partial: Omit<TaskBand, "members" | "mirrors" | "groups" | "working" | "unknown" | "conversations" | "planned">): TaskBand => {
    const band: TaskBand = { ...partial, members: [], mirrors: [], groups: [], working: 0, unknown: 0, conversations: 0, planned: 0 };
    bands.push(band);
    return band;
  };

  /* 1. Recorded tasks, claimed in creation order so a shared conversation's
        canonical surface is stable across polls and activity changes. */
  const orderedTasks = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const task of orderedTasks) {
    const workflow = projection.tasks.find((entry) => entry.task.id === task.id);
    const title = taskTitle(task.text) || untitled;
    const band = makeBand({ id: `task:${task.id}`, origin: "task", task, pipeline: null, flow: null, title, status: task.status, hue: hueFromId(task.id), pinnedTop: false, createdAt: task.createdAt });
    if (workflow) {
      /* Membership provenance: recorded assignments and explicitly bound
         containers establish members. An execution the projection associated
         only because one worker matched an assignment stays a relation; its
         other stages are not promoted into this task. A container whose
         fallback task this is (origin key) counts as explicitly bound. */
      const canonical = workflow.references.filter((reference) => reference.kind === "assignment" && reference.file);
      for (const reference of canonical) admit(band, reference.file!.path);
      for (const execution of workflow.executions) {
        const bound = execution.basis === "explicit" || (task.origin?.kind === "pipeline" && task.origin.key === execution.pipeline.id);
        if (!bound) continue;
        const group = groupFor("pipeline", execution.pipeline.id);
        own(band, group);
        for (const key of group?.members ?? []) admit(band, key);
        for (const reference of execution.references) {
          if (reference.file) admit(band, reference.file.path);
          else if (reference.kind === "planned" && reference.pipelineId && reference.stageId) {
            const key = slotFor(reference.pipelineId, reference.stageId);
            if (key) admit(band, key);
          }
        }
      }
      const memberPaths = new Set(band.members.filter((member) => member.file).map((member) => member.key));
      for (const flow of workflow.flows) {
        const bound = memberPaths.has(flow.implementerPath) || (task.origin?.kind === "flow" && task.origin.key === flow.id);
        if (!bound) continue;
        const group = groupFor("flow", flow.id);
        own(band, group);
        for (const key of group?.members ?? []) admit(band, key);
        for (const deck of base.decks) if (deck.flow.id === flow.id) admit(band, deck.key);
        for (const reference of workflow.references) if (reference.kind === "review" && reference.flowId === flow.id && reference.file) admit(band, reference.file.path);
      }
    }
    if (provisionalMemberships?.size) {
      for (const node of base.nodes) {
        const linked = provisionalMemberships.get(node.file.conversationId ?? "") ?? provisionalMemberships.get(node.file.path);
        if (linked === task.id) admit(band, node.file.path);
      }
    }
    admitDrafts(band);
  }

  /* 2. Pipelines and flows without a task: the container the board already
        lays out is the fallback task until admission (#1586 Slice A) records
        one. Containers of another project that the board still draws keep
        their halo the same way. */
  for (const group of base.groups) {
    if (group.kind === "task" || ownedGroups.has(group.key)) continue;
    if (group.kind === "pipeline") {
      const pipeline = group.pipeline ?? null;
      const references = pipeline ? projection.unlinkedReferences.filter((reference) => reference.pipelineId === pipeline.id) : [];
      const band = makeBand({ id: `pipeline:${group.id}`, origin: "pipeline", task: null, pipeline, flow: null, title: cleanTitle(pipeline?.task ?? group.label, 80) || untitled, status: null, hue: group.hue, pinnedTop: false, createdAt: pipeline?.createdAt ?? "" });
      own(band, group);
      for (const key of group.members) admit(band, key);
      for (const reference of references) if (reference.file) admit(band, reference.file.path);
      admitDrafts(band);
      continue;
    }
    const flow = group.flow ?? null;
    const implementer = flow ? nodeByKey.get(flow.implementerPath) : undefined;
    const title = implementer ? cleanTitle(implementer.file.title, 80) : cleanTitle(group.label, 80) || sources.reviewFlow || untitled;
    const band = makeBand({ id: `flow:${group.id}`, origin: "flow", task: null, pipeline: null, flow, title: title || untitled, status: null, hue: group.hue, pinnedTop: false, createdAt: flow?.createdAt ?? "" });
    own(band, group);
    for (const key of group.members) admit(band, key);
    if (implementer) admit(band, implementer.file.path);
    for (const deck of base.decks) if (flow && deck.flow.id === flow.id) admit(band, deck.key);
    admitDrafts(band);
  }
  for (const pipeline of projection.unlinkedPipelines) {
    if (ownedGroups.has(`group::pipeline::${pipeline.id}`) || bands.some((band) => band.pipeline?.id === pipeline.id)) continue;
    const references = projection.unlinkedReferences.filter((reference) => reference.pipelineId === pipeline.id);
    const keys = references.flatMap((reference) => (reference.file ? [reference.file.path] : reference.kind === "planned" && reference.stageId ? [slotFor(pipeline.id, reference.stageId) ?? ""] : [])).filter(Boolean);
    if (!keys.some((key) => kindOf(key))) continue;
    const band = makeBand({ id: `pipeline:${pipeline.id}`, origin: "pipeline", task: null, pipeline, flow: null, title: cleanTitle(pipeline.task, 80) || untitled, status: null, hue: hueFromId(pipeline.id), pinnedTop: false, createdAt: pipeline.createdAt });
    for (const key of keys) admit(band, key);
    admitDrafts(band);
  }

  /* 3. Native children of an admitted member inherit their parent's band; the
        remaining lineage roots each derive a band titled from their first
        prompt, pending a recorded task. */
  const parentOf = new Map<string, string>();
  for (const edge of base.edges) if (edge.from && nodeByKey.has(edge.from) && nodeByKey.has(edge.to)) parentOf.set(edge.to, edge.from);
  const rootOf = (key: string): string => {
    let current = key;
    const seen = new Set<string>();
    while (!claims.nodes.has(current)) {
      const parent = parentOf.get(current);
      if (!parent || seen.has(parent)) return current;
      seen.add(parent);
      current = parent;
    }
    return current;
  };
  const orderedNodes = [...base.nodes].sort((a, b) => (a.lineageOrderKey ?? "").localeCompare(b.lineageOrderKey ?? "") || a.file.path.localeCompare(b.file.path));
  for (const node of orderedNodes) {
    if (claims.nodes.has(node.file.path)) continue;
    const root = rootOf(node.file.path);
    const owner = bandOfKey.get(root);
    if (owner) {
      admit(owner, node.file.path);
      continue;
    }
    if (root !== node.file.path && !nodeByKey.has(root)) continue;
    const rootNode = nodeByKey.get(root)!;
    if (!claims.nodes.has(root)) {
      const identity = fileIdentity(rootNode.file);
      const band = makeBand({ id: `lineage:${identity}`, origin: "conversation", task: null, pipeline: null, flow: null, title: cleanTitle(rootNode.file.title, 80) || untitled, status: null, hue: hueFromId(identity), pinnedTop: false, createdAt: "" });
      admit(band, root);
      admitDrafts(band);
    }
    if (root !== node.file.path) admit(bandOfKey.get(root)!, node.file.path);
  }

  /* 4. Drafts without a task: a global «+ Agent» is a new task in the making. */
  for (const draft of base.drafts) {
    if (claims.keys.has(draft.key)) continue;
    const band = makeBand({ id: `draft:${draft.id}`, origin: "draft", task: null, pipeline: null, flow: null, title: untitled, status: null, hue: hueFromId(draft.id), pinnedTop: true, createdAt: "" });
    admit(band, draft.key);
  }

  /* 5. Counts over distinct conversations, members and mirrors alike. */
  for (const band of bands) {
    const identities = new Map<string, FileEntry>();
    for (const member of band.members) if (member.file) identities.set(fileIdentity(member.file), member.file);
    for (const mirror of band.mirrors) identities.set(fileIdentity(mirror.file), mirror.file);
    band.conversations = identities.size;
    for (const file of identities.values()) {
      const evidence = workEvidence(file);
      if (evidence === "working") band.working += 1;
      else if (evidence === "unknown") band.unknown += 1;
    }
    band.planned = band.members.filter((member) => member.kind === "slot" && base.slots.find((slot) => slot.key === member.key)?.presentation === "placeholder").length;
  }
  return bands;
}

/** Working count descending, then creation ascending (tasks before undated
    derived bands), then id: reproducible ties, no attention override. */
export function rankBands(bands: readonly TaskBand[]): TaskBand[] {
  return [...bands].sort((a, b) => {
    if (a.pinnedTop !== b.pinnedTop) return a.pinnedTop ? -1 : 1;
    if (a.working !== b.working) return b.working - a.working;
    if (a.createdAt !== b.createdAt) {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });
}

/** Re-applies a frozen order (band ids) to fresh bands: known ids keep their
    slot, newcomers append in their ranked order. */
export function applyBandOrder(ranked: readonly TaskBand[], frozen: readonly string[] | null): TaskBand[] {
  if (!frozen) return [...ranked];
  const index = new Map(frozen.map((id, position) => [id, position] as const));
  const known = ranked.filter((band) => index.has(band.id)).sort((a, b) => index.get(a.id)! - index.get(b.id)!);
  return [...known, ...ranked.filter((band) => !index.has(band.id))];
}

/* ------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* ------------------------------------------------------------------------- */

/** CSS-pixel constants of the band chrome; the layout divides by zoom so every
    one of them is constant on screen at any scale. */
export const BAND = {
  containerW: 280,
  containerH: 44,
  gutter: 24,
  gutterNarrow: 16,
  gap: 16,
  header: 48,
  pad: 16,
  tileGap: 24,
  rowGap: 32,
  summaryW: 320,
  summaryH: 160,
  nativeW: 600,
  nativeMinW: 320,
  nativeH: 680,
  chipW: 220,
  chipH: 28,
  chipGap: 8,
  addW: 108,
  addH: 44,
  mirrorW: 320,
  mirrorH: 72,
  mirrorChipW: 220,
  minOverviewH: 72,
} as const;

export interface BandGeometry {
  rect: SchemeRect;
  header: SchemeRect;
  addAgent: SchemeRect;
  rows: number;
}

export interface PlacedBand extends TaskBand {
  geometry: BandGeometry;
}

export interface BandScene {
  layout: SchemeLayout;
  bands: PlacedBand[];
  /** Every board key placed inside a band (the visibility index reads it). */
  shown: Set<string>;
  mode: BandMode;
  /** `task::<id>` → header rect, so focus/glide on a task lands on its band. */
  taskRects: Map<string, SchemeRect>;
  mirrorRects: Map<string, SchemeRect>;
  /** World units per CSS pixel (1 / zoom). */
  scale: number;
  /** Band id per placed key, for same-band edge filtering and hit tests. */
  bandOf: Map<string, string>;
  /** Cross-band recorded relations, per attached member/mirror. */
  continuations: BandContinuation[];
}

export interface BandLayoutOptions {
  zoom: number;
  mode: BandMode;
  viewportWidth: number;
  /** Conversation whose reader is native in near mode. */
  reader: string | null;
  /** Node key → band id: the operator opened that conversation's projection in
      this band, so the one reader surface is hosted there and the canonical
      band shows the reference tile instead. Ignored unless the band holds a
      mirror of the node. */
  hostOverrides?: ReadonlyMap<string, string>;
}

/** A recorded relation whose other endpoint lives in another band: shown as a
    labelled continuation on the member it is attached to. */
export interface BandContinuation {
  /** Board key of the member or mirror the chip is attached to. */
  key: string;
  bandId: string;
  targets: { key: string; bandId: string; title: string; direction: "to" | "from" }[];
}

function union(rects: readonly SchemeRect[]): SchemeRect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return { x, y, w: Math.max(...rects.map((rect) => rect.x + rect.w)) - x, h: Math.max(...rects.map((rect) => rect.y + rect.h)) - y };
}

/** Directed ports between two placed rects: side ports on the same row, top/
    bottom ports across rows; the port height stays near the header so a tall
    reader's arrow leaves where its title is. */
export function bandEdgePorts(a: SchemeRect, b: SchemeRect, scale: number): { x1: number; y1: number; x2: number; y2: number } {
  const sameRow = a.y < b.y + b.h && b.y < a.y + a.h;
  const portY = (rect: SchemeRect) => rect.y + Math.min(rect.h / 2, 40 * scale);
  if (sameRow) {
    return a.x + a.w <= b.x
      ? { x1: a.x + a.w, y1: portY(a), x2: b.x, y2: portY(b) }
      : { x1: a.x, y1: portY(a), x2: b.x + b.w, y2: portY(b) };
  }
  return a.y + a.h <= b.y
    ? { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y }
    : { x1: a.x + a.w / 2, y1: a.y, x2: b.x + b.w / 2, y2: b.y + b.h };
}

/**
 * Stack the ordered bands top to bottom at full available width and wrap their
 * members into rows. Node footprints are screen-constant per mode (chip /
 * summary / native reader); slots, decks, drafts and stacks keep their base
 * footprint. The returned layout carries every placed surface at its final
 * rectangle, so cards, halos, hit targets and edge endpoints agree.
 */
/** Swap a conversation's surface into the band the operator opened it in: the
    override band's mirror becomes the member and the canonical band keeps a
    mirror, so the reader owner is one and the counts do not change. */
export function applyHostOverrides(bands: readonly TaskBand[], overrides: ReadonlyMap<string, string> | undefined): TaskBand[] {
  if (!overrides?.size) return [...bands];
  const next = bands.map((band) => ({ ...band, members: [...band.members], mirrors: [...band.mirrors] }));
  for (const [nodeKey, bandId] of overrides) {
    const host = next.find((band) => band.id === bandId);
    const source = next.find((band) => band.members.some((member) => member.key === nodeKey));
    if (!host || !source || host === source) continue;
    const mirrorIndex = host.mirrors.findIndex((mirror) => mirror.ofKey === nodeKey);
    if (mirrorIndex < 0) continue;
    const mirror = host.mirrors[mirrorIndex]!;
    const memberIndex = source.members.findIndex((member) => member.key === nodeKey);
    const member = source.members[memberIndex]!;
    host.mirrors.splice(mirrorIndex, 1);
    host.members.push(member);
    source.members.splice(memberIndex, 1);
    source.mirrors.push({ key: `mirror::${source.id}::${mirror.key.split("::").pop()}`, ofKey: nodeKey, file: mirror.file, primaryBandId: host.id, primaryTitle: host.title });
  }
  return next;
}

export function layoutTaskBands(base: SchemeLayout, orderedBands: readonly TaskBand[], options: BandLayoutOptions): BandScene {
  const { mode, viewportWidth, reader } = options;
  const bands = applyHostOverrides(orderedBands, options.hostOverrides);
  const s = 1 / Math.max(0.07, options.zoom);
  const gutter = (viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter) * s;
  const bandW = Math.max(BAND.nativeMinW * s, viewportWidth * s - gutter * 2);
  const pad = BAND.pad * s;
  const innerX0 = gutter + pad;
  const innerRight = gutter + bandW - pad;
  const innerW = innerRight - innerX0;
  const itemGap = (mode === "overview" ? BAND.chipGap : BAND.tileGap) * s;
  const rowGap = (mode === "overview" ? BAND.chipGap : BAND.rowGap) * s;
  const headerH = BAND.header * s;

  const baseRect = new Map<string, SchemeRect>();
  for (const node of base.nodes) baseRect.set(node.file.path, node);
  for (const collection of [base.stacks, base.decks, base.drafts, base.slots]) for (const rect of collection) baseRect.set(rect.key, rect);

  const placed = new Map<string, SchemeRect>();
  const nodeRects = new Map<string, SchemeNode>();
  const mirrorRects = new Map<string, SchemeRect>();
  const containerSlots = new Map<string, SchemeRect>();
  const taskRects = new Map<string, SchemeRect>();
  const bandOf = new Map<string, string>();
  const shown = new Set<string>();
  const placedBands: PlacedBand[] = [];

  let cursorY = gutter;
  for (const band of bands) {
    const items: { key: string; w: number; h: number; kind: "member" | "mirror" | "container" | "add"; node?: SchemeNode }[] = [];
    for (const member of band.members) {
      if (member.kind === "node") {
        const node = base.nodes.find((entry) => entry.file.path === member.key)!;
        /* The selected conversation reads natively from the intermediate scale
           up: clicking a tile opens it in place, siblings stay tiles. */
        const presentation = mode === "overview" ? "chip" : member.key === reader ? "native" : "summary";
        const w = (presentation === "chip" ? BAND.chipW : presentation === "native" ? Math.max(BAND.nativeMinW, Math.min(BAND.nativeW, innerW / s)) : BAND.summaryW) * s;
        const h = (presentation === "chip" ? BAND.chipH : presentation === "native" ? BAND.nativeH : BAND.summaryH) * s;
        items.push({ key: member.key, w, h, kind: "member", node: { ...node, presentation, readerScale: s, w, h } });
        continue;
      }
      /* Decks, stacks and planned slots are thumbnails at overview scale:
         their content is unreadable there, so the band summarises them. */
      if (mode === "overview" && member.kind !== "draft") continue;
      const rect = baseRect.get(member.key);
      if (!rect) continue;
      items.push({ key: member.key, w: rect.w, h: rect.h, kind: "member" });
    }
    for (const mirror of band.mirrors) {
      items.push({ key: mirror.key, w: (mode === "overview" ? BAND.mirrorChipW : BAND.mirrorW) * s, h: (mode === "overview" ? BAND.chipH : BAND.mirrorH) * s, kind: "mirror" });
    }
    /* A hosted pipeline/flow with none of its surfaces placed in this mode
       still reserves a label slot: its halo header carries the controls. */
    const placedKeys = new Set(items.filter((item) => item.kind === "member").map((item) => item.key));
    for (const groupKey of band.groups) {
      const group = base.groups.find((entry) => entry.key === groupKey);
      if (!group || group.members.some((key) => placedKeys.has(key))) continue;
      items.push({ key: groupKey, w: (mode === "overview" ? BAND.chipW : BAND.containerW) * s, h: (mode === "overview" ? BAND.chipH : BAND.containerH) * s, kind: "container" });
    }
    items.push({ key: `add::${band.id}`, w: BAND.addW * s, h: (mode === "overview" ? BAND.chipH : BAND.addH) * s, kind: "add" });

    let x = innerX0;
    let y = cursorY + headerH + pad;
    let rowH = 0;
    let rows = 1;
    let addAgent: SchemeRect = { x, y, w: BAND.addW * s, h: BAND.addH * s };
    for (const item of items) {
      if (x + item.w > innerRight + 0.001 && x > innerX0) {
        x = innerX0;
        y += rowH + rowGap;
        rowH = 0;
        rows += 1;
      }
      const rect = { x, y, w: item.w, h: item.h };
      if (item.kind === "add") addAgent = rect;
      else if (item.kind === "container") {
        containerSlots.set(item.key, rect);
        bandOf.set(item.key, band.id);
      } else {
        placed.set(item.key, rect);
        shown.add(item.key);
        bandOf.set(item.key, band.id);
        if (item.kind === "mirror") mirrorRects.set(item.key, rect);
        if (item.node) nodeRects.set(item.key, { ...item.node, x, y });
      }
      x += item.w + itemGap;
      rowH = Math.max(rowH, item.h);
    }
    let bandH = headerH + pad + (y - (cursorY + headerH + pad)) + rowH + pad;
    if (mode === "overview") bandH = Math.max(bandH, BAND.minOverviewH * s);
    const rect = { x: gutter, y: cursorY, w: bandW, h: bandH };
    const header = { x: gutter, y: cursorY, w: bandW, h: headerH };
    if (band.task) taskRects.set(`task::${band.task.id}`, header);
    placedBands.push({ ...band, geometry: { rect, header, addAgent, rows } });
    cursorY += bandH + BAND.gap * s;
  }

  const byPath = new Map<string, SchemeRect>(placed);
  for (const [key, rect] of taskRects) byPath.set(key, rect);
  for (const band of placedBands) byPath.set(`band::${band.id}`, band.geometry.rect);
  for (const [key, rect] of containerSlots) byPath.set(key, rect);

  const nodes = base.nodes.map((node) => nodeRects.get(node.file.path) ?? node);
  const rectsIn = (bandId: string, except: readonly string[]) =>
    [...placed].filter(([key]) => bandOf.get(key) === bandId && !except.includes(key)).map(([, rect]) => rect);
  /* A node key may be represented in several bands: as its member surface and
     as mirrors. Every representation of an endpoint gets the continuation. */
  const representations = new Map<string, string[]>();
  for (const key of placed.keys()) {
    if (!key.startsWith("mirror::")) { representations.set(key, [...(representations.get(key) ?? []), key]); continue; }
    const band = placedBands.find((entry) => entry.mirrors.some((mirror) => mirror.key === key));
    const mirror = band?.mirrors.find((entry) => entry.key === key);
    if (mirror) representations.set(mirror.ofKey, [...(representations.get(mirror.ofKey) ?? []), key]);
  }
  const titleOf = new Map(placedBands.map((band) => [band.id, band.title] as const));
  const continuationByKey = new Map<string, BandContinuation>();
  const continue_ = (anchorKey: string, target: { key: string; bandId: string; direction: "to" | "from" }) => {
    const bandId = bandOf.get(anchorKey);
    if (!bandId || bandId === target.bandId) return;
    const entry = continuationByKey.get(anchorKey) ?? { key: anchorKey, bandId, targets: [] };
    if (!entry.targets.some((existing) => existing.key === target.key && existing.bandId === target.bandId && existing.direction === target.direction)) {
      entry.targets.push({ ...target, title: titleOf.get(target.bandId) ?? target.bandId });
    }
    continuationByKey.set(anchorKey, entry);
  };
  const edges: SchemeEdge[] = base.edges.flatMap((edge) => {
    if (!edge.from) return [];
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) return [];
    if (bandOf.get(edge.from) !== bandOf.get(edge.to)) {
      for (const rep of representations.get(edge.from) ?? []) continue_(rep, { key: edge.to, bandId: bandOf.get(edge.to)!, direction: "to" });
      for (const rep of representations.get(edge.to) ?? []) continue_(rep, { key: edge.from, bandId: bandOf.get(edge.from)!, direction: "from" });
      return [];
    }
    const ports = bandEdgePorts(from, to, s);
    const route = routeTaskEdge(ports, rectsIn(bandOf.get(edge.from)!, [edge.from, edge.to]));
    return [{ ...edge, ...ports, route: route.d, routeCrosses: route.crosses }];
  });
  /* Mirrors of an endpoint that shares a band with the other endpoint's member
     still point across bands from where they stand. */
  for (const edge of base.edges) {
    if (!edge.from || !placed.has(edge.from) || !placed.has(edge.to)) continue;
    for (const rep of representations.get(edge.from) ?? []) if (rep !== edge.from && bandOf.get(rep) !== bandOf.get(edge.to)) continue_(rep, { key: edge.to, bandId: bandOf.get(edge.to)!, direction: "to" });
    for (const rep of representations.get(edge.to) ?? []) if (rep !== edge.to && bandOf.get(rep) !== bandOf.get(edge.from)) continue_(rep, { key: edge.from, bandId: bandOf.get(edge.from)!, direction: "from" });
  }
  const groups: SchemeGroup[] = base.groups.flatMap((group) => {
    if (group.kind === "task") return [];
    const members = group.members.filter((key) => placed.has(key));
    if (!members.length) {
      const slot = containerSlots.get(group.key);
      return slot ? [{ ...group, members: [], ...slot }] : [];
    }
    const envelope = union(members.map((key) => placed.get(key)!));
    const padX = 12 * s;
    const heading = 30 * s;
    return [{ ...group, members, x: envelope.x - padX, y: envelope.y - heading, w: envelope.w + padX * 2, h: envelope.h + heading + padX }];
  });
  const layout: SchemeLayout = {
    ...base,
    nodes,
    edges,
    groups,
    byPath,
    links: base.links.filter((link) => placed.has(link.from) && placed.has(link.to)),
    loops: base.loops.flatMap((loop) => {
      const impl = placed.get(loop.flow.implementerPath);
      const deck = base.decks.find((entry) => entry.flow.id === loop.flow.id);
      const target = deck ? placed.get(deck.key) : undefined;
      return impl && target ? [{ ...loop, x1: impl.x + impl.w, x2: target.x, y: impl.y }] : [];
    }),
    stacks: base.stacks.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    decks: base.decks.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    drafts: base.drafts.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    slots: base.slots.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    regionTasks: [],
    width: viewportWidth * s,
    height: cursorY + gutter,
  };
  return { layout, bands: placedBands, shown, mode, taskRects, mirrorRects, scale: s, bandOf, continuations: [...continuationByKey.values()] };
}
