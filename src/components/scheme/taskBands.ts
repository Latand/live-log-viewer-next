import { BOARD_SURFACE, bandHistoryAvailable, bandContainsTarget, stageSurface } from "./boardPresentation";
import { conversationIdentity } from "@/lib/accounts/identity";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { taskShowsOnBoard } from "@/lib/tasks/boardVisibility";
import { COLLAPSED_DECK_CHIP_H, deckDisclosureTerminal } from "@/components/flows/reviewDeckDisclosure";
import { FLOW_HUB } from "@/components/flows/flowHubGeometry";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { taskTitle } from "@/components/tasks/taskModel";
import type { TaskWorkflowProjection } from "@/components/tasks/taskWorkflowModel";
import { cleanTitle } from "@/components/utils";

import { hueFromId } from "./agentLinks";
import type { SchemeEdge, SchemeGroup, SchemeLayout, SchemeNode, SchemeRect } from "./layout";
import { routeTaskEdge, sampleRoute } from "./taskGeometry";

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
        canonical surface is stable across polls and activity changes.

     Every task is built here, including the ones the operator took off the
     board: what a band resolved is the evidence the flag is applied to, and
     that is only known once it has been built. The filter runs at the end.
     A launch this session started but whose assignment is not persisted yet
     counts as membership too, so the band the operator just spawned into never
     blinks out. */
  const provisionalTaskIds = new Set(provisionalMemberships?.values() ?? []);
  const orderedTasks = [...tasks]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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
  /* The board flag, applied to what each band actually resolved.
     `bandHoldsMembers` is the one notion of membership on this surface: the
     same predicate decides whether a hidden task draws a band at all and
     whether the band offers «Remove from board» (TaskBandsLayer), so the board
     can never present a control whose write it would then override. A band
     that holds nothing has claimed nothing, so dropping it here releases no
     conversation and moves no other band's members. */
  return bands.filter((band) => band.origin !== "task" || !band.task
    || taskShowsOnBoard(band.task, bandHoldsMembers(band))
    || provisionalTaskIds.has(band.task.id));
}

/**
 * Whether a band resolved anything the board is drawing for it: a conversation
 * of its own, a mirror of one claimed by an earlier band, or a pipeline/flow
 * container it owns. A task whose recorded assignments all point at
 * conversations this board does not carry — archived, hidden, or simply never
 * scanned again — holds nothing, and that is what the board flag governs.
 */
export function bandHoldsMembers(band: Pick<TaskBand, "members" | "mirrors" | "groups">): boolean {
  return band.members.length > 0 || band.mirrors.length > 0 || band.groups.length > 0;
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

/** Board-pixel constants of the band chrome. World geometry is stable: a band
    member is one rectangle in board pixels and the camera's own `scale(zoom)`
    is what grows or shrinks it on screen, so a card, the frame that holds it
    and the connectors between them scale together (#1641). Zoom still chooses
    the presentation — chip, summary or the native reader — via `bandModeFor`;
    nothing here is divided by it. */
export const BAND = {
  containerW: 280,
  containerH: 44,
  gutter: 24,
  gutterNarrow: 16,
  gap: 16,
  header: BOARD_SURFACE.header,
  pad: 16,
  tileGap: 24,
  rowGap: 32,
  summaryW: BOARD_SURFACE.summary.w,
  summaryH: BOARD_SURFACE.summary.h,
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
  /* Board height a review-round deck occupies as its collapsed verdict chip —
     the height RoundDeck paints the chip at — so a band holding one hugs the
     chip instead of the full expanded deck box. */
  collapsedDeckH: COLLAPSED_DECK_CHIP_H,
  /* A band is only as wide as it needs to be (#1590 follow-up). Below this it
     is unreadable — the header alone carries a title, a status pill, counts and
     two controls — and above it nothing is gained by growing further, so a band
     whose row of members ends early stops there instead of ruling a line across
     the whole canvas. Both are CSS pixels, like every other constant here. */
  minBandW: 620,
} as const;

export interface BandGeometry {
  historyAvailable: boolean;
  historyCollapsed: boolean;
  rect: SchemeRect;
  header: SchemeRect;
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
  /** Band id per placed key, for same-band edge filtering and hit tests. */
  bandOf: Map<string, string>;
  /** Cross-band recorded relations, per attached member/mirror. */
  continuations: BandContinuation[];
}

export interface BandLayoutOptions {
  expandedStages?: ReadonlySet<string>;
  historyOverrides?: ReadonlyMap<string, boolean>;
  revealTarget?: string | null;
  mode: BandMode;
  viewportWidth: number;
  /** Conversation whose reader is native in near mode. */
  reader: string | null;
  /** Node key → band id: the operator opened that conversation's projection in
      this band, so the one reader surface is hosted there and the canonical
      band shows the reference tile instead. Ignored unless the band holds a
      mirror of the node. */
  hostOverrides?: ReadonlyMap<string, string>;
  /** Deck keys the operator is seeing collapsed to their verdict chip — the
      actual disclosure state (localStorage override + lifecycle default). A
      collapsed deck reserves the chip height so its band hugs; a manually
      expanded settled deck reserves its full footprint. Absent it, the
      lifecycle default decides. */
  collapsedDecks?: ReadonlySet<string>;
}

/** A recorded relation whose other endpoint lives in another band: shown as a
    labelled continuation on the member it is attached to. */
export interface BandContinuation {
  /** Board key of the member or mirror the chip is attached to. */
  key: string;
  bandId: string;
  targets: { key: string; bandId: string; title: string; direction: "to" | "from" }[];
}


/** Directed ports between two placed rects: side ports on the same row, top/
    bottom ports across rows; the port height stays near the header so a tall
    reader's arrow leaves where its title is. */
export function bandEdgePorts(a: SchemeRect, b: SchemeRect): { x1: number; y1: number; x2: number; y2: number } {
  const sameRow = a.y < b.y + b.h && b.y < a.y + a.h;
  const portY = (rect: SchemeRect) => rect.y + Math.min(rect.h / 2, 40);
  if (sameRow) {
    return a.x + a.w <= b.x
      ? { x1: a.x + a.w, y1: portY(a), x2: b.x, y2: portY(b) }
      : { x1: a.x, y1: portY(a), x2: b.x + b.w, y2: portY(b) };
  }
  return a.y + a.h <= b.y
    ? { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y }
    : { x1: a.x + a.w / 2, y1: a.y, x2: b.x + b.w / 2, y2: b.y + b.h };
}

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

/** Where the ⟳ hub of a review loop sits: ON the routed connector, as close
    to its middle as a hub-sized box can be without covering a card that is
    not one of the loop's two endpoints. The connector already threads between
    the band's other cards; the hub is wider than a stroke, so it walks along
    the path from the middle outward until its box is clear. */
export function hubOnRoute(route: string, others: readonly SchemeRect[]): { x: number; y: number } {
  const points = sampleRoute(route);
  const mid = Math.floor(points.length / 2);
  const clear = (point: { x: number; y: number }) => !others.some((rect) =>
    point.x + FLOW_HUB.w / 2 > rect.x && point.x - FLOW_HUB.w / 2 < rect.x + rect.w
    && point.y + FLOW_HUB.h / 2 > rect.y && point.y - FLOW_HUB.h / 2 < rect.y + rect.h);
  for (let step = 0; step < points.length; step += 1) {
    for (const index of [mid + step, mid - step]) {
      const point = points[index];
      if (point && clear(point)) return point;
    }
  }
  return points[mid] ?? { x: 0, y: 0 };
}

/**
 * Stack the ordered bands top to bottom and wrap their members into rows, in
 * board pixels the camera scales as one. Node footprints follow the mode
 * (chip / summary / native reader); slots, decks, drafts and stacks keep their
 * base footprint, a collapsed deck its chip. The returned layout carries every
 * placed surface at its final rectangle, so cards, halos, hit targets, edge
 * endpoints and the review hub agree. The zoom is deliberately not an input:
 * the board once divided every size by it so the camera's multiply cancelled
 * out and cards stayed screen-constant, which is why cards did not change size
 * when the operator zoomed and why every zoom frame forced a relayout (#1641).
 */
export function layoutTaskBands(base: SchemeLayout, orderedBands: readonly TaskBand[], options: BandLayoutOptions): BandScene {
  const { mode, viewportWidth, reader } = options;
  const bands = applyHostOverrides(orderedBands, options.hostOverrides);
  const gutter = viewportWidth < 1024 ? BAND.gutterNarrow : BAND.gutter;
  /* The widest a band may become. Content decides the rest. */
  const maxBandW = Math.max(BAND.nativeMinW, viewportWidth - gutter * 2);
  const pad = BAND.pad;
  const itemGap = mode === "overview" ? BAND.chipGap : BAND.tileGap;
  const rowGap = mode === "overview" ? BAND.chipGap : BAND.rowGap;
  const headerH = maxBandW < 600 ? BAND.header + 40 : BAND.header;
  /* Members are measured against the widest a band could be, then the band is
     narrowed to the row they actually occupied — measuring against a width that
     the band has not been given yet would wrap a row that fits. */
  const maxInnerW = maxBandW - pad * 2;
  const minBandW = Math.min(maxBandW, BAND.minBandW);
  const innerX0 = gutter + pad;
  const innerRight = gutter + maxBandW - pad;

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

  /* Every surface fits the band's inner width: a member wider than the band
     (a draft pane, a planned stage slot, a deck, a reader tile on a board the
     dock has narrowed) is scaled down uniformly, contents included, so no
     surface ever extends past the band that holds it. */
  const fitted = (w: number, h: number): { w: number; h: number; fit: number } => {
    const fit = w > maxInnerW ? maxInnerW / w : 1;
    return { w: w * fit, h: h * fit, fit };
  };
  /* A review-round deck that renders as its one-line verdict chip must reserve
     the chip's height, not the full deck box it would need expanded, or a
     collapsed review loop leaves a task frame almost entirely empty. Which decks
     are collapsed is the operator's actual disclosure state (the localStorage
     override plus the lifecycle default), passed in by SchemeBoard so a manual
     expand of a settled deck re-opens its full footprint; absent it (SSR, a
     pure test) the lifecycle default stands in. */
  const collapsedDecks = options.collapsedDecks
    ?? new Set(base.decks.filter((deck) => deckDisclosureTerminal(deck.flow)).map((deck) => deck.key));
  const deckKeyOfFlow = new Map(base.decks.map((deck) => [deck.flow.id, deck.key] as const));
  let cursorY = gutter;
  let emptyColumn = 0;
  const emptyColumns = Math.max(1, Math.floor((maxBandW + BAND.gap) / (minBandW + BAND.gap)));
  for (const band of bands) {
    const empty = !bandHoldsMembers(band);
    if (!empty && emptyColumn) { cursorY += headerH + BAND.gap; emptyColumn = 0; }
    const bandX = gutter + (empty ? emptyColumn * (minBandW + BAND.gap) : 0);
    const historyAvailable = bandHistoryAvailable(band, base);
    const historyCollapsed = historyAvailable && options.historyOverrides?.get(band.id) !== true && !bandContainsTarget(band, base, options.revealTarget ?? reader);
    const items: { key: string; w: number; h: number; fit?: number; kind: "member" | "mirror"; node?: SchemeNode }[] = [];
    for (const member of historyCollapsed ? [] : band.members) {
      if (member.kind === "node") {
        const node = base.nodes.find((entry) => entry.file.path === member.key)!;
        /* The selected conversation reads natively from the intermediate scale
           up: clicking a tile opens it in place, siblings stay tiles. */
        const presentation = mode === "overview" ? "chip" : member.key === reader ? "native" : "summary";
        const natural = fitted(
          presentation === "chip" ? BAND.chipW : presentation === "native" ? Math.max(BAND.nativeMinW, Math.min(BAND.nativeW, maxInnerW)) : BAND.summaryW,
          presentation === "chip" ? BAND.chipH : presentation === "native" ? BAND.nativeH : BAND.summaryH,
        );
        items.push({ key: member.key, w: natural.w, h: natural.h, kind: "member", node: { ...node, presentation, readerScale: natural.fit, w: natural.w, h: natural.h } });
        continue;
      }
      /* Decks, stacks and planned slots are thumbnails at overview scale:
         their content is unreadable there, so the band summarises them. */
      if (mode === "overview" && member.kind !== "draft") continue;
      const rect = baseRect.get(member.key);
      if (!rect) continue;
      const slot = member.kind === "slot" ? base.slots.find(slot => slot.key === member.key) : undefined;
      const surface = slot ? stageSurface(options.expandedStages?.has(member.key) ?? false) : rect;
      const shellH = member.kind === "deck" && collapsedDecks.has(member.key) ? BAND.collapsedDeckH : surface.h;
      const natural = fitted(surface.w, shellH);
      items.push({ key: member.key, w: natural.w, h: natural.h, fit: natural.fit, kind: "member" });
    }
    for (const mirror of historyCollapsed ? [] : band.mirrors) {
      const natural = fitted(mode === "overview" ? BAND.mirrorChipW : BAND.mirrorW, mode === "overview" ? BAND.chipH : BAND.mirrorH);
      items.push({ key: mirror.key, w: natural.w, h: natural.h, kind: "mirror" });
    }
    // Each container gets a dedicated heading before its members. A heading
    // never borrows the task title row or spans another container's cards.
    const groupHeadroom = band.groups.length * BOARD_SURFACE.groupHeader;
    const hasNative = items.some(item => item.node?.presentation === "native");
    const hasRole = band.members.some(member => member.kind === "deck" || (member.kind === "node" && (
      base.loops.some(loop => loop.flow.implementerPath === member.key)
      || base.groups.some(group => group.pipeline?.runs.some(run => run.attempts.some(attempt => attempt.agentPath === member.key)))
    )));
    const roleSpace = mode === "overview" ? 0 : hasNative ? 64 : hasRole ? BOARD_SURFACE.roleSpace : 0;
    const bodyTop = cursorY + headerH + groupHeadroom + (items.length ? roleSpace : 0);
    for (const [index, key] of band.groups.entries()) {
      containerSlots.set(key, { x: innerX0, y: cursorY + headerH + index * BOARD_SURFACE.groupHeader, w: Math.min(680, maxInnerW), h: BOARD_SURFACE.groupHeader });
      bandOf.set(key, band.id);
    }
    let x = innerX0;
    let y = bodyTop;
    let rowH = 0;
    let rows = items.length ? 1 : 0;
    /* Rightmost inked edge across every row, so the band can be trimmed to the
       content it actually holds instead of to the width it was measured in. */
    let contentRight = innerX0;
    for (const item of items) {
      if (x + item.w > innerRight + 0.001 && x > innerX0) {
        x = innerX0;
        y += rowH + rowGap + roleSpace;
        rowH = 0;
        rows += 1;
      }
      const rect: SchemeRect = { x, y, w: item.w, h: item.h, ...(item.fit !== undefined && item.fit !== 1 ? { fit: item.fit } : {}) };
      placed.set(item.key, rect);
      shown.add(item.key);
      bandOf.set(item.key, band.id);
      if (item.kind === "mirror") mirrorRects.set(item.key, rect);
      if (item.node) nodeRects.set(item.key, { ...item.node, x, y });
      contentRight = Math.max(contentRight, x + item.w);
      const reviewGap = base.loops.some(loop => loop.flow.implementerPath === item.key) ? FLOW_HUB.w + 16 : itemGap;
      x += item.w + Math.max(itemGap, reviewGap);
      rowH = Math.max(rowH, item.h);
    }
    let bandH = y - cursorY + rowH + (items.length ? BOARD_SURFACE.navigationSpace + pad : 0);
    if (mode === "overview") bandH = Math.max(bandH, BAND.minOverviewH);
    /* The band ends where its content ends. The floor keeps the header
       readable — title and header controls have dedicated rows — and the ceiling is the width it was measured in, so
       a band that filled its rows is exactly as wide as it was before. */
    const bandW = Math.min(maxBandW, Math.max(minBandW, contentRight + pad - gutter));
    const rect = { x: bandX, y: cursorY, w: bandW, h: bandH };
    const header = { x: bandX, y: cursorY, w: bandW, h: headerH };
    for (const key of band.groups) {
      const heading = containerSlots.get(key);
      if (heading) heading.w = bandW - pad * 2;
    }
    if (band.task) taskRects.set(`task::${band.task.id}`, header);
    placedBands.push({ ...band, geometry: { rect, header, rows, historyAvailable, historyCollapsed } });
    if (empty && emptyColumn + 1 < emptyColumns) emptyColumn += 1;
    else { cursorY += bandH + BAND.gap; emptyColumn = 0; }
  }

  const byPath = new Map<string, SchemeRect>(placed);
  for (const [key, rect] of taskRects) byPath.set(key, rect);
  for (const band of placedBands) byPath.set(`band::${band.id}`, band.geometry.rect);
  for (const [key, rect] of containerSlots) byPath.set(key, rect);

  const nodes = base.nodes.map((node) => nodeRects.get(node.file.path) ?? node);
  const recordedBandOf = new Map(bands.flatMap(band => band.members.map(member => [member.key, band.id] as const)));
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
    const fromBand = bandOf.get(edge.from) ?? recordedBandOf.get(edge.from);
    const toBand = bandOf.get(edge.to) ?? recordedBandOf.get(edge.to);
    if (fromBand && toBand && fromBand !== toBand) {
      for (const rep of representations.get(edge.from) ?? []) continue_(rep, { key: edge.to, bandId: toBand, direction: "to" });
      for (const rep of representations.get(edge.to) ?? []) continue_(rep, { key: edge.from, bandId: fromBand, direction: "from" });
      return [];
    }
    if (!from || !to) return [];
    const ports = bandEdgePorts(from, to);
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
  for (const link of base.links) {
    const fromBand = bandOf.get(link.from) ?? recordedBandOf.get(link.from);
    const toBand = bandOf.get(link.to) ?? recordedBandOf.get(link.to);
    if (!fromBand || !toBand || fromBand === toBand) continue;
    if (placed.has(link.from)) continue_(link.from, { key: link.to, bandId: toBand, direction: "to" });
    if (placed.has(link.to)) continue_(link.to, { key: link.from, bandId: fromBand, direction: "from" });
  }
  /* A container halo is a projection inside the band that owns it: it wraps
     the container's members placed in that band and the band's mirrors of its
     other members, never a surface placed in a different band. */
  const owner = new Map<string, string>();
  for (const band of placedBands) for (const key of band.groups) owner.set(key, band.id);
  const groups: SchemeGroup[] = base.groups.flatMap((group) => {
    if (group.kind === "task") return [];
    const bandId = owner.get(group.key);
    if (!bandId) return [];
    const band = placedBands.find((entry) => entry.id === bandId)!;
    const heading = containerSlots.get(group.key);
    const memberSet = new Set(group.members);
    const local = [...group.members.filter(key => placed.has(key) && bandOf.get(key) === bandId), ...band.mirrors.filter(mirror => memberSet.has(mirror.ofKey) && placed.has(mirror.key)).map(mirror => mirror.key)];
    return heading ? [{ ...group, ...heading, members: local, bandHeader: true, historical: band.geometry.historyAvailable }] : [];
  });
  const layout: SchemeLayout = {
    ...base,
    nodes,
    edges,
    groups,
    byPath,
    links: base.links.filter((link) => placed.has(link.from) && placed.has(link.to) && bandOf.get(link.from) === bandOf.get(link.to)),
    /* The review cycle is drawn between the implementer card and the reviewer
       deck AS THEY ARE PLACED — same-row side ports, or top/bottom ports when
       the deck wrapped to a later row — and routed around the other cards in
       the band, exactly like the lineage edges above. Carrying the routed path
       and both endpoints lets LoopsLayer draw the connector to the real cards
       instead of the fixed-offset arcs it used for a 780px side-by-side pair,
       which on a wrapped band stranded a squiggle in the empty space. */
    loops: base.loops.flatMap((loop) => {
      const implKey = loop.flow.implementerPath;
      const deckKey = deckKeyOfFlow.get(loop.flow.id);
      const impl = placed.get(implKey);
      const deckRect = deckKey ? placed.get(deckKey) : undefined;
      if (!impl || !deckRect || !deckKey) return [];
      const bandId = bandOf.get(implKey);
      if (!bandId || bandId !== bandOf.get(deckKey)) return [];
      const ports = bandEdgePorts(impl, deckRect);
      const others = rectsIn(bandId, [implKey, deckKey]);
      const route = routeTaskEdge(ports, others);
      return [{ ...loop, x1: ports.x1, y1: ports.y1, x2: ports.x2, y2: ports.y2, route: route.d, hub: hubOnRoute(route.d, others) }];
    }),
    stacks: base.stacks.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    decks: base.decks.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)!, bandSurface: true }] : [])),
    drafts: base.drafts.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)! }] : [])),
    slots: base.slots.flatMap((rect) => (placed.has(rect.key) ? [{ ...rect, ...placed.get(rect.key)!, detailsExpanded: options.expandedStages?.has(rect.key) ?? false, incoming: undefined }] : [])),
    regionTasks: [],
    width: viewportWidth,
    height: cursorY + (emptyColumn ? headerH + BAND.gap : 0) + gutter,
  };
  return { layout, bands: placedBands, shown, mode, taskRects, mirrorRects, bandOf, continuations: [...continuationByKey.values()] };
}
