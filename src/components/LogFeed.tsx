"use client";

import { ArrowDownToLine, CornerDownRight, type LucideIcon, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ChevronUp, Sparkle } from "@/components/icons";
import { useLogTail } from "@/hooks/useLogTail";
import { getLocale, translate, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { isAwaitingUser } from "@/hooks/useSwitchboardData";

import { buildFeed } from "./feed/parse";
import { FeedItem } from "./feed/FeedItem";
import { QuestionCard } from "./feed/QuestionCard";
import { isSubagent } from "./projectModel";
import { TaskHeader } from "./TaskHeader";

/** Items rendered initially and added per «показати раніше» step. */
const RENDER_STEP = 1500;
/** Compact scheme panes keep the DOM small — five agents on the canvas must
    not mount thousands of message nodes each; «показати раніше» still walks
    the full history in steps. */
const COMPACT_INITIAL = 300;
const COMPACT_STEP = 500;
/** Live-tail window while the magnet holds the bottom. Touch devices run on
    a far smaller tab memory budget (iOS kills the renderer past it), so the
    window shrinks there; «показати раніше» still walks the full history. */
const TAIL_CAP = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? 500 : 2500;

/** Animated presence row: the agent of a live transcript is mid-turn right now. */
function WorkingRow({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[12px] font-semibold text-ok">
      <span className="flex items-center gap-0.5" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ok [animation-delay:300ms]" />
      </span>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {label}
    </div>
  );
}

interface Props {
  file: FileEntry | null;
  files: FileEntry[];
  onSelect: (file: FileEntry) => void;
  showSvc: boolean;
  lineFilter: string;
  onStatus: (status: string) => void;
  paused: boolean;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  compact?: boolean;
}

export function LogFeed({ file, files, onSelect, showSvc, lineFilter, onStatus, paused, follow, setFollow, compact = false }: Props) {
  const { locale, t } = useLocale();
  /* The scroll magnet lives per feed instance, so each column remembers its
     own state across polls: glued to the live tail, or released by the user. */
  const [magnet, setMagnetState] = useState(follow);
  /* Released reader must never lose lines above the viewport: the tail cap
     applies only while the magnet holds the bottom in view anyway. */
  const tail = useLogTail(file, paused, magnet && compact ? TAIL_CAP : 0);
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

  const setMagnet = (value: boolean, withPulse = false) => {
    magnetRef.current = value;
    setMagnetState(value);
    setFollow(value);
    if (value) setNewCount(0);
    if (withPulse) {
      setPulse(true);
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulse(false), 450);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setVisibleCount(initialCount), [file?.path, initialCount]);
  /* External Follow toggle (focus header) drives the same magnet. */
  useEffect(() => {
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

  /* buildFeed reads only engine/fmt/activity off the file: depending on those
     fields (not the object identity, which changes every /api/files poll)
     keeps item identities stable, so memoized FeedItems skip re-rendering. */
  const feed = useMemo(
    () => (file ? buildFeed(file, tail.lines, showSvc, lineFilter.toLowerCase()) : { items: [], hiddenServiceCount: 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file?.path, file?.engine, file?.fmt, file?.activity, tail.lines, showSvc, lineFilter, locale],
  );
  const hiddenLocal = Math.max(0, feed.items.length - visibleCount);
  const visibleItems = hiddenLocal ? feed.items.slice(-visibleCount) : feed.items;

  useEffect(() => {
    const time = tail.tickTime?.toLocaleTimeString(getLocale() === "uk" ? "uk-UA" : "en-US", { hour12: false }) ?? "";
    if (tail.error) onStatus(tail.error);
    else if (file) onStatus(`${(tail.size / 1024).toFixed(0)} kB${time ? " · " + time : ""}`);
    else onStatus("");
  }, [tail.error, tail.size, tail.tickTime, file, onStatus]);

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
    if (magnet) {
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    } else if (!prepended && delta > 0) {
      setNewCount((count) => count + delta);
    }
  }, [feed.items, magnet, tail.prependGen]);

  /* Height also changes without the item list changing — images decode, the
     working/question rows toggle. Re-glue on any content resize while glued. */
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (magnetRef.current) el.scrollTop = el.scrollHeight;
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

  const lastItem = feed.items.at(-1);
  const working: { icon: LucideIcon; label: string } =
    lastItem?.kind === "cmd" && lastItem.call.status === "run"
      ? { icon: Wrench, label: t("feed.running", { tool: lastItem.call.cmd.split(/[\s:]/, 1)[0] || t("feed.tool") }) }
      : lastItem?.kind === "think"
        ? { icon: Sparkle, label: t("feed.thinking") }
        : { icon: Sparkle, label: t("feed.working") };

  const jumpToTail = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setMagnet(true, true);
  };

  /* Compact panes center the floating pill: on the phone the bottom-right
     corner belongs to the minimap chip, and a right-anchored pill merges
     into it. */
  const pillPos = compact ? "left-1/2 -translate-x-1/2" : "right-3";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {file && feed.items.length ? (
        magnet ? (
          file.activity === "live" ? (
            <div
              className={`pointer-events-none absolute bottom-2 ${pillPos} z-10 inline-flex items-center gap-1 rounded-full bg-ok px-2 py-0.5 text-[10px] font-bold text-white shadow-card transition-transform duration-200 ${
                pulse ? "scale-125" : "scale-100"
              }`}
            >
              <ArrowDownToLine className="h-3 w-3" aria-hidden /> {t("feed.liveTail")}
            </div>
          ) : null
        ) : (
          <button
            className={`absolute bottom-2 ${pillPos} z-10 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-semibold text-ink shadow-card hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
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
          if (atBottom && !magnetRef.current) setMagnet(true, true);
          else if (!atBottom && magnetRef.current) setMagnet(false);
          if (el.scrollTop < 120 && canRevealOlder && !tail.loadingOlder && !tail.loading) revealOlder();
        }}
      >
      <div ref={content} className={compact ? "px-3 pb-4 text-[13px]" : "mx-auto w-full max-w-[1060px] px-6 pb-16"}>
        {!file ? (
          <div className="mt-[20vh] text-center text-dim">{t("feed.pickLog")}</div>
        ) : (
          <>
            {compact && canRevealOlder ? (
              <button
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-line bg-bg px-2 py-1 text-[11px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
                className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-line bg-panel px-3 py-1.5 text-[12px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
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
              <div className="mb-3 text-center text-[11px] text-dim">{t("feed.startOfConvo")}</div>
            ) : null}
            {compact ? null : <TaskHeader file={file} files={files} onSelect={onSelect} />}
            {feed.items.length ? (
              <>
                {visibleItems.map((item, idx) => {
                  const key = idx + feed.items.length - visibleItems.length;
                  /* Compact panes live on the zoomable canvas: off-screen rows
                     skip layout/paint entirely via content-visibility. */
                  return compact ? (
                    <div key={key} className="feed-cv">
                      <FeedItem item={item} />
                    </div>
                  ) : (
                    <FeedItem key={key} item={item} />
                  );
                })}
                {file.pendingQuestion || file.waitingInput ? <QuestionCard key={file.pendingQuestion?.toolUseId ?? "waiting"} file={file} /> : null}
                {!file.pendingQuestion && !file.waitingInput && endedQuestion ? (
                  <div className="my-4 rounded-[8px] border border-line bg-chip px-4 py-3 text-[13px] font-semibold text-dim">{endedQuestion}</div>
                ) : null}
                {file.activity === "live" ? <WorkingRow icon={working.icon} label={working.label} /> : null}
                {file.activity === "recent" && isAwaitingUser(file) ? (
                  <div className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-[#b8860b]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d29a2f]" aria-hidden /> {t("feed.finishedTurn")}
                  </div>
                ) : file.activity === "recent" && isSubagent(file) && file.proc !== "running" ? (
                  <div className="mt-2 flex items-center gap-1 text-[11.5px] font-semibold text-accent">
                    <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> {t("feed.returnedResult")}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-[14vh] text-center text-dim">
                {tail.loading
                  ? t("common.loadingCap")
                  : tail.size === 0
                    ? t("feed.noOutput")
                    : feed.hiddenServiceCount
                      ? t("feed.onlyService", { count: feed.hiddenServiceCount })
                      : t("feed.empty")}
                {!tail.loading && (file.cmdDesc || file.cmd) ? (
                  <div className="mx-auto mt-3 max-w-[560px]">
                    {file.cmdDesc ? <div className="text-[12.5px] font-semibold text-ink">{file.cmdDesc}</div> : null}
                    {file.cmd ? (
                      <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border border-line bg-bg px-3 py-2 text-left font-mono text-[11.5px] text-ink">
                        {file.cmd}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
            {feed.items.length ? null : file.pendingQuestion || file.waitingInput ? <QuestionCard key={file.pendingQuestion?.toolUseId ?? "waiting"} file={file} /> : null}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
