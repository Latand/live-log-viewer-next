"use client";

import { ArrowDownToLine, CornerDownRight, type LucideIcon, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ChevronUp, Sparkle } from "@/components/icons";
import { useLogTail } from "@/hooks/useLogTail";
import { useRuntimeSessionForConversation } from "@/hooks/useRuntime";
import { conversationIdentity } from "@/lib/accounts/identity";
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
import { publishTranscriptEchoes, seedLaunchOutbox, settleLaunchOutboxDelivered, useOutbox, visibleOutbox } from "./conversation/outbox";
import { createFeedSession, type FeedSession, type FeedSnapshot } from "./feed/parse";
import { FeedItem } from "./feed/FeedItem";
import { RawLineProvider, type RawLineLookup } from "./feed/rawLine";
import { BoundedLru } from "./feed/scrollMemory";
import { ConversationAttention } from "./runtime/ConversationAttention";
import { speakableAnswer } from "./feed/speakableAnswer";
import { isSubagent } from "./projectModel";
import { TaskHeader } from "./TaskHeader";
import { TurnStatusBar } from "./TurnStatusBar";

/** Items rendered initially and added per «show earlier» step. */
const RENDER_STEP = 1500;
/** Compact scheme panes keep the DOM small — five agents on the canvas must
    not mount thousands of message nodes each; «show earlier» still walks
    the full history in steps. */
const COMPACT_INITIAL = 300;
const COMPACT_STEP = 500;
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

/** How long after a programmatic glue a not-at-bottom scroll event is treated
    as layout settling (content-visibility estimates, pane resizes) and glued
    again. User releases are real scrolls that arrive outside this window. */
const GLUE_SETTLE_MS = 300;

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

/** Wall-clock read hoisted out of the component so the React Compiler's purity
    check does not see a bare `Date.now()` in a render-scope closure. */
function nowMs(): number {
  return Date.now();
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
  /* Live streaming text: `delta` events from the structured host render the
     in-flight assistant reply immediately, ahead of the transcript flush. The
     host is resolved by conversation identity FIRST (round-1 P1#3): during
     launch the file path is still `spawn:<launchId>` with no artifact, so an
     artifact-only lookup would miss the live host and drop the first deltas; the
     transcript path stays a fallback for subagents that carry no bus id. */
  const runtimeLiveTurn = useRuntimeSessionForConversation(
    file?.conversationId ?? null,
    file?.path ?? null,
  )?.session.liveTurn ?? null;
  /* The scroll magnet lives per feed instance, so each column remembers its
     own state across polls: glued to the live tail, or released by the user.
     A remount inherits the transcript's remembered state. */
  const [magnet, setMagnetState] = useState(() => (memoryKey ? (scrollMemory.get(memoryKey)?.magnet ?? follow) : follow));
  /* Released reader must never lose lines above the viewport: the tail cap
     applies only while the magnet holds the bottom in view anyway. */
  const tail = useLogTail(file, paused, magnet ? (compact ? TAIL_CAP : FOCUS_CAP) : 0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const initialCount = compact ? COMPACT_INITIAL : RENDER_STEP;
  const revealStep = compact ? COMPACT_STEP : RENDER_STEP;
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const [newCount, setNewCount] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [endedQuestion, setEndedQuestion] = useState<string | null>(null);
  const hadQuestionRef = useRef(false);
  const magnetRef = useRef(magnet);
  const lastLenRef = useRef(0);
  const lastPrependRef = useRef(0);
  const pulseTimer = useRef<number | null>(null);
  const glueAtRef = useRef(0);
  const restoreInitializedPathRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<PendingRestore | null>(null);
  const filePathRef = useRef(file?.path ?? null);
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

  /* Programmatic glue: the scroll event it triggers must never read as the
     user releasing the magnet, so the moment is stamped and the handler
     treats near-in-time off-bottom positions as layout still settling. */
  const glue = () => {
    const el = scroller.current;
    if (!el) return;
    glueAtRef.current = Date.now();
    el.scrollTop = el.scrollHeight;
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
        glueAtRef.current = Date.now();
        el.scrollTop += currentOffset - anchor.offset;
        pending.applied = true;
        return true;
      }
    }
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    glueAtRef.current = Date.now();
    el.scrollTop = Math.max(0, maxScroll - pending.fromBottom);
    if (maxScroll < pending.fromBottom) return false;
    pending.applied = true;
    if (!anchor) pendingRestoreRef.current = null;
    return true;
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setVisibleCount(initialCount), [file?.path, initialCount]);
  /* Same instance, new transcript: pick up that transcript's remembered state. */
  useEffect(() => {
    if (!memoryKey) return;
    const remembered = scrollMemory.get(memoryKey)?.magnet ?? follow;
    if (remembered !== magnetRef.current) {
      magnetRef.current = remembered;
       
      setMagnetState(remembered);
    }
  }, [file?.path, memoryKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const session: FeedSession | null = useMemo(
    () => (file ? createFeedSession({ engine: file.engine, fmt: file.fmt, showSvc, lineFilter: lf }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file?.path, file?.engine, file?.fmt, showSvc, lf, locale],
  );
  const feed = useMemo(
    () => (file && session ? session.feed(tail.lines, tail.linesStart, file.activity === "live") : EMPTY_FEED),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, file?.activity, tail.lines, tail.linesStart],
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
    filePathRef.current = file?.path ?? null;
    restoreInitializedPathRef.current = null;
    pendingRestoreRef.current = null;
  }, [file?.path]);

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
    if (file && len && restoreInitializedPathRef.current !== file.path) {
      restoreInitializedPathRef.current = file.path;
      const remembered = memoryKey ? scrollMemory.get(memoryKey) : undefined;
      pendingRestoreRef.current = !magnet && remembered && (remembered.fromBottom > 0 || remembered.anchor)
        ? { path: file.path, ...remembered, applied: false }
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
  const working: { icon: LucideIcon; label: string } =
    lastItem?.kind === "tool" && lastItem.status === "run"
      ? { icon: Wrench, label: t("feed.running", { tool: (lastItem.command ?? lastItem.summary).split(/[\s:·]/, 1)[0] || t("feed.tool") }) }
      : lastItem?.kind === "think"
        ? { icon: Sparkle, label: t("feed.thinking") }
        : { icon: Sparkle, label: t("feed.working") };

  const jumpToTail = () => {
    glue();
    setMagnet(true, true);
  };

  const transcriptGeneration = file?.path ?? null;
  /* Optimistic bubbles retire on their OWN transcript echo (round-1 P1#4,
     round-2 finding 2): a bubble disappears the moment ITS echo lands, resolved
     causally by occurrence count. A user text that appears twice is two echoes
     that retire two bubbles; a message that predates a queued bubble leaves it
     visible. The counts carry that occurrence information. */
  /* The launch's own first message identity (issue #648): a structured / MCP
     spawn journals its first user record with SDK / agent provenance, so the
     transcript parser renders it as a SYSTEM row, not a `user` bubble — the
     echo-text retirement path would never see it. Its text is still the launch
     prompt's transcript echo, so treat a system-row row that matches a
     launch-owned bubble's own text (raw draft OR scaffolded echo) as that
     bubble's echo. Derived from the outbox so it survives adoption (which strips
     the launch prompt fields from the server projection). */
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
      /* A genuine user bubble is always an echo; a non-user row only echoes the
         launch when it exactly carries a launch-owned bubble's own identity. */
      if (item.kind !== "user" && !launchEchoKeys.has(text.trim())) return [];
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
     folds through transcript adoption, and retires on its transcript echo. */
  useEffect(() => {
    if (!memoryKey || !launch?.launchId) return;
    const promptText = launch.prompt ?? "";
    const promptImages = launch.promptImages ?? 0;
    if (!promptText.trim() && !promptImages) return;
    seedLaunchOutbox(memoryKey, {
      id: launch.launchId,
      text: promptText,
      images: promptImages,
      at: launch.promptAt ?? Date.now(),
      /* The canonical echo identity (issue #615): the bubble displays the raw
         draft but retires on the delivered (possibly scaffolded) transcript
         echo. Reconciled onto a composer-seeded bubble under the same id. */
      ...(launch.promptEcho ? { echoText: launch.promptEcho } : {}),
    });
  }, [memoryKey, launch?.launchId, launch?.prompt, launch?.promptImages, launch?.promptAt, launch?.promptEcho]);
  /* Settle the launch bubble from the delivery receipt the server projects
     (issue #648), independent of any transcript echo. A structured / MCP spawn's
     first message is journaled as a system row (SDK / agent provenance), so echo
     retirement can never fire; the delivered receipt is the proof the prompt
     reached the agent. It settles the bubble to `delivered` with the receipt time
     as `settledAt`, so it retires on the delivered TTL instead of spinning on
     "delivering" forever. Keyed on the launch id and the receipt time only, so it
     still fires on a materialized window that has stripped the prompt fields. */
  useEffect(() => {
    if (!memoryKey || !launch?.launchId) return;
    if (launch.initialMessage !== "delivered" || launch.deliveredAt === undefined) return;
    settleLaunchOutboxDelivered(memoryKey, {
      id: launch.launchId,
      at: launch.promptAt ?? launch.deliveredAt,
      settledAt: launch.deliveredAt,
    });
  }, [memoryKey, launch?.launchId, launch?.initialMessage, launch?.deliveredAt, launch?.promptAt]);
  const pendingOutbox = file ? visibleOutbox(outbox, transcriptEchoCounts, nowMs()) : [];
  useEffect(() => {
    if (!memoryKey || !file) return;
    adoptCanonicalAssistantClaims(file.path, memoryKey);
    publishCanonicalAssistantClaims(memoryKey, feed.items);
  }, [file, memoryKey, feed.items]);
  const visibleLiveTurnItems = useMemo(
    () => visibleRuntimeLiveTurnItems(runtimeLiveTurn, feed.items, assistantClaims),
    [runtimeLiveTurn, feed.items, assistantClaims],
  );
  /* Anything the window shows below the transcript. While it is present an
     empty transcript is not "no output" — it is a conversation mid-launch. */
  const windowTail = visibleLiveTurnItems.length > 0 || pendingOutbox.length > 0 || Boolean(launch);

  /* The floating pill is centered on every surface — the same axis as the
     pinned TurnStatusBar below, per the issue #268 operator note: the two
     bottom elements share one axis and separate slots, so they can never
     collide at any pane width. (A right-anchored pill also sat over the tool
     rows' status column on the phone.) */
  const pillPos = "left-1/2 -translate-x-1/2";

  return (
    <RawLineProvider value={getRawLine}>
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
      <div
        ref={scroller}
        /* Stable geometry hook (issue #419): the chat-first viewport-budget
           capture measures this scroller's rendered height against the usable
           visual viewport to prove the transcript owns its ≥60% share. */
        data-log-feed-scroller
        data-tail-lines-start={tail.linesStart}
        data-tail-line-count={tail.lines.length}
        className={compact ? "min-h-0 flex-1 overflow-y-auto py-3" : "min-h-0 flex-1 overflow-y-auto py-6"}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
          const settling = Date.now() - glueAtRef.current < GLUE_SETTLE_MS;
          if (!settling) pendingRestoreRef.current = null;
          if (atBottom && !magnetRef.current) setMagnet(true, true);
          else if (!atBottom && magnetRef.current) {
            /* Off-bottom right after a programmatic glue is layout settling
               (content-visibility estimates, pane resizes during a scheme
               reshuffle) — hold the magnet and glue again. Real user releases
               arrive outside the settle window. */
            if (settling) glue();
            else setMagnet(false);
          }
          if (memoryKey && file && !settling) {
            rememberScroll(memoryKey, {
              magnet: magnetRef.current,
              fromBottom: Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop),
              anchor: magnetRef.current ? null : viewportAnchor(el, file.path),
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
              visibleItems.map(({ anchorKey, key, item }, visibleIndex) => {
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
              if (section === "outbox") return <OutboxBubbles key="outbox" cardId={memoryKey!} entries={pendingOutbox} />;
              return <LiveTurnRows key="delta" items={visibleLiveTurnItems} />;
            })}
            <ConversationAttention file={file} />
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
    {/* Bottom working-status slot (issue #268): live «працює · 4:32» ticking
        from the initiating prompt, or the frozen «Працював N» total after the
        turn ends. Pinned below the scroller in every pane variant. */}
    {file ? (
      <TurnStatusBar file={file} workingLabel={working.label} workingIcon={working.icon} compact={compact} />
    ) : null}
    </div>
    </RawLineProvider>
  );
}
