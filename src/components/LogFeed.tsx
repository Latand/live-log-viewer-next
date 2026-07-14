"use client";

import { ArrowDownToLine, CornerDownRight, type LucideIcon, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ChevronUp, Sparkle } from "@/components/icons";
import { useLogTail } from "@/hooks/useLogTail";
import { conversationIdentity } from "@/lib/accounts/identity";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { isAwaitingUser } from "@/hooks/useSwitchboardData";

import { createFeedSession, type FeedSession, type FeedSnapshot } from "./feed/parse";
import { FeedItem } from "./feed/FeedItem";
import { RawLineProvider, type RawLineLookup } from "./feed/rawLine";
import { BoundedLru } from "./feed/scrollMemory";
import { ConversationAttention } from "./runtime/ConversationAttention";
import { speakableAnswer } from "./feed/speakableAnswer";
import { isSubagent } from "./projectModel";
import { TaskHeader } from "./TaskHeader";
import { workedCaption } from "./turnDuration";

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

/** Animated presence row: the agent of a live transcript is mid-turn right now. */
function WorkingRow({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-success">
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:300ms]" />
      </span>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </div>
  );
}

/** Muted caption after the final message once the turn is complete, mirroring
    the codex TUI's "Worked for …" line (issue #231). Renders nothing while the
    turn is still running — `workedCaption` returns null until `endedAt` is set. */
function WorkedSeparator({ file }: { file: FileEntry }) {
  const caption = workedCaption(file);
  if (!caption) return null;
  return (
    <div className="mt-3 flex items-center gap-2 text-[11px] font-semibold text-muted" role="note">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="tabular-nums">{caption}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
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
}

export function LogFeed({ file, showSvc, lineFilter, onStatus, paused, follow, setFollow, compact = false }: Props) {
  const { locale, t } = useLocale();
  const memoryKey = file ? conversationIdentity(file) : null;
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

  /* Compact panes center the floating pill: on the phone a right-anchored
     pill would sit over the tool rows' status column. */
  const pillPos = compact ? "left-1/2 -translate-x-1/2" : "right-3";

  return (
    <RawLineProvider value={getRawLine}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      {file && feed.items.length ? (
        magnet ? (
          file.activity === "live" ? (
            <div
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
              <>
                {visibleItems.map(({ anchorKey, key, item }, visibleIndex) => {
                  const answer = speakableAnswer(feed.items, visibleStartIndex + visibleIndex);
                  const speakText = answer?.firstIndex === visibleStartIndex + visibleIndex ? answer.text : undefined;
                  return (
                    /* Session-stable keys: a row keeps its DOM node while the
                       window slides. Compact panes live on the zoomable canvas:
                       off-screen rows skip layout/paint via content-visibility. */
                    <div key={key} data-feed-key={anchorKey ?? undefined} className={compact ? "feed-cv" : undefined}>
                      <FeedItem item={item} speakText={speakText} />
                    </div>
                  );
                })}
                <ConversationAttention file={file} />
                {!file.pendingQuestion && !file.waitingInput && endedQuestion ? (
                  <div className="my-4 rounded-[8px] border border-border bg-sunken px-4 py-3 text-[13px] font-semibold text-muted">{endedQuestion}</div>
                ) : null}
                {file.activity === "live" ? <WorkingRow icon={working.icon} label={working.label} /> : null}
                {file.activity === "recent" && isAwaitingUser(file) ? (
                  <div className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-warning">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" aria-hidden /> {t("feed.finishedTurn")}
                  </div>
                ) : file.activity === "recent" && isSubagent(file) && file.proc !== "running" ? (
                  <div className="mt-2 flex items-center gap-1 text-[11.5px] font-semibold text-accent">
                    <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> {t("feed.returnedResult")}
                  </div>
                ) : null}
                <WorkedSeparator file={file} />
              </>
            ) : (
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
            {feed.items.length ? null : <ConversationAttention file={file} />}
          </>
        )}
        </div>
      </div>
    </div>
    </RawLineProvider>
  );
}
