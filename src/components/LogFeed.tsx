"use client";

import { ArrowDownToLine, CornerDownRight, type LucideIcon, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ChevronUp, Sparkle } from "@/components/icons";
import { useRuntimeSessionForConversation } from "@/hooks/useRuntime";
import { useToolActivityCues } from "@/hooks/useToolActivityCues";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { conversationIdentity, isLaunchPlaceholder } from "@/lib/accounts/identity";
import { activeCardMigration, cardMigrationState, migrationHoldsDelivery, migrationTargetName } from "@/lib/accounts/migration";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { isAwaitingUser } from "@/hooks/useSwitchboardData";

import { LaunchChips } from "./conversation/LaunchChips";
import { LiveTurnRows } from "./conversation/LiveTurnRows";
import { OutboxBubbles } from "./conversation/OutboxBubbles";
import {
  adoptCanonicalAssistantClaims,
  publishCanonicalAssistantClaims,
  useCanonicalAssistantClaims,
  visibleRuntimeLiveTurnItems,
} from "./conversation/liveTurnHandoff";
import { orderedConversationTail } from "./conversation/tailOrder";
import {
  publishTranscriptEchoes,
  retireLaunchOutboxOnAdoption,
  seedLaunchOutbox,
  settleLaunchOutboxDelivered,
  settleLaunchOutboxFailed,
  useOutbox,
  visibleOutbox,
  type OutboxOwner,
} from "./conversation/outbox";
import { createFeedSession, type FeedSession, type FeedSnapshot } from "./feed/parse";
import { claimFeedSession, releaseFeedSession, takeFeedSession } from "./feed/sessionPool";
import { FeedItem } from "./feed/FeedItem";
import { MessageProvenanceProvider, useDeliveredMessageProvenance } from "./feed/messageProvenance";
import { RawLineProvider, type RawLineLookup } from "./feed/rawLine";
import { ResponseDuration } from "./feed/ResponseDuration";
import { SuggestedReplies } from "./feed/SuggestedReplies";
import { BoundedLru } from "./feed/scrollMemory";
import { ConversationAttention } from "./runtime/ConversationAttention";
import { speakableAnswer } from "./feed/speakableAnswer";
import { isSubagent } from "./projectModel";
import { TaskHeader } from "./TaskHeader";
import { TurnStatusBar } from "./TurnStatusBar";
import { logFeedDependencies } from "./logFeedDependencies";

/** Items rendered initially and added per «show earlier» step. */
const RENDER_STEP = 1500;
/** Compact scheme panes keep the DOM small — five agents on the canvas must
    not mount thousands of message nodes each; «show earlier» still walks
    the full history in steps. */
const COMPACT_INITIAL = 300;
const COMPACT_STEP = 500;
/** The first commit of a transcript paints only its last rows (#1432): a
    project switch mounts several panes at once and a phone switch remounts
    one, and mounting the whole initial window in that commit is what stood
    between the gesture and the first frame. The window grows to its initial
    count right after that frame; the magnet keeps the tail in view and a
    released reader keeps its anchor, so nothing the operator sees moves. */
const FIRST_PAINT_ROWS = 60;
/** Live-tail window while the magnet holds the bottom. Touch devices run on
    a far smaller tab memory budget (iOS kills the renderer past it), so the
    window shrinks there; «show earlier» still walks the full history. */
const TAIL_CAP = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 500 : 2500;
/** Focused (non-compact) panes read with more context but must not grow the
    window forever while the magnet holds — a live agent left open overnight
    used to accumulate an unbounded line array. A released reader still keeps
    everything, so trimming never shifts what is being read. */
const FOCUS_CAP = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 1000 : 6000;

const EMPTY_FEED: FeedSnapshot = { items: [], hiddenServiceCount: 0 };

/** How long after a programmatic glue an untagged not-at-bottom scroll event
    is treated as layout settling (content-visibility estimates, pane resizes)
    and glued again. Input-tagged releases bypass this window. */
const GLUE_SETTLE_MS = 300;

type ScrollCause =
  | { kind: "programmatic" }
  | { kind: "user"; fromBottom: number; direction: -1 | 1 | null };

/* Scroll state per stable conversation, surviving pane remounts and native
   generation changes during account migration. */
interface ViewportAnchor {
  path: string;
  key: string;
  offset: number;
}

interface ScrollMemory {
  magnet: boolean;
  fromBottom: number;
  anchor: ViewportAnchor | null;
}

interface PendingRestore extends ScrollMemory {
  path: string;
  applied: boolean;
}

const SCROLL_MEMORY_CAP = 300;
const scrollMemory = new BoundedLru<ScrollMemory>(SCROLL_MEMORY_CAP);

function rememberScroll(key: string, memory: ScrollMemory): void {
  scrollMemory.set(key, memory);
}

function feedRows(scroller: HTMLElement): HTMLElement[] {
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-feed-key]"));
}

function viewportAnchor(scroller: HTMLElement, path: string): ViewportAnchor | null {
  const viewportTop = scroller.getBoundingClientRect().top;
  const row = feedRows(scroller).find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop);
  const key = row?.dataset.feedKey;
  return row && key ? { path, key, offset: row.getBoundingClientRect().top - viewportTop } : null;
}

function rowForAnchor(scroller: HTMLElement, key: string): HTMLElement | null {
  return feedRows(scroller).find((row) => row.dataset.feedKey === key) ?? null;
}

function canScrollVertically(element: HTMLElement, deltaY: number): boolean {
  if (deltaY < 0) return element.scrollTop > 0;
  if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight;
  return false;
}

function pointerHitsVerticalScrollbar(element: HTMLElement, clientX: number): boolean {
  if (element.scrollHeight <= element.clientHeight) return false;
  const bounds = element.getBoundingClientRect();
  const contentLeft = bounds.left + element.clientLeft;
  const contentRight = contentLeft + element.clientWidth;
  return clientX < contentLeft || clientX >= contentRight;
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
}

/** Wall-clock read hoisted out of the component so the React Compiler's purity
    check does not see a bare `Date.now()` in a render-scope closure. */
function nowMs(): number {
  return Date.now();
}

function launchOutboxState(initialMessage: NonNullable<FileEntry["spawn"]>["initialMessage"]): "delivering" | "delivered" | "failed" {
  if (initialMessage === "delivered") return "delivered";
  if (initialMessage === "failed") return "failed";
  return "delivering";
}

interface Props {
  file: FileEntry | null;
  showSvc: boolean;
  lineFilter: string;
  onStatus: (status: string) => void;
  paused: boolean;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  compact?: boolean;
  /** Opens a fresh editable draft from a terminal structured launch receipt —
      wired through so the launch chips keep their retry inside the window. */
  onLaunchRetry?: () => void;
}

export function LogFeed({ file, showSvc, lineFilter, onStatus, paused, follow, setFollow, compact = false, onLaunchRetry }: Props) {
  const { locale, t } = useLocale();
  const memoryKey = file ? conversationIdentity(file) : null;
  /* The conversation's own outbox (issue #561): submitted drafts render as
     optimistic user bubbles at the tail of THIS feed, before any transcript
     flush, and retire the moment their real bubble lands. */
  const outbox = useOutbox(memoryKey ?? "");
  const assistantClaims = useCanonicalAssistantClaims(memoryKey ?? "");
  /* Launch/delivery facts of the launch that created this conversation, or of
     the launch that is still becoming it (issue #569) — the same chips either
     way, because it is the same window. */
  const launch = file?.launch ?? file?.spawn ?? null;
  /* Exact launch ownership (issue #922): the server canonicalizes aliases and
     projects the native generation. The client joins on both durable values and
     never infers ownership from a path, queue key, or alias. */
  const paneConversationId = file?.conversationId ?? null;
  const paneGeneration = file?.generation ?? null;
  const paneLaunchOwner = useMemo<OutboxOwner | null>(
    () => paneConversationId && paneGeneration
      ? { conversationId: paneConversationId, generation: paneGeneration }
      : null,
    [paneConversationId, paneGeneration],
  );
  const launchConversationId = launch?.conversationId ?? null;
  const launchGeneration = launch?.generation ?? null;
  const launchOwner = useMemo<OutboxOwner | null>(
    () => launchConversationId && launchGeneration
      ? { conversationId: launchConversationId, generation: launchGeneration }
      : null,
    [launchConversationId, launchGeneration],
  );
  const launchOwnsThisPane = Boolean(
    paneLaunchOwner
      && launchOwner
      && paneLaunchOwner.conversationId === launchOwner.conversationId
      && paneLaunchOwner.generation === launchOwner.generation,
  );
  /* A materialized `file.launch` is the server's live-adoption signal. Retire
     the starting-window bubble at that hand-off even when an image-only launch
     has no text echo and its delivery receipt still reads queued/delivering. */
  useEffect(() => {
    if (!memoryKey || !file?.launch || !launchOwnsThisPane || !launchOwner) return;
    retireLaunchOutboxOnAdoption(memoryKey, {
      id: file.launch.launchId,
      adoptedAt: nowMs(),
      owner: launchOwner,
    });
  }, [memoryKey, file?.launch?.launchId, launchOwner, launchOwnsThisPane]);
  /* Live streaming text: `delta` events from the structured host render the
     in-flight assistant reply immediately, ahead of the transcript flush. The
     host is resolved by conversation identity FIRST (round-1 P1#3): during
     launch the file path is still `spawn:<launchId>` with no artifact, so an
     artifact-only lookup would miss the live host and drop the first deltas; the
     transcript path stays a fallback for subagents that carry no bus id. */
  const runtimeSession = useRuntimeSessionForConversation(
    file?.conversationId ?? null,
    file?.path ?? null,
  )?.session ?? null;
  const runtimeLiveTurn = runtimeSession?.liveTurn ?? null;
  /* Liveness for the in-flight exemption (issue #674 review): a `streaming`
     overlay row outranks the transcript only while the turn is actually
     running. Once the turn is idle a lingering one — a broker that died
     mid-stream leaves it streaming forever — is fenced like any other. */
  const runtimeTurn = runtimeSession?.turn ?? null;
  /* The scroll magnet lives per feed instance, so each column remembers its
     own state across polls: glued to the live tail, or released by the user.
     A remount inherits the transcript's remembered state. */
  const [magnet, setMagnetState] = useState(() => (memoryKey ? (scrollMemory.get(memoryKey)?.magnet ?? follow) : follow));
  /* The transcript the tail reads (issue #1100): while the board still
     projects the launch placeholder `spawn:<launchId>` — a path nothing can
     read — the matching runtime session already names the canonical artifact
     its host writes, so the SAME tail reads that path from the first turn on.
     The canonical rows attach as soon as the file has lines, and the live
     overlay (prose + tool rows from the host stream) yields to them row by row
     through the identity claims, exactly as after the flip. One subscription
     either way: when the board flips the card to the artifact the path is
     unchanged, so nothing re-subscribes, re-parses or resets the reader's
     position. A placeholder whose host has not named an artifact yet still
     reads nothing; the late flip itself stays the board's concern (#1108).
     Conversation identity (`memoryKey`: outbox, claims, scroll memory) keeps
     keying on the card; only the transcript-stream state below keys on
     `tailPath`. */
  const launchArtifactPath = file && isLaunchPlaceholder(file) ? runtimeSession?.artifactPath ?? null : null;
  const tailFile = useMemo<FileEntry | null>(
    () => (file && launchArtifactPath ? { ...file, path: launchArtifactPath } : file),
    [file, launchArtifactPath],
  );
  const tailPath = tailFile?.path ?? null;
  /* Released reader must never lose lines above the viewport: the tail cap
     applies only while the magnet holds the bottom in view anyway. */
  const tail = logFeedDependencies().useLogTail(
    tailFile,
    paused,
    magnet ? (compact ? TAIL_CAP : FOCUS_CAP) : 0,
  );
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const initialCount = compact ? COMPACT_INITIAL : RENDER_STEP;
  const revealStep = compact ? COMPACT_STEP : RENDER_STEP;
  const firstPaintCount = Math.min(FIRST_PAINT_ROWS, initialCount);
  const [visibleCount, setVisibleCount] = useState(firstPaintCount);
  const [newCount, setNewCount] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [endedQuestion, setEndedQuestion] = useState<string | null>(null);
  const hadQuestionRef = useRef(false);
  /* Synchronous per-transcript follow authority: an upward input closes this
     latch before a tail render can run with stale `magnet` state. While this
     transcript stays selected, only an operator bottom return or an explicit
     follow control writes it true again. */
  const magnetRef = useRef(magnet);
  const lastLenRef = useRef(0);
  const lastPrependRef = useRef(0);
  const pulseTimer = useRef<number | null>(null);
  const glueAtRef = useRef(0);
  const scrollCauseRef = useRef<ScrollCause | null>(null);
  /* One scrollbar press can drive many scroll events. Its moving baseline
     lives through the gesture; a stamped programmatic cause still wins. */
  const scrollbarPointerRef = useRef<{ fromBottom: number } | null>(null);
  const feedTouchRef = useRef<{ x: number; y: number } | null>(null);
  const pillTouchRef = useRef<{ x: number; y: number } | null>(null);
  const restoreInitializedPathRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  const filePathRef = useRef(tailPath);
  const controlledFollowRef = useRef(follow);

  const setMagnet = (value: boolean, withPulse = false) => {
    pendingRestoreRef.current = null;
    magnetRef.current = value;
    setMagnetState(value);
    setFollow(value);
    if (value) setNewCount(0);
    if (memoryKey) {
      const remembered = scrollMemory.get(memoryKey);
      rememberScroll(memoryKey, {
        magnet: value,
        fromBottom: remembered?.fromBottom ?? 0,
        anchor: value ? null : (remembered?.anchor ?? null),
      });
    }
    if (withPulse) {
      setPulse(true);
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulse(false), 450);
    }
  };

  const markProgrammaticScroll = () => {
    if (scrollCauseRef.current?.kind !== "user") {
      scrollCauseRef.current = { kind: "programmatic" };
    }
    glueAtRef.current = nowMs();
  };

  /* Programmatic glue: the scroll event it triggers must never read as the
     user releasing the magnet, so the moment is stamped and the handler
     treats near-in-time off-bottom positions as layout still settling. */
  const glue = () => {
    const el = scroller.current;
    if (!el || !magnetRef.current) return;
    markProgrammaticScroll();
    el.scrollTop = el.scrollHeight;
    const pendingUser = scrollCauseRef.current;
    if (pendingUser?.kind === "user") pendingUser.fromBottom = distanceFromBottom(el);
  };

  /* A released pane can mount before its full content has measurable height.
     Apply the best reachable position and keep retrying until the remembered
     distance from the tail fits inside the current scroll range. */
  const restorePendingPosition = () => {
    const el = scroller.current;
    const pending = pendingRestoreRef.current;
    if (!el || !pending || magnetRef.current) return false;
    if (pending.path !== filePathRef.current) {
      pendingRestoreRef.current = null;
      return false;
    }
    const anchor = pending.anchor?.path === pending.path ? pending.anchor : null;
    if (anchor) {
      const row = rowForAnchor(el, anchor.key);
      if (row) {
        const currentOffset = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
        markProgrammaticScroll();
        el.scrollTop += currentOffset - anchor.offset;
        pending.applied = true;
        return true;
      }
    }
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    markProgrammaticScroll();
    el.scrollTop = Math.max(0, maxScroll - pending.fromBottom);
    if (maxScroll < pending.fromBottom) return false;
    pending.applied = true;
    if (!anchor) pendingRestoreRef.current = null;
    return true;
  };

  /* First frame: the last FIRST_PAINT_ROWS. Next frame: the full initial
     window, with the scroll anchored exactly as a «show earlier» reveal is. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleCount(firstPaintCount);
    if (firstPaintCount >= initialCount) return;
    /* Two frames: the first commit paints, the second grows the window. A
       host without animation frames (a bare test document) grows on a
       macrotask instead. */
    const raf = typeof requestAnimationFrame === "function";
    const schedule = (fn: () => void) => (raf ? requestAnimationFrame(fn) : (setTimeout(fn, 0) as unknown as number));
    const cancel = (handle: number) => (raf ? cancelAnimationFrame(handle) : clearTimeout(handle));
    let handle = schedule(() => {
      handle = schedule(() => {
        const el = scroller.current;
        if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
        setVisibleCount((count) => Math.max(count, initialCount));
      });
    });
    return () => cancel(handle);
  }, [tailPath, initialCount, firstPaintCount]);
  /* Same instance, new transcript: pick up that transcript's remembered state. */
  useEffect(() => {
    if (!memoryKey) return;
    const remembered = scrollMemory.get(memoryKey)?.magnet ?? follow;
    if (remembered !== magnetRef.current) {
      magnetRef.current = remembered;
       
      setMagnetState(remembered);
    }
  }, [tailPath, memoryKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /* External Follow transitions from the focus header drive the same magnet.
     A compact pane's constant true value leaves remount memory authoritative. */
  useEffect(() => {
    if (follow === controlledFollowRef.current) return;
    controlledFollowRef.current = follow;
    pendingRestoreRef.current = null;
    if (follow !== magnetRef.current) {
      magnetRef.current = follow;
      setMagnetState(follow);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (follow) setNewCount(0);
    }
  }, [follow]);
  useEffect(
    () => () => {
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    },
    [],
  );
  useEffect(() => {
    function releaseScrollbarPointer(): void { scrollbarPointerRef.current = null; }
    window.addEventListener("pointerup", releaseScrollbarPointer, true);
    window.addEventListener("pointercancel", releaseScrollbarPointer, true);
    window.addEventListener("blur", releaseScrollbarPointer);
    return () => {
      window.removeEventListener("pointerup", releaseScrollbarPointer, true);
      window.removeEventListener("pointercancel", releaseScrollbarPointer, true);
      window.removeEventListener("blur", releaseScrollbarPointer);
    };
  }, []);
  useEffect(() => {
    hadQuestionRef.current = false;
    queueMicrotask(() => setEndedQuestion(null));
  }, [file?.path]);

  useEffect(() => {
    if (!file) return;
    if (file.pendingQuestion) {
      hadQuestionRef.current = true;
      queueMicrotask(() => setEndedQuestion(null));
      return;
    }
    if (hadQuestionRef.current && file.proc && file.proc !== "running") {
      queueMicrotask(() => setEndedQuestion(translate(locale, "feed.agentEnded")));
      hadQuestionRef.current = false;
    }
  }, [file?.pendingQuestion?.toolUseId, file?.proc, file, locale]);

  /* The incremental feed session parses only lines it has not seen and keeps
     untouched item identities, so a tail tick re-renders one or two rows, not
     the whole window. The session is keyed on the fields that change the
     parse itself (path/format/filters/locale — not the file object identity,
     which changes every /api/files poll); anything else reuses it. Feeding
     inside the memo is safe: feed() is idempotent for an unchanged window. */
  const lf = lineFilter.toLowerCase();
  /* The session outlives this mount (#1432): a conversation that was on screen
     earlier comes back with its parse intact — taken from the pool here, given
     back when the key changes or the feed unmounts — so a switch paints the
     previous rows without re-parsing the retained window. The key is exactly
     the parse configuration above; a session is owned by one mount at a time. */
  const sessionKey = file && tailPath ? [tailPath, file.engine, file.fmt, showSvc ? "1" : "0", lf, locale].join("\u0000") : null;
  const session: FeedSession | null = useMemo(
    () => (file && sessionKey
      ? takeFeedSession(sessionKey) ?? createFeedSession({ engine: file.engine, fmt: file.fmt, showSvc, lineFilter: lf })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionKey],
  );
  useEffect(() => {
    if (!sessionKey || !session) return;
    claimFeedSession(sessionKey, session);
    return () => releaseFeedSession(sessionKey, session);
  }, [sessionKey, session]);
  const feed = useMemo(
    () => (file && session ? session.feed(tail.lines, tail.linesStart, file.activity === "live") : EMPTY_FEED),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, file?.activity, tail.lines, tail.linesStart],
  );
  /* Tool activity earns its cue from the parse itself: every newly appended
     call ticks once, keyed on the engine's call id — even one that settled
     inside a single tail tick — while re-parses, remounts and paged-in history
     stay silent. The window end anchors "newly appended" to the tail stream;
     loading gates the baseline so an unloaded feed is not mistaken for an
     empty conversation. */
  useToolActivityCues(feed.items, memoryKey, tailPath, tail.linesStart + tail.lines.length, Boolean(file) && !tail.loading);
  /* Delivered-message authorship (#1117): joins the Claude delivery ledger by
     engine message id server-side, and on both engines joins each settled
     delivery occurrence (registry receipt or flow round: content digest,
     settlement time, sender) to the one row nearest it, resolving a delivered
     "system" row or a legacy paste into the operator's bubble or the internal
     relay card at render time. Codex structured rows carry their authorship in
     the transcript marker instead. */
  const provenanceLookup = useDeliveredMessageProvenance(
    file?.engine === "claude" || file?.engine === "codex" ? tailPath : null,
    feed.items,
  );
  const hiddenLocal = Math.max(0, feed.items.length - visibleCount);
  const visibleItems = hiddenLocal ? feed.items.slice(-visibleCount) : feed.items;
  const visibleStartIndex = feed.items.length - visibleItems.length;

  /* Lazy raw-record provenance: a tool card resolves its source line(s) from
     the retained window, client-side, with no server round-trip. A line that
     slid out returns null, which the card renders as a quiet chip. */
  const getRawLine: RawLineLookup = useMemo(() => {
    const lines = tail.lines;
    const base = tail.linesStart;
    return (src) => (src >= base && src < base + lines.length ? (lines[src - base] ?? null) : null);
  }, [tail.lines, tail.linesStart]);

  useEffect(() => {
    const time = tail.tickTime?.toLocaleTimeString(getLocale() === "uk" ? "uk-UA" : "en-US", { hour12: false }) ?? "";
    if (tail.error) onStatus(tail.error);
    else if (file) onStatus(`${(tail.size / 1024).toFixed(0)} kB${time ? " · " + time : ""}`);
    else onStatus("");
  }, [tail.error, tail.size, tail.tickTime, file, onStatus]);

  useLayoutEffect(() => {
    filePathRef.current = tailPath;
    restoreInitializedPathRef.current = null;
    pendingRestoreRef.current = null;
  }, [tailPath]);

  /* Older history grows the content above the viewport; keep what the user
     was reading in place by compensating the scroll offset. */
  useLayoutEffect(() => {
    const el = scroller.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [tail.prependGen, visibleCount]);

  /* Glued: keep the bottom in view. Keyed by item-list identity, not length —
     at the tail cap every poll trims above and appends below with the count
     unchanged, and a length key would skip the re-glue, letting the viewport
     drift up until it drops out of follow. Pre-paint so the trimmed frame is
     never shown off-bottom. Released: count what arrived meanwhile (prepended
     history is old content, so it stays out of the counter). */
  useLayoutEffect(() => {
    const len = feed.items.length;
    const prepended = tail.prependGen !== lastPrependRef.current;
    lastPrependRef.current = tail.prependGen;
    const delta = len - lastLenRef.current;
    lastLenRef.current = len;
    /* First non-empty render of a released pane after a remount: stage the
       remembered distance from the tail for immediate and resize retries. */
    let initializedRestore = false;
    if (tailPath && len && restoreInitializedPathRef.current !== tailPath) {
      restoreInitializedPathRef.current = tailPath;
      const remembered = memoryKey ? scrollMemory.get(memoryKey) : undefined;
      pendingRestoreRef.current = !magnet && remembered && (remembered.fromBottom > 0 || remembered.anchor)
        ? { path: tailPath, ...remembered, applied: false }
        : null;
      initializedRestore = true;
    }
    if (pendingRestoreRef.current) {
      restorePendingPosition();
      if (initializedRestore || !pendingRestoreRef.current?.applied) return;
    }
    if (magnet) {
      glue();
    } else if (!prepended && delta > 0) {
      setNewCount((count) => count + delta);
    }
  }, [feed.items, magnet, tail.prependGen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Height also changes without the item list changing — images decode, the
     working/question rows toggle. Re-glue on any content resize while glued. */
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (magnetRef.current) glue();
      else restorePendingPosition();
    });
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const revealOlder = () => {
    const el = scroller.current;
    if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    if (hiddenLocal) setVisibleCount((value) => value + revealStep);
    else if (tail.hasMore) void tail.loadOlder().then(() => setVisibleCount((value) => value + revealStep));
  };
  const canRevealOlder = hiddenLocal > 0 || tail.hasMore;

  const lastItem = feed.items.at(-1)?.item;
  const transcriptWorking: { icon: LucideIcon; label: string } =
    lastItem?.kind === "tool" && lastItem.status === "run"
      ? { icon: Wrench, label: t("feed.running", { tool: (lastItem.command ?? lastItem.summary).split(/[\s:·]/, 1)[0] || t("feed.tool") }) }
      : lastItem?.kind === "think"
        ? { icon: Sparkle, label: t("feed.thinking") }
        : { icon: Sparkle, label: t("feed.working") };

  const jumpToTail = () => {
    setMagnet(true, true);
    glue();
  };

  const transcriptGeneration = tailPath;
  /* Optimistic bubbles retire on their OWN transcript echo (round-1 P1#4,
     round-2 finding 2): a bubble disappears the moment ITS echo lands, resolved
     causally by occurrence count. A user text that appears twice is two echoes
     that retire two bubbles; a message that predates a queued bubble leaves it
     visible. The counts carry that occurrence information. */
  /* The launch's own first message identity (issue #648): a structured / MCP
     spawn journals its first user record with SDK / agent provenance, so the
     transcript parser CLASSIFIES it as a system row, not a `user` item — the
     echo-text retirement path would never see it. Its text is still the launch
     prompt's transcript echo, so treat a system-row row that matches a
     launch-owned bubble's own text (raw draft OR scaffolded echo) as that
     bubble's echo. Derived from the outbox so it survives adoption (which strips
     the launch prompt fields from the server projection). Since #1117 the
     RENDERER may resolve that same row into the operator's bubble or an
     internal relay card from delivery evidence; the parse-level kind — what
     everything here keys on — is unchanged. */
  const launchEchoKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of outbox) {
      if (!entry.launchOwned) continue;
      const echo = entry.echoText?.trim();
      if (echo) keys.add(echo);
      const text = entry.text.trim();
      if (text) keys.add(text);
    }
    return keys;
  }, [outbox]);
  const transcriptEchoes = useMemo(() => {
    if (!transcriptGeneration) return [];
    return feed.items.flatMap(({ anchorKey, key, item }) => {
      const text = "text" in item ? item.text : "";
      if (!text.trim()) return [];
      /* A genuine user bubble is always an echo, and so is a delivered
         structured message (#1117): the system-kind row carrying a ledger join
         identity IS the send's transcript echo, whatever the renderer resolves
         it into. Any other non-user row only echoes the launch when it exactly
         carries a launch-owned bubble's own identity. */
      const deliveredEcho = item.kind === "sysmsg" && Boolean(item.deliveredMessage);
      if (item.kind !== "user" && !deliveredEcho && !launchEchoKeys.has(text.trim())) return [];
      return [{ generation: transcriptGeneration, id: anchorKey ?? `key:${key}`, text }];
    });
  }, [feed.items, transcriptGeneration, launchEchoKeys]);
  const transcriptEchoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const echo of transcriptEchoes) {
      const key = echo.text.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [transcriptEchoes]);
  /* Publish stable absolute row anchors so canonical retirement is persisted
     before a capped tail or filter can remove the matching row. The outbox also
     derives the composer's repeated-text occurrence watermark from this ledger. */
  useEffect(() => {
    if (memoryKey) publishTranscriptEchoes(memoryKey, transcriptEchoes);
  }, [memoryKey, transcriptEchoes]);
  /* The launch prompt as the conversation's first user bubble on EVERY surface
     (issue #614): the server projects the queued initial prompt onto the launch
     state, so a board that did not run the composer (an MCP spawn, a second tab,
     a fresh refresh) seeds the same launch-owned bubble the composer path seeds.
     Keyed by the launch id under the stable conversation identity, so it is
     idempotent with the composer's own seed (no duplicate), survives a refresh,
     folds through transcript adoption, and retires on its transcript echo or
     the live transcript's adoption. */
  useLayoutEffect(() => {
    if (!memoryKey || !launch?.launchId || !launchOwnsThisPane) return;
    const promptText = launch.prompt ?? "";
    const promptImages = launch.promptImages ?? 0;
    if (!promptText.trim() && !promptImages && !launch.promptEcho) return;
    seedLaunchOutbox(memoryKey, {
      id: launch.launchId,
      text: promptText,
      images: promptImages,
      at: launch.promptAt ?? Date.now(),
      /* The canonical echo identity (issue #615/#616): the bubble displays the
         raw draft and retires on the delivered scaffolded transcript echo. An
         adopted live fact can carry this identity after its display fields have
         retired, reconciling the 202 seed before the browser paints. */
      ...(launch.promptEcho ? { echoText: launch.promptEcho } : {}),
      owner: launchOwner!,
      state: launchOutboxState(launch.initialMessage),
      ...(launch.deliveredAt !== undefined ? { settledAt: launch.deliveredAt } : {}),
      ...(launch.error ? { error: launch.error } : {}),
    });
  }, [memoryKey, launch?.launchId, launch?.prompt, launch?.promptImages, launch?.promptAt, launch?.promptEcho, launch?.initialMessage, launch?.deliveredAt, launch?.error, launchOwner, launchOwnsThisPane]);
  /* Settle the launch bubble from the delivery receipt the server projects
     (issue #648), independent of any transcript echo. A structured / MCP spawn's
     first message is journaled with SDK / agent provenance and parses as a
     system-kind row (#1117 resolves its VISUAL at render time), so echo
     retirement can never fire; the delivered receipt is the proof the prompt
     reached the agent. It settles the bubble to `delivered` with the receipt time
     as `settledAt`, so it retires on the delivered TTL instead of spinning on
     "delivering" forever. Keyed on the launch id and the receipt time only, so it
     still fires on a materialized window that has stripped the prompt fields. */
  useEffect(() => {
    if (!memoryKey || !launch?.launchId || !launchOwnsThisPane || !launchOwner) return;
    if (launch.initialMessage === "delivered" && launch.deliveredAt !== undefined) {
      settleLaunchOutboxDelivered(memoryKey, {
        id: launch.launchId,
        at: launch.promptAt ?? launch.deliveredAt,
        settledAt: launch.deliveredAt,
        owner: launchOwner,
      });
    } else if (launch.initialMessage === "failed") {
      settleLaunchOutboxFailed(memoryKey, {
        id: launch.launchId,
        at: launch.promptAt ?? Date.now(),
        ...(launch.error ? { error: launch.error } : {}),
        owner: launchOwner,
      });
    }
  }, [memoryKey, launch?.launchId, launch?.initialMessage, launch?.deliveredAt, launch?.promptAt, launch?.error, launchOwner, launchOwnsThisPane]);
  /* The newest rendered transcript moment: past a delivered bubble's settle
     time, it proves the agent's output already moved beyond the delivery and
     retires the bubble even when its echo was missed (a scaffolded payload, a
     tail attached after the echo row) — the tail section must never paint the
     operator's delivered message below newer records. */
  const newestTranscriptAtMs = useMemo(() => {
    let newest: number | undefined;
    for (const { item } of feed.items) {
      if (!("ts" in item)) continue;
      const at = typeof item.ts === "number" ? item.ts : Date.parse(String(item.ts ?? ""));
      if (Number.isFinite(at) && (newest === undefined || at > newest)) newest = at;
    }
    return newest;
  }, [feed.items]);
  /* Launch bubbles fail closed without exact canonical ownership; ordinary
     composer entries still render from this conversation-scoped queue. */
  const pendingOutbox = file
    ? visibleOutbox(outbox, transcriptEchoCounts, nowMs(), paneLaunchOwner, newestTranscriptAtMs)
    : [];
  useEffect(() => {
    if (!memoryKey || !tailPath) return;
    adoptCanonicalAssistantClaims(tailPath, memoryKey);
    publishCanonicalAssistantClaims(memoryKey, feed.items);
  }, [tailPath, memoryKey, feed.items]);
  const visibleLiveTurnItems = useMemo(
    () => visibleRuntimeLiveTurnItems(runtimeLiveTurn, feed.items, assistantClaims, runtimeTurn),
    [runtimeLiveTurn, feed.items, assistantClaims, runtimeTurn],
  );
  /* The status bar names the tool that is running NOW: a live tool row from the
     structured host (issue #1100) is newer than anything the transcript window
     shows, so it wins over the transcript's last row while it is still running.
     Calls run in parallel, so the newest row may already have settled while an
     earlier one is still going — the newest RUNNING row is the one named. */
  const liveRunningTool = visibleLiveTurnItems.findLast((item) => item.tool?.status === "run")?.tool;
  const working: { icon: LucideIcon; label: string } = liveRunningTool
    ? {
      icon: Wrench,
      label: t("feed.running", {
        tool: (typeof liveRunningTool.args.command === "string"
          ? liveRunningTool.args.command
          : typeof liveRunningTool.args.cmd === "string"
            ? liveRunningTool.args.cmd
            : liveRunningTool.name).split(/[\s:·]/, 1)[0] || t("feed.tool"),
      }),
    }
    : transcriptWorking;
  /* Anything the window shows below the transcript. While it is present an
     empty transcript is not "no output" — it is a conversation mid-launch. */
  const windowTail = visibleLiveTurnItems.length > 0 || pendingOutbox.length > 0 || Boolean(launch);

  /* What says this conversation moved, for the reply-draft read (#1202): the
     bytes the tail has seen plus the rows they parsed into. It changes exactly
     when the transcript grows, so the drafts are read off the stream the pane
     already has rather than off a timer of their own. */
  const suggestionsRevision = `${tail.size}:${feed.items.length}`;

  /* The floating pill is centered on every surface — the same axis as the
     pinned TurnStatusBar below, per the issue #268 operator note: the two
     bottom elements share one axis and separate slots, so they can never
     collide at any pane width. (A right-anchored pill also sat over the tool
     rows' status column on the phone.) */
  const pillPos = "left-1/2 -translate-x-1/2";
  const markUserScroll = (direction: number | null): void => {
    const el = scroller.current;
    if (!el) return;
    scrollCauseRef.current = {
      kind: "user",
      fromBottom: distanceFromBottom(el),
      direction: direction === null || direction === 0 ? null : direction < 0 ? -1 : 1,
    };
    if (direction !== null && direction < 0 && magnetRef.current) setMagnet(false);
  };
  const forwardPillVerticalDelta = (row: HTMLElement | null, deltaY: number): void => {
    const el = scroller.current;
    if (!el || !deltaY || (row && canScrollVertically(row, deltaY))) return;
    markUserScroll(deltaY);
    el.scrollTop += deltaY;
  };

  return (
    <RawLineProvider value={getRawLine}>
    <MessageProvenanceProvider value={provenanceLookup}>
    <div className="flex min-h-0 flex-1 flex-col">
    {/* The pill anchors to the scroller wrapper — NOT the pane column — so the
        pinned status bar below is structurally outside its overlay area. */}
    <div className="relative flex min-h-0 flex-1 flex-col">
      {file && feed.items.length ? (
        magnet ? (
          file.activity === "live" ? (
            <div
              data-live-tail-pill
              className={`pointer-events-none absolute bottom-2 ${pillPos} z-10 inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[10px] font-bold text-white shadow-1 transition-transform duration-200 ${
                pulse ? "scale-125" : "scale-100"
              }`}
            >
              <ArrowDownToLine className="h-3 w-3" aria-hidden /> {t("feed.liveTail")}
            </div>
          ) : null
        ) : (
          <button
            className={`absolute bottom-2 ${pillPos} z-10 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-raised px-2.5 py-1 text-label font-semibold text-primary shadow-1 [@media(pointer:coarse)]:min-h-11 hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
            aria-label={t("feed.backToLive")}
            onClick={jumpToTail}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden /> {newCount ? t("feed.newCount", { count: newCount }) : t("feed.down")}
          </button>
        )
      ) : null}
      {/* #1202: with the latest turn off-screen the drafts follow the operator
          to the bottom of the pane — above the «back to live» chip, so the two
          bottom controls never share a row. Empty wrapper space targets the
          feed; vertical pill gestures are forwarded because this overlay and
          the feed scroller are siblings. */}
      {file && !magnet ? (
        <div
          className="pointer-events-none absolute inset-x-2 bottom-11 z-10 flex justify-center"
          onWheel={(event) => {
            const row = event.currentTarget.querySelector<HTMLElement>("[data-reply-suggestions]");
            let scale = 1;
            if (event.deltaMode === 1) scale = 16;
            else if (event.deltaMode === 2) scale = scroller.current?.clientHeight ?? 1;
            forwardPillVerticalDelta(row, event.deltaY * scale);
          }}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            pillTouchRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          }}
          onTouchMove={(event) => {
            const touch = event.touches[0];
            const previous = pillTouchRef.current;
            if (!touch || !previous) return;
            const deltaX = previous.x - touch.clientX;
            const deltaY = previous.y - touch.clientY;
            pillTouchRef.current = { x: touch.clientX, y: touch.clientY };
            if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
            const row = event.currentTarget.querySelector<HTMLElement>("[data-reply-suggestions]");
            forwardPillVerticalDelta(row, deltaY);
          }}
          onTouchEnd={() => { pillTouchRef.current = null; }}
          onTouchCancel={() => { pillTouchRef.current = null; }}
        >
          <SuggestedReplies
            file={file}
            revision={suggestionsRevision}
            items={feed.items}
            outbox={pendingOutbox}
            floating
          />
        </div>
      ) : null}
      <div
        ref={scroller}
        /* Stable geometry hook (issue #419): the chat-first viewport-budget
           capture measures this scroller's rendered height against the usable
           visual viewport to prove the transcript owns its ≥60% share. */
        data-log-feed-scroller
        data-tail-lines-start={tail.linesStart}
        data-tail-line-count={tail.lines.length}
        className={compact ? "min-h-0 flex-1 overflow-y-auto py-3" : "min-h-0 flex-1 overflow-y-auto py-6"}
        onWheelCapture={(event) => {
          if (event.deltaY) markUserScroll(event.deltaY);
        }}
        onPointerDownCapture={(event) => {
          if (event.button === 0 && pointerHitsVerticalScrollbar(event.currentTarget, event.clientX)) {
            scrollbarPointerRef.current = { fromBottom: distanceFromBottom(event.currentTarget) };
            scrollCauseRef.current = null;
          }
        }}
        onTouchStartCapture={(event) => {
          const touch = event.touches[0];
          feedTouchRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          markUserScroll(null);
        }}
        onTouchMoveCapture={(event) => {
          const touch = event.touches[0];
          const previous = feedTouchRef.current;
          if (!touch || !previous) return;
          const deltaX = previous.x - touch.clientX;
          const deltaY = previous.y - touch.clientY;
          feedTouchRef.current = { x: touch.clientX, y: touch.clientY };
          if (Math.abs(deltaY) > Math.abs(deltaX)) markUserScroll(deltaY);
        }}
        onTouchEndCapture={() => { feedTouchRef.current = null; }}
        onTouchCancelCapture={() => { feedTouchRef.current = null; }}
        onKeyDownCapture={(event) => {
          if (["ArrowUp", "Home", "PageUp"].includes(event.key)) markUserScroll(-1);
          else if (["ArrowDown", "End", "PageDown"].includes(event.key)) markUserScroll(1);
          else if ([" ", "Spacebar"].includes(event.key)) markUserScroll(event.shiftKey ? -1 : 1);
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          const fromBottom = distanceFromBottom(el);
          const atBottom = fromBottom <= 50;
          const pendingCause = scrollCauseRef.current;
          const scrollbarPointer = scrollbarPointerRef.current;
          const cause: ScrollCause | null = scrollbarPointer && pendingCause?.kind !== "programmatic"
            ? { kind: "user", fromBottom: scrollbarPointer.fromBottom, direction: null }
            : pendingCause;
          const userDelta = cause?.kind === "user" ? fromBottom - cause.fromBottom : 0;
          const userInitiated = cause?.kind === "user"
            && userDelta !== 0
            && (cause.direction === null || Math.sign(userDelta) === -cause.direction);
          const userReleasedMagnet = userInitiated && userDelta > 0;
          const userReturnedToBottom = atBottom && userInitiated && userDelta < 0;
          /* A concurrent glue can emit its own scroll at the bottom before the
             wheel's upward scroll. Keep a zero-movement user tag for that next
             event; an opposite movement proves the tag did not cause it. A
             scrollbar press keeps its separate moving baseline until release. */
          if (scrollbarPointer) scrollbarPointer.fromBottom = fromBottom;
          if (scrollbarPointer || cause?.kind !== "user" || userDelta !== 0) scrollCauseRef.current = null;
          const settling = nowMs() - glueAtRef.current < GLUE_SETTLE_MS;
          if (!settling || userInitiated) pendingRestoreRef.current = null;
          if (userReturnedToBottom && !magnetRef.current) setMagnet(true, true);
          else if ((userReleasedMagnet || !atBottom) && magnetRef.current) {
            /* Off-bottom right after a programmatic glue is layout settling
               (content-visibility estimates, pane resizes during a scheme
               reshuffle) — hold the magnet and glue again. A preceding input
               event identifies an operator release inside the same window. */
            if (settling && !userInitiated) glue();
            else setMagnet(false);
          }
          if (memoryKey && file && (!settling || userInitiated)) {
            rememberScroll(memoryKey, {
              magnet: magnetRef.current,
              fromBottom,
              anchor: magnetRef.current ? null : viewportAnchor(el, tailPath ?? file.path),
            });
          }
          if (el.scrollTop < 120 && canRevealOlder && !tail.loadingOlder && !tail.loading) revealOlder();
        }}
      >
      <div ref={content} className={compact ? "px-3 pb-3 text-body" : "mx-auto w-full max-w-[1060px] px-6 pb-4"}>
        {!file ? (
          <div className="mt-[20vh] text-center text-muted">{t("feed.pickLog")}</div>
        ) : (
          <>
            {compact && canRevealOlder ? (
              <button
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-control border border-dashed border-border bg-sunken px-2 py-1 text-label font-semibold text-muted [@media(pointer:coarse)]:min-h-11 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                disabled={tail.loadingOlder}
                onClick={revealOlder}
              >
                {tail.loadingOlder ? (
                  t("common.loading")
                ) : (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden /> {t("feed.showEarlier")}
                  </>
                )}
              </button>
            ) : null}
            {!compact && canRevealOlder && feed.items.length ? (
              <button
                className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-control border border-dashed border-border bg-sunken px-3 py-1.5 text-ui font-semibold text-muted [@media(pointer:coarse)]:min-h-11 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                disabled={tail.loadingOlder}
                onClick={revealOlder}
              >
                {tail.loadingOlder
                  ? t("common.loading")
                  : hiddenLocal
                    ? t("feed.showEarlierHidden", { count: hiddenLocal })
                    : t("feed.loadEarlier")}
              </button>
            ) : null}
            {!compact && !canRevealOlder && feed.items.length ? (
              <div className="mb-3 text-center text-[11px] text-muted">{t("feed.startOfConvo")}</div>
            ) : null}
            {compact ? null : <TaskHeader file={file} />}
            {feed.items.length ? (
              visibleItems.map(({ anchorKey, key, item, responseDurationMs }, visibleIndex) => {
                const answer = speakableAnswer(feed.items, visibleStartIndex + visibleIndex);
                const speakText = answer?.firstIndex === visibleStartIndex + visibleIndex ? answer.text : undefined;
                return (
                  /* Session-stable keys: a row keeps its DOM node while the
                     window slides. Compact panes live on the zoomable canvas:
                     off-screen rows skip layout/paint via content-visibility. */
                  <div
                    key={key}
                    data-feed-key={anchorKey ?? undefined}
                    data-feed-kind={item.kind}
                    data-feed-source-id={"sourceId" in item ? item.sourceId : undefined}
                    className={compact ? "feed-cv" : undefined}
                  >
                    <FeedItem item={item} speakText={speakText} />
                    {responseDurationMs !== undefined ? <ResponseDuration durationMs={responseDurationMs} /> : null}
                  </div>
                );
              })
            ) : windowTail ? null : (
              <div className="mt-[14vh] text-center text-muted">
                {tail.loading
                  ? t("common.loadingCap")
                  : tail.size === 0
                    ? t("feed.noOutput")
                    : feed.hiddenServiceCount
                      ? t("feed.onlyService", { count: feed.hiddenServiceCount })
                      : t("feed.empty")}
                {!tail.loading && (file.cmdDesc || file.cmd) ? (
                  <div className="mx-auto mt-3 max-w-[560px]">
                    {file.cmdDesc ? <div className="text-[12.5px] font-semibold text-primary">{file.cmdDesc}</div> : null}
                    {file.cmd ? (
                      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border border-border bg-canvas px-3 py-2 text-left font-mono text-[11.5px] text-primary">
                        {file.cmd}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            {/* One window tail for every lifecycle state (issue #569), rendered
                strictly in the canonical chronological order owned by
                `orderedConversationTail` (round-1 P1#3): launch/delivery status
                chips, THEN the operator's own pending user bubbles (the prompt),
                THEN the streaming assistant delta (the reply). Driving the order
                from that pure helper keeps prompt→reply chronology even while the
                file path is still `spawn:<launchId>` and the transcript has not
                flushed a single item, and makes the order directly testable. */}
            {orderedConversationTail({
              launch: Boolean(launch),
              outbox: Boolean(memoryKey && pendingOutbox.length),
              delta: visibleLiveTurnItems.length > 0,
            }).map((section) => {
              if (section === "launch") return <LaunchChips key="launch" launch={launch!} onRetry={onLaunchRetry} />;
              if (section === "outbox") {
                /* While this card is switching accounts the server holds every
                   delivery it admits, so the bubble — the message's ONE delivery
                   state — is what says the message waits for the switch. A hold
                   annotation the card has already satisfied (its target IS the
                   active account) says nothing: the switch is over. */
                const liveMigration = activeCardMigration(file.migration, accountIdFromPath(file.path));
                const switchHold = migrationHoldsDelivery(cardMigrationState(liveMigration))
                  ? { label: migrationTargetName(liveMigration) }
                  : null;
                /* #1213: the bubble may only name a turn when the host says a
                   turn is running, so it reads the same axes the composer's
                   receipt rows do. */
                return (
                  <OutboxBubbles
                    key="outbox"
                    cardId={memoryKey!}
                    entries={pendingOutbox}
                    switchHold={switchHold}
                    session={runtimeSession ? { host: runtimeSession.host, turn: runtimeSession.turn } : null}
                  />
                );
              }
              return <LiveTurnRows key="delta" items={visibleLiveTurnItems} />;
            })}
            <ConversationAttention file={file} />
            {/* #1202: the manager's reply drafts, directly under its latest
                turn — one tap from the operator's composer. Absent unless the
                conversation actually has a set, and yielded to the pinned row
                above the composer once the magnet is released and that turn is
                no longer the thing the operator is looking at, so the drafts
                are offered in exactly one place at a time. */}
            {magnet ? (
              <SuggestedReplies
                file={file}
                revision={suggestionsRevision}
                items={feed.items}
                outbox={pendingOutbox}
              />
            ) : null}
            {feed.items.length && !file.pendingQuestion && !file.waitingInput && endedQuestion ? (
              <div className="my-4 rounded-[8px] border border-border bg-sunken px-4 py-3 text-[13px] font-semibold text-muted">{endedQuestion}</div>
            ) : null}
            {feed.items.length && file.activity === "recent" && isAwaitingUser(file) ? (
              <div className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-warning">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" aria-hidden /> {t("feed.finishedTurn")}
              </div>
            ) : feed.items.length && file.activity === "recent" && isSubagent(file) && file.proc !== "running" ? (
              <div className="mt-2 flex items-center gap-1 text-[11.5px] font-semibold text-accent">
                <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> {t("feed.returnedResult")}
              </div>
            ) : null}
          </>
        )}
        </div>
      </div>
    </div>
    {/* Bottom working-status slot: live elapsed from the transcript receipt.
        Completed totals stay beside their response rows in the scroller. */}
    {file ? (
      <TurnStatusBar file={file} workingLabel={working.label} workingIcon={working.icon} compact={compact} />
    ) : null}
    </div>
    </MessageProvenanceProvider>
    </RawLineProvider>
  );
}
