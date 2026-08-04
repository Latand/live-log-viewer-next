"use client";

import { Crown, Filter, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { formatConversationHash, parseConversationHash, resolveConversationTarget, withoutArchivedPredecessors, type ConversationHash } from "@/lib/accounts/identity";
import { createTraversalFence, parseFocusHistoryState, recordFocusNavigation, recordProjectNavigation, retargetRecordedProject } from "@/lib/navigation/focusHistory";
import { onAccountPanelRequest } from "@/lib/accounts/openPanel";
import { useAgentChimes } from "@/hooks/useAgentChimes";
import { useArchivedProjects } from "@/hooks/useArchivedProjects";
import { useEffectiveFlows } from "@/components/flows/flowModel";
import { useFiles } from "@/hooks/useFiles";
import { publishConversationAvailability } from "@/lib/mcp/availability";
import { useBoardState } from "@/hooks/useBoardState";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewPresence } from "@/hooks/useViewPresence";
import { OVERVIEW_CONTEXT, OVERVIEW_SLICE, viewBus } from "@/hooks/viewPresenceBus";
import { projectDisplayName } from "@/lib/displayNames";
import { canonicalClientProject } from "@/lib/projects/clientAliases";
import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { attentionId, buildAttentionQueue, nextAttention, STALLED_ATTENTION_TTL, type AttentionItem } from "./attention";
import { AttentionHost } from "./attention/AttentionHost";
import { purgeLegacyOperatorCredential } from "./operatorCredential";
import { ArtifactPreviewHost } from "./preview/ArtifactPreviewHost";
import { VoiceBridgeRelayHost } from "./voice/VoiceBridgeRelayHost";
import { VoiceComposerHost } from "./voice/VoiceComposerHost";
import { VoicePipHost } from "./voice/VoicePipHost";
import { focusHandoffBus } from "./attention/focusHandoffBus";
import { ConnectionPill } from "./ConnectionPill";
import { resolveFavoriteRows, type FavoriteRow } from "./favorites/favoriteRows";
import { KeepAwakeProvider } from "./KeepAwakeControl";
import { OverviewBoard } from "./OverviewBoard";
import { ProjectDashboard, queueColumnOpen } from "./ProjectDashboard";
import { isChildConversation, OVERVIEW, projectKey } from "./projectModel";
import { ProjectRail } from "./ProjectRail";
import { DeploymentStatusPill } from "./runtime/DeploymentStatusPill";
import { StagingBadge } from "./StagingBadge";
import { activityDot, cleanTitle, fmtAge } from "./utils";

const PROJECT_KEY = "llvProject";

/** Reads the location hash into its conversation/file/project intent. Recognises
    the canonical `#c=<conversationId>` deep link alongside the legacy `#f=` /
    `#p=` forms (see parseConversationHash). */
function readHash(): ConversationHash {
  return parseConversationHash(location.hash);
}

export function initialProjectFromState(hash: string, storedProject: string | null): string {
  return parseConversationHash(hash).project ?? storedProject ?? OVERVIEW;
}

export function filesRequestPin(pendingHash: ConversationHash | null, retainedPath: string | null): string | null {
  return pendingHash?.filePath ?? pendingHash?.conversationId ?? retainedPath;
}

export type CatalogPinState = { path: string; hydrated: boolean; conversationId: string | null } | null;
export type CatalogPinEvent =
  | { kind: "open"; path: string; conversationId?: string }
  | { kind: "resolve"; path: string; conversationId?: string }
  | { kind: "release"; path?: string }
  | { kind: "files"; paths: ReadonlySet<string>; pending: boolean; currentPath?: string };

export function reduceCatalogPin(state: CatalogPinState, event: CatalogPinEvent): CatalogPinState {
  if (event.kind === "open") return { path: event.path, hydrated: false, conversationId: event.conversationId ?? null };
  if (event.kind === "resolve") return { path: event.path, hydrated: true, conversationId: event.conversationId ?? null };
  if (event.kind === "release") return !event.path || state?.path === event.path ? null : state;
  if (!state) return state;
  const current = event.currentPath && event.currentPath !== state.path ? { ...state, path: event.currentPath } : state;
  if (current.hydrated && !event.pending && !event.paths.has(current.path)) return null;
  return current;
}

/** The URL a project selection lands on: the project hash, or the bare route
    for the overview. History semantics (push over a focused-card entry, replace
    otherwise) live in `recordProjectNavigation`. */
function projectUrl(project: string): string {
  return project !== OVERVIEW ? "#p=" + encodeURIComponent(project) : location.pathname;
}

/** How long a Back/Forward replay waits for its pinned poll to resolve the
    target before it reports the entry stale (issue #866): a few poll rounds,
    then the intent clears so later history actions stay usable. */
const STALE_FOCUS_REPLAY_MS = 8_000;

/** How long the stale-entry notice stays up before it dismisses itself. */
const STALE_FOCUS_NOTICE_MS = 6_000;

/** One-line reason a queue item waits: question header, screen tail, or the stalled wording. */
function attentionSnippet(t: TFunction, item: AttentionItem): string {
  const q = item.file.pendingQuestion;
  if (q) {
    if (q.kind === "plan") return t("status.awaitingPlan");
    const first = q.questions?.[0];
    return first?.header || first?.question.split("\n")[0] || t("status.awaitingAnswer");
  }
  if (item.file.rateLimit) return t("status.rateLimited");
  const w = item.file.waitingInput;
  if (w) return w.menu?.question.split("\n")[0] || w.screenTail || t("status.awaitingTerminal");
  return t("status.stalled");
}

export function Viewer() {
  const { t } = useLocale();
  /* There is no operator credential to claim: same-origin IS the operator (see
     `operatorAuthority`), and no key, secret, cookie or paste exists anywhere in
     this app. This only erases what earlier rounds left on disk — a stored bearer,
     a stale startup fragment. */
  purgeLegacyOperatorCredential();
  /* The one presence publisher for the whole app: it reads the shared view bus
     that the board/scheme/mobile components report into and ships an ephemeral
     per-tab snapshot to the server. Renders nothing. */
  useViewPresence();
  /* URL fragments and localStorage do not exist in the server render. Start
     from the same Overview shell on both sides, then apply the saved/hash
     project in the mount effect below so hydration never discards the tree. */
  const [project, setProject] = useState<string>(OVERVIEW);
  const [pendingHash, setPendingHash] = useState<ConversationHash | null>(null);
  const [catalogPin, dispatchCatalogPin] = useReducer(reduceCatalogPin, null);
  const { files: allFiles, requestScope, projectCatalog, projectAliases, projectDisplayNames, projectCwds, flows: polledFlows, pipelines, pipelinesError, workflows, tasks, conversationAliases, launchRoutes, loaded, catalogFailures } = useFiles(null, filesRequestPin(pendingHash, catalogPin?.path ?? null));
  /* A committed account migration keeps the archived predecessor entry in the
     payload (for chain history) but it must never render as a second standalone
     card — every surface below sees only current generations. A no-op (same
     array identity) until something actually migrates. */
  const files = useMemo(() => withoutArchivedPredecessors(allFiles), [allFiles]);
  const dashboardFilesRef = useRef<{ project: string; files: FileEntry[] } | null>(null);
  const dashboardFiles = useMemo(() => {
    if (project === OVERVIEW) return [];
    const selected = files.filter((file) => projectKey(file) === project);
    const previous = dashboardFilesRef.current;
    const stable = previous?.project === project
      && previous.files.length === selected.length
      && selected.every((file, index) => file === previous.files[index])
      ? previous.files
      : selected;
    dashboardFilesRef.current = { project, files: stable };
    return stable;
  }, [files, project]);
  useEffect(() => {
    publishConversationAvailability(new Set(allFiles.flatMap((file) => file.conversationId ? [file.conversationId] : [])));
  }, [allFiles]);
  /* This tab's optimistic flow closes apply before anything renders: the X
     on a flow strip clears the reviewer side of the scheme instantly. */
  const flows = useEffectiveFlows(polledFlows);
  useAgentChimes(files, requestScope);
  const { archivedProjects, archiveProject, unarchiveProject } = useArchivedProjects(files, projectAliases);
  const catalogProjects = useMemo(() => new Set(projectCatalog.map((entry) => entry.project)), [projectCatalog]);
  const catalogConversationCounts = useMemo(
    () => new Map(projectCatalog.map((entry) => [entry.project, entry.conversations])),
    [projectCatalog],
  );
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toastPath, setToastPath] = useState<string | null>(null);
  const seenQuestionsRef = useRef<Set<string> | null>(null);
  /* Reopening a file whose project is already selected does not change
     `project`, so ProjectDashboard would never remount or re-read prefs.
     Bumping this on every same-project open gives it an explicit signal. */
  const [openNonce, setOpenNonce] = useState(0);
  /* The jump channel into the board: nonce so repeated jumps to the same node
     re-flash (D9); consumed by ProjectDashboard's pendingFocusRef path. */
  const [focusRequest, setFocusRequest] = useState<{ path: string; nonce: number; catalog: boolean } | null>(null);
  /* Placement without navigation — see `placePath` below. Its own state and its
     own nonce, so a place and a focus can never consume each other's edge. */
  const [placeRequest, setPlaceRequest] = useState<{ path: string; nonce: number } | null>(null);
  /* A Back/Forward replay whose target never resolved (issue #866): the entry
     is stale — deleted, purged, or beyond this machine. Fails visibly, then the
     rest of the history stays usable. */
  const [staleFocusNotice, setStaleFocusNotice] = useState(false);
  /* Mirrors for the popstate replay path, which must read the latest values
     from stable event listeners without re-registering them per poll. */
  const filesRef = useRef<FileEntry[]>([]);
  const pendingHashRef = useRef<ConversationHash | null>(null);
  const staleTimerRef = useRef<number | null>(null);
  /* One history traversal fires `popstate` first, then `hashchange`. When the
     popstate half already replayed a typed focus entry, the hashchange half of
     that SAME traversal must not re-derive a weaker intent from the bare hash.
     Keyed to the traversal's target hash and self-clearing, so a same-URL
     multi-entry jump (which fires no hashchange) cannot leave a stale arm that
     swallows the next genuine hashchange — see `createTraversalFence`. */
  const traversalFenceRef = useRef(createTraversalFence());
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    pendingHashRef.current = pendingHash;
  }, [pendingHash]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const initial = readHash();
    if (initial.filePath || initial.conversationId) setPendingHash(initial);
    const savedProject = initial.project ?? localStorage.getItem(PROJECT_KEY);
    if (savedProject) setProject(savedProject);
  }, []);

  useEffect(() => {
    const canonical = canonicalClientProject(project, projectAliases);
    if (canonical === project) return;
    setProject(canonical);
    localStorage.setItem(PROJECT_KEY, canonical);
    /* A rename, not a navigation: a typed focus entry keeps its place in the
       history stack and only re-labels its stored project. */
    retargetRecordedProject(canonical, projectUrl(canonical));
  }, [project, projectAliases]);

  useEffect(() => {
    const onHash = () => {
      /* The popstate half of this same traversal already replayed a typed
         focus entry with its full stored identity; deriving a second, weaker
         intent from the bare hash would drop the project and path support. */
      if (traversalFenceRef.current.swallows(location.hash)) return;
      const next = readHash();
      if (next.filePath || next.conversationId) {
        dispatchCatalogPin({ kind: "release" });
        setFocusRequest(null);
        setPendingHash(next);
      }
      else {
        /* Navigation moved off the conversation link: the old target must
           stop pinning polls and must not open later out of nowhere. */
        setPendingHash(null);
        dispatchCatalogPin({ kind: "release" });
        setFocusRequest(null);
        if (next.project) setProject(next.project);
        /* Back cleared the hash entirely: that entry was the overview. */
        else if (!location.hash) setProject(OVERVIEW);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* Browser/mouse Back and Forward (issue #866): a typed entry replays through
     the SAME bounded resolver a live deep link uses — pendingHash pins the
     target into the ongoing poll, `resolveConversationTarget` resolves by
     stable conversation id (aliases, migrations, launch routes included), and
     `openPinnedFile` moves the existing camera. No reload, no route remount,
     no board rebuild, no snapshot: this handler only sets the two states the
     hashchange path already sets. Untyped entries fall through to it. */
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const entry = parseFocusHistoryState(event.state);
      if (!entry) return;
      /* The browser has already applied this traversal's URL, so the fragment
         read here is exactly the hash whose follow-up hashchange must skip. */
      traversalFenceRef.current.arm(location.hash);
      dispatchCatalogPin({ kind: "release" });
      setFocusRequest(null);
      /* Cross-project entries select the stored project first, then resolve. */
      setProject(entry.project);
      localStorage.setItem(PROJECT_KEY, entry.project);
      const intent: ConversationHash = entry.conversationId
        ? { conversationId: entry.conversationId, filePath: null, project: entry.project }
        : { conversationId: null, filePath: entry.path, project: entry.project };
      setPendingHash(intent);
      /* A replay target the polls cannot produce is stale: report it and free
         the stack instead of pinning a dead intent forever. */
      if (staleTimerRef.current !== null) window.clearTimeout(staleTimerRef.current);
      staleTimerRef.current = window.setTimeout(() => {
        staleTimerRef.current = null;
        const pending = pendingHashRef.current;
        if (!pending) return;
        if ((pending.conversationId ?? pending.filePath) !== (intent.conversationId ?? intent.filePath)) return;
        setPendingHash(null);
        dispatchCatalogPin({ kind: "release" });
        setStaleFocusNotice(true);
      }, STALE_FOCUS_REPLAY_MS);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (staleTimerRef.current !== null) window.clearTimeout(staleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!staleFocusNotice) return;
    const timer = window.setTimeout(() => setStaleFocusNotice(false), STALE_FOCUS_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [staleFocusNotice]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* The state half of a project selection, shared by routes that write their
     own history entry (a card focus records `#c=`, which already names the
     project) and routes that record a plain project navigation. */
  const applyProject = useCallback((nextProject: string) => {
    setProject(nextProject);
    /* Explicit project navigation replaces the hash without a hashchange
       event, so any unresolved conversation intent is cancelled here. */
    setPendingHash(null);
    dispatchCatalogPin({ kind: "release" });
    setFocusRequest(null);
    localStorage.setItem(PROJECT_KEY, nextProject);
    setDrawerOpen(false);
  }, []);

  const selectProject = useCallback((nextProject: string) => {
    applyProject(nextProject);
    recordProjectNavigation(projectUrl(nextProject));
  }, [applyProject]);

  /* The overview board has no project view state to report: presence publishes
     the overview context/slice here, and ProjectDashboard takes over the moment
     a project opens. */
  useEffect(() => {
    if (project !== OVERVIEW) return;
    viewBus.reportContext(OVERVIEW_CONTEXT);
    viewBus.reportSlice(OVERVIEW_SLICE);
  }, [project]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // A tapped account badge (issue #229) opens the accounts surface. On mobile
  // the limits footer lives inside the project drawer, so the drawer must open
  // first; its per-engine block then claims the retained request on mount.
  useEffect(() => {
    if (!isMobile) return;
    return onAccountPanelRequest(() => setDrawerOpen(true));
  }, [isMobile]);

  /* A file open (overview card, deep link) becomes a column of its project.
     One deliberate gesture, one typed history entry: the card focus record
     carries the project, so no separate project entry is written. */
  const openFile = useCallback(
    (file: FileEntry) => {
      const key = projectKey(file);
      queueColumnOpen(key, file.path, isChildConversation(file));
      applyProject(key);
      recordFocusNavigation(file, key);
      setOpenNonce((value) => value + 1);
    },
    [applyProject],
  );

  /* Full-catalog list/search rows can sit beyond the scheme window. Their path
     stays pinned for the displayed conversation so recurring polls preserve
     the node after the transient hash intent resolves. */
  const openPinnedFile = useCallback((file: FileEntry, hydrated = false) => {
    const key = projectKey(file);
    queueColumnOpen(key, file.path, isChildConversation(file));
    dispatchCatalogPin({ kind: hydrated ? "resolve" : "open", path: file.path, conversationId: file.conversationId });
    setProject(key);
    localStorage.setItem(PROJECT_KEY, key);
    setDrawerOpen(false);
    setOpenNonce((value) => value + 1);
    setFocusRequest((previous) => ({ path: file.path, nonce: (previous?.nonce ?? 0) + 1, catalog: true }));
    /* A hydrated open is the RESOLVER arriving (deep link, hashchange,
       popstate replay): it re-types the entry the tab is standing on and never
       pushes, so initial restoration adds no duplicate and a replay cannot
       loop. A direct catalog click records the deliberate navigation. */
    recordFocusNavigation(file, key, { restore: hydrated });
  }, []);

  const openCatalogFile = useCallback((file: FileEntry) => {
    openPinnedFile(file);
    const hash = formatConversationHash(file);
    setPendingHash(parseConversationHash(hash));
  }, [openPinnedFile]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingHash || allFiles.length === 0) return;
    /* Resolves against the UNFILTERED payload (finding 6): a legacy `#f=` path
       may point at an archived predecessor, which `withoutArchivedPredecessors`
       has already folded out of `files`. Resolving against `allFiles` keeps that
       predecessor visible long enough to redirect the link to its current
       generation; the canonical `#c=` id resolves the same way. */
    const hit = resolveConversationTarget(allFiles, pendingHash, conversationAliases, launchRoutes);
    /* A miss keeps the request pending: the pinned `path` param asks the
       scanner to include the exact transcript on the next poll, so a fresh
       `#f=` link to a demoted archived predecessor resolves once that poll
       lands instead of being cleared after the first cap-limited payload. */
    if (hit) {
      openPinnedFile(hit, true);
      setPendingHash(null);
    }
  }, [pendingHash, allFiles, conversationAliases, launchRoutes, openPinnedFile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const releaseCatalogFile = useCallback((path: string) => {
    dispatchCatalogPin({ kind: "release", path });
    setFocusRequest((current) => current?.path === path ? null : current);
    if (catalogPin?.path === path) recordProjectNavigation(projectUrl(project));
  }, [catalogPin, project]);

  useEffect(() => {
    if (!catalogPin?.hydrated || pendingHash) return;
    const currentPath = catalogPin.conversationId
      ? files.find((file) => file.conversationId === catalogPin.conversationId)?.path
      : undefined;
    dispatchCatalogPin({
      kind: "files",
      paths: new Set(allFiles.map((file) => file.path)),
      pending: false,
      currentPath,
    });
  }, [catalogPin, pendingHash, allFiles, files]);

  /* The one queue every counter shows: badge, popover and the tab title all
     read the same list, stalled tail included (D10). The clock advances when
     the oldest stalled entry crosses its 2h TTL: useFiles keeps the array
     identity while the /api/files body is unchanged, so without this tick an
     expired stalled item would sit in the badge until an unrelated change. */
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const queue = useMemo(() => buildAttentionQueue(files, clock), [files, clock]);
  useEffect(() => {
    const expiries = files
      .filter((file) => file.activity === "stalled")
      .map((file) => file.mtime + STALLED_ATTENTION_TTL)
      .filter((at) => at > clock);
    if (!expiries.length) return;
    const delay = Math.max(0, (Math.min(...expiries) - Date.now() / 1000) * 1000) + 500;
    const timer = window.setTimeout(() => setClock(Date.now() / 1000), delay);
    return () => window.clearTimeout(timer);
  }, [files, clock]);
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement | null>(null);

  /* Crown favorites pinned atop the «Чекають» popover (issue #224): the same
     durable board prefs the dashboard reads, scoped to the current project so
     the section mirrors the pinned scheme row. The overview has no board, so it
     lists nothing. */
  const favoritesBoard = useBoardState(project === OVERVIEW ? null : project);
  const favoriteRows = useMemo(
    () => (project === OVERVIEW ? [] : resolveFavoriteRows(files, favoritesBoard.prefs.favorites).filter((row) => row.project === project)),
    [files, favoritesBoard.prefs.favorites, project],
  );

  useEffect(() => {
    document.title = queue.length ? `(${queue.length}) Agent Log Viewer` : "Agent Log Viewer";
  }, [queue.length]);

  useEffect(() => {
    if (!queueOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!queueRef.current?.contains(event.target as Node)) setQueueOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [queueOpen]);

  /* «Show only needs me» filter: React-only state that auto-disables when the
     queue empties — a filter surviving reload would silently gray the whole
     board (D6). The popover follows the same emptiness rule. Desktop-only,
     like the F key: the mobile strip and map render without the dimming
     channel, so the funnel stays hidden there and the state clears if the
     viewport shrinks into the phone layout mid-session. */
  const [attentionFilter, setAttentionFilter] = useState(false);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isMobile) setAttentionFilter(false);
  }, [isMobile]);
  useEffect(() => {
    if (queue.length) return;
    setQueueOpen(false);
    setAttentionFilter(false);
  }, [queue.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const cancelPendingIntent = useCallback(() => setPendingHash(null), []);
  const requestFocus = useCallback((path: string) => {
    /* A user-driven focus (N/Shift-N cycle, attention jump) supersedes any
       unresolved deep-link intent; a stale pin must never re-steal focus when
       its target shows up in a later poll. */
    setPendingHash(null);
    /* Every route through here is a deliberate focus (attention jump, crown
       favorite, N-cycle, an accepted handoff's `openPath`): record it. A path
       with no scanned entry still navigates, it just leaves no history. */
    const file = filesRef.current.find((entry) => entry.path === path);
    if (file) recordFocusNavigation(file, projectKey(file));
    setFocusRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1, catalog: false }));
  }, []);

  /* Reveal a card without going to it. `requestFocus` above both materializes
     the node and arms the board's glide; a focus handoff wants only the first,
     because it frames its own destination at its own zoom through the board
     controller. Asking through `requestFocus` gave the handoff a competing
     camera move it then had to race. */
  const placeOnBoard = useCallback((path: string) => {
    setPlaceRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* The history-recording half of `requestFocus` without the glide half: an
     `intent: "open"` handoff and a camera-exact Return both frame their own
     destination through the board controller, so what they still owe is the
     card in the layout and the typed history entry — never a second, competing
     camera move (#873 review). */
  const openPathQuiet = useCallback((path: string) => {
    setPendingHash(null);
    const file = filesRef.current.find((entry) => entry.path === path);
    if (file) recordFocusNavigation(file, projectKey(file));
    setPlaceRequest((prev) => ({ path, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* #688: the shell half of a focus handoff. An accepted request opens the
     project it lives in and, when its intent is `open`, the conversation
     itself — the same hand-off an attention jump already uses, so a handoff and
     a tap can never land differently. The board half registers in SchemeBoard. */
  useEffect(() => focusHandoffBus.setShell({
    project: project === OVERVIEW ? null : project,
    openProject: selectProject,
    openPath: requestFocus,
    placePath: placeOnBoard,
    openPathQuiet,
    /* The overview is a project selection like any other here — it just is not
       a project. `selectProject` already speaks the sentinel; the bus should
       not have to. */
    openOverview: () => selectProject(OVERVIEW),
    /* One gesture, one entry: the quiet project half plus the recording focus
       half (`requestFocus` writes the typed entry, which stores the project). */
    openConversation: (targetProject, path) => {
      if (targetProject && targetProject !== project) applyProject(targetProject);
      if (path) requestFocus(path);
    },
    /* The typed entry a VERIFIED attention arrival owes (#866 production
       regression) — record only, no placement and no camera. Identity comes
       from the scanned entry when the poll has it; a path the polls have not
       produced yet still records by bounded path identity, so Back after a
       `show` handoff stays inside the document. The operator was moved, so a
       still-unresolved deep-link intent must not re-steal the camera later —
       the same rule `requestFocus` applies. */
    recordFocusArrival: (path, targetProject) => {
      setPendingHash(null);
      const file = filesRef.current.find((entry) => entry.path === path);
      if (file) recordFocusNavigation(file, projectKey(file));
      else recordFocusNavigation({ path }, targetProject);
    },
  }), [project, selectProject, requestFocus, placeOnBoard, openPathQuiet, applyProject]);

  /* The N-cycle position anchors to an id: an item answered elsewhere drops
     out without moving the pointer's neighbors (D12). */
  const cycleRef = useRef<string | null>(null);

  /* Membership key first, Set second: polls rebuild the queue array, but the
     set identity only moves when membership does, so the memoized node layers
     never re-render for an unchanged filter (D6). */
  const attentionKey = useMemo(() => queue.map((item) => item.file.path).sort().join("\n"), [queue]);
  const attentionPaths = useMemo<ReadonlySet<string> | null>(
    () => (attentionFilter ? new Set(attentionKey.split("\n").filter(Boolean)) : null),
    [attentionFilter, attentionKey],
  );

  /* N never leaves the current project (D4): the same items and order
     buildAttentionQueue(files, now, project) yields, taken off the global memo. */
  const projectQueue = useMemo(
    () => (project === OVERVIEW ? [] : queue.filter((item) => item.project === project)),
    [queue, project],
  );

  useEffect(() => {
    /* N and F are desktop keys (D4/D6): the phone layout renders without the
       scheme dimming channel, and a hardware keyboard there must never drive
       hidden filter state or focus jumps. */
    if (isMobile) return;
    /* Same guard as useSchemeCamera: hotkeys stay quiet while a composer or
       any form control is focused. */
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(el.tagName) || el.isContentEditable;
    };
    const onDown = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "n" || event.key === "N") {
        const next = nextAttention(projectQueue, cycleRef.current, event.shiftKey ? -1 : 1);
        if (!next) return;
        event.preventDefault();
        cycleRef.current = next.id;
        requestFocus(next.file.path);
      } else if (event.key === "f" || event.key === "F") {
        if (!queue.length) return;
        event.preventDefault();
        setAttentionFilter((value) => !value);
      }
    };
    window.addEventListener("keydown", onDown);
    return () => window.removeEventListener("keydown", onDown);
  }, [isMobile, projectQueue, queue.length, requestFocus]);

  /* A popover click is a deliberate act, so unlike the N hotkey it may switch
     the project; the focus hand-off glides the board to the node. */
  const jumpToItem = useCallback(
    (item: AttentionItem) => {
      setQueueOpen(false);
      /* One gesture, one history entry: the focus record below names the
         project, so the switch itself writes nothing. */
      if (item.project !== project) applyProject(item.project);
      cycleRef.current = item.id;
      requestFocus(item.file.path);
    },
    [project, applyProject, requestFocus],
  );

  /* A crowned row in the popover focuses its conversation, switching project
     first if the favorite lives elsewhere — same hand-off as an attention jump. */
  const openFavorite = useCallback(
    (row: FavoriteRow) => {
      setQueueOpen(false);
      if (row.project !== project) applyProject(row.project);
      requestFocus(row.file.path);
    },
    [project, applyProject, requestFocus],
  );

  useEffect(() => {
    /* Toast fires on hard-blocked signals only — a stalled id must never enter
       this seen-set, so the guard narrows before the shared derivation. */
    const ids = files
      .map((file) => ({
        file,
        id: file.pendingQuestion || file.rateLimit || file.waitingInput ? attentionId(file) : null,
      }))
      .filter((item): item is { file: FileEntry; id: string } => item.id !== null);
    if (seenQuestionsRef.current === null) {
      seenQuestionsRef.current = new Set(ids.map((item) => item.id));
      return;
    }
    const next = ids.find((item) => !seenQuestionsRef.current!.has(item.id));
    for (const item of ids) seenQuestionsRef.current.add(item.id);
    if (next) queueMicrotask(() => setToastPath(next.file.path));
  }, [files]);

  const toastFile = toastPath ? files.find((file) => file.path === toastPath) : null;

  /* Desktop keeps the badge in the fixed top-right anchor; the phone embeds
     this same node into the board header row, where it cannot cover the
     header's own buttons. The queue popover then drops as a full-width sheet
     under the header instead of hanging off the pill. */
  const attentionBadge = queue.length ? (
    <div ref={queueRef} className="pointer-events-auto relative">
      <div className="flex items-center overflow-hidden rounded-full border border-warning/45 bg-warning-soft shadow-1">
        <button
          type="button"
          className={`text-[12px] font-bold text-warning hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
            isMobile ? "inline-flex min-h-11 items-center px-3.5" : "px-3 py-1"
          }`}
          aria-expanded={queueOpen}
          aria-label={t("attention.badge", { count: queue.length })}
          title={t("attention.openQueue")}
          onClick={() => setQueueOpen((value) => !value)}
        >
          {isMobile ? (
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="h-3 w-3" aria-hidden /> {queue.length}
            </span>
          ) : (
            t("attention.badge", { count: queue.length })
          )}
        </button>
        {isMobile ? null : (
          <>
            <div className="h-4 w-px shrink-0 bg-warning/45" aria-hidden />
            <button
              type="button"
              className={`px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
                attentionFilter ? "bg-warning/30 text-warning" : "text-warning/70 hover:bg-warning/15 hover:text-warning"
              }`}
              aria-pressed={attentionFilter}
              title={attentionFilter ? t("attention.filterOff") : t("attention.filterOn")}
              aria-label={attentionFilter ? t("attention.filterOff") : t("attention.filterOn")}
              onClick={() => setAttentionFilter((value) => !value)}
            >
              <Filter className="h-3.5 w-3.5" aria-hidden />
            </button>
          </>
        )}
      </div>
      {queueOpen ? (
        <div
          className={`${
            isMobile ? "fixed inset-x-3 top-12" : "absolute right-0 top-[calc(100%+6px)] w-[340px] max-w-[calc(100vw-2rem)]"
          } z-50 max-h-[60vh] overflow-y-auto rounded-[10px] border border-border bg-card p-1.5 shadow-1`}
        >
          {/* Crowned conversations pinned at the top, mirroring the scheme's
              favorites row (issue #224). */}
          {favoriteRows.length ? (
            <div className="mb-1 border-b border-border pb-1">
              <div className="flex items-center gap-1 px-2.5 pb-0.5 pt-1.5 text-label font-semibold text-secondary">
                <Crown className="h-3 w-3 fill-crown text-crown" aria-hidden />
                {t("favorites.sectionTitle")}
              </div>
              {favoriteRows.map((row) => (
                <div key={row.id} className="flex items-center gap-1 rounded-[8px] hover:bg-canvas">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[8px] px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    title={t("favorites.focusTitle", { title: cleanTitle(row.file.title, 60) })}
                    onClick={() => openFavorite(row)}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(row.file.activity)}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">
                      {cleanTitle(row.file.title, 90)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-crown hover:bg-crown-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    aria-label={t("branch.unfavorite")}
                    title={t("branch.unfavorite")}
                    onClick={() => favoritesBoard.setFavorite(row.id, false)}
                  >
                    <Crown className="h-3.5 w-3.5 fill-crown" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="px-2.5 pb-1 pt-1.5 text-label font-semibold text-secondary">
            {t("attention.popoverTitle")}
          </div>
          {queue.map((item) => (
            <button
              key={item.id}
              type="button"
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => jumpToItem(item)}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">
                  {cleanTitle(item.file.title, 90)}
                </span>
                <span className="shrink-0 rounded-full border border-border bg-canvas px-1.5 text-[10px] font-semibold text-muted" title={item.project}>
                  {projectDisplayName(item.project, item.file.projectName)}
                </span>
                <span className="shrink-0 text-[10.5px] text-muted">{fmtAge(item.since)}</span>
              </span>
              <span className={`w-full truncate text-[11px] ${item.tier === "stalled" ? "text-warning" : "text-muted"}`}>
                {attentionSnippet(t, item)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  ) : null;

  const shell = (
    <div className="flex h-full">
      {isMobile ? null : (
        <ProjectRail files={files} projectCatalog={projectCatalog} projectDisplayNames={projectDisplayNames} pipelines={pipelines} workflows={workflows} archivedProjects={archivedProjects} selected={project} now={clock} loaded={loaded} catalogFailures={catalogFailures} onSelect={selectProject} />
      )}
      {isMobile && drawerOpen ? (
        <div className="fixed inset-0 z-50 flex">
          <ProjectRail files={files} projectCatalog={projectCatalog} projectDisplayNames={projectDisplayNames} pipelines={pipelines} workflows={workflows} archivedProjects={archivedProjects} selected={project} now={clock} loaded={loaded} catalogFailures={catalogFailures} onSelect={selectProject} />
          <button
            type="button"
            className="min-w-0 flex-1 bg-primary/35"
            aria-label={t("viewer.closeProjects")}
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Desktop: the corner attention anchor — the badge pill sits where the
            toast appears, so a new toast visually docks into it (D7). On the
            phone the badge lives in the board header and the toast docks in flow
            below (see the mobile banner), so this fixed anchor is desktop-only. */}
        {isMobile ? null : (
          <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
            {attentionBadge}
            {toastFile ? (
              <div className="pointer-events-auto flex max-w-[360px] gap-2 rounded-[8px] border border-warning/45 bg-warning-soft px-4 py-3 text-[13px] font-semibold text-primary shadow-1">
                <button
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  onClick={() => {
                    openFile(toastFile);
                    setToastPath(null);
                  }}
                >
                  <span className="block text-[11px] font-bold text-warning">{t("viewer.agentWaiting")}</span>
                  <span className="line-clamp-2">{toastFile.title}</span>
                </button>
                <button
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  aria-label={t("viewer.closeNotification")}
                  onClick={() => setToastPath(null)}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            ) : null}
          </div>
        )}
        {/* Mobile (finding 3): the agent-waiting notification docks as an in-flow
            banner above the board instead of a fixed overlay, so it reserves its
            own space and never covers the toolbar. Its open target and 44px close
            are both full tap-height. */}
        {isMobile && toastFile ? (
          <div className="flex shrink-0 items-stretch gap-2 border-b border-warning/45 bg-warning-soft pl-3 pr-1.5 py-1.5">
            <button
              className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => {
                openFile(toastFile);
                setToastPath(null);
              }}
            >
              <span className="block text-[11px] font-bold text-warning">{t("viewer.agentWaiting")}</span>
              <span className="truncate text-[13px] font-semibold text-primary">{toastFile.title}</span>
            </button>
            <button
              className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label={t("viewer.closeNotification")}
              onClick={() => setToastPath(null)}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        ) : null}
        {project === OVERVIEW ? (
          <OverviewBoard
            files={files}
            projectCatalog={projectCatalog}
            projectDisplayNames={projectDisplayNames}
            pipelines={pipelines}
            workflows={workflows}
            archivedProjects={archivedProjects}
            now={clock}
            catalogFailures={catalogFailures}
            onSelectProject={selectProject}
            onSelectFile={openFile}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
            attention={isMobile ? attentionBadge : undefined}
          />
        ) : (
          <ProjectDashboard
            files={dashboardFiles}
            flows={flows}
            pipelines={pipelines}
            pipelinesError={pipelinesError}
            workflows={workflows}
            tasks={tasks}
            conversationAliases={conversationAliases}
            projectCatalog={projectCatalog}
            projectName={projectDisplayNames[project]}
            projectCwd={projectCwds[project]}
            project={project}
            loaded={loaded}
            catalogFailures={catalogFailures}
            openNonce={openNonce}
            focusRequest={focusRequest?.catalog && catalogPin?.path !== focusRequest.path ? null : focusRequest}
            placeRequest={placeRequest}
            attentionPaths={attentionPaths}
            archived={archivedProjects.has(project)}
            catalogKnown={catalogProjects.has(project)}
            catalogConversationCount={catalogConversationCounts.get(project) ?? 0}
            onArchive={archiveProject}
            onUnarchive={unarchiveProject}
            onMenu={isMobile ? () => setDrawerOpen(true) : undefined}
            attention={isMobile ? attentionBadge : undefined}
            onUserNavigate={cancelPendingIntent}
            onOpenCatalogFile={openCatalogFile}
            onCloseFile={releaseCatalogFile}
          />
        )}
      </main>
      {/* Runtime connection pill — mounts the tab-wide bus and shows live /
          reconnecting / degraded / offline. Renders nothing while slice-one is
          disabled, so on the landing page it is inert. Docked bottom-left, clear
          of the bottom-right CornerStatus and the top-right attention anchor. */}
      {isMobile ? null : <ConnectionPill />}
      <DeploymentStatusPill />
      {/* #688: polls the attention record for this device and renders the
          root agent's focus handoff when there is one to answer. Renders
          nothing at all the rest of the time. */}
      <AttentionHost mobile={isMobile} />
      {/* #875: the ONE document preview surface. Transcript artifact links
          publish to its bus from anywhere in the feed; it renders nothing until
          one opens, and its state is pure same-document React state — no hash,
          no history entry, no snapshot. */}
      <ArtifactPreviewHost mobile={isMobile} />
      {/* #691: the ONE voice conversation panel, portalled into the card's dock
          slot or the floating PiP window. Mounted here rather than in the card
          because the card unmounts on board navigation while the call keeps
          running. Renders nothing until a call starts. */}
      <VoicePipHost mobile={isMobile} />
      {/* #691 §4: the manager→call report relay, on its own mount because its
          lifetime is the call's, never the floating window's. */}
      <VoiceBridgeRelayHost />
      {/* #691 hoist: the owner of every conversation card's composer machinery.
          Cards publish a place; the composer's lifetimes (dictation, attachment
          object URLs, outbox) live here and survive the card unmounting mid-call. */}
      <VoiceComposerHost />
      {/* Staging instances (#659) announce themselves on every device; prod
          renders nothing. Top-center, clear of both corner anchors. */}
      <StagingBadge />
      {/* A Back/Forward entry whose conversation no longer resolves (issue
          #866): says so and self-dismisses; the surrounding history keeps
          working. Below the staging badge's anchor so the two never overlap. */}
      {staleFocusNotice ? (
        <div className="pointer-events-none fixed left-1/2 top-10 z-40 -translate-x-1/2" role="status" data-stale-focus-notice>
          <div className="rounded-full border border-warning/45 bg-warning-soft px-3.5 py-1.5 text-[12px] font-semibold text-warning shadow-1 backdrop-blur">
            {t("viewer.staleFocusEntry")}
          </div>
        </div>
      ) : null}
    </div>
  );

  /* The app's ONE screen wake-lock owner (issue #712). It wraps the shell rather
     than living inside it so the mobile header's «Keep screen awake» row — which
     unmounts every time the «⋯» menu closes — reads a controller that outlives
     the menu. `shell` is built above, so a status change re-renders this provider
     and its context consumers only, never the board. */
  return <KeepAwakeProvider>{shell}</KeepAwakeProvider>;
}
