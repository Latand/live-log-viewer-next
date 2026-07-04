"use client";

import { ArrowDownToLine, CornerDownRight, type LucideIcon, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ArrowDown, ChevronUp, Sparkle } from "@/components/icons";
import { useLogTail } from "@/hooks/useLogTail";
import type { FileEntry } from "@/lib/types";

import { isAwaitingUser } from "@/hooks/useSwitchboardData";

import { buildFeed, FeedItem } from "./feed/renderers";
import { QuestionCard } from "./feed/QuestionCard";
import { isSubagent } from "./projectModel";
import { TaskHeader } from "./TaskHeader";

/** Items rendered initially and added per «показати раніше» step. */
const RENDER_STEP = 1500;

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
  /* The scroll magnet lives per feed instance, so each column remembers its
     own state across polls: glued to the live tail, or released by the user. */
  const [magnet, setMagnetState] = useState(follow);
  /* Released reader must never lose lines above the viewport: the tail cap
     applies only while the magnet holds the bottom in view anyway. */
  const tail = useLogTail(file, paused, magnet && compact ? 2500 : 0);
  const scroller = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<{ top: number; height: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(RENDER_STEP);
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
  useEffect(() => setVisibleCount(RENDER_STEP), [file?.path]);
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
      queueMicrotask(() => setEndedQuestion("агент завершився"));
      hadQuestionRef.current = false;
    }
  }, [file?.pendingQuestion?.toolUseId, file?.proc, file]);

  const feed = useMemo(
    () => (file ? buildFeed(file, tail.lines, showSvc, lineFilter.toLowerCase()) : { items: [], hiddenServiceCount: 0 }),
    [file, tail.lines, showSvc, lineFilter],
  );
  const hiddenLocal = Math.max(0, feed.items.length - visibleCount);
  const visibleItems = hiddenLocal ? feed.items.slice(-visibleCount) : feed.items;

  useEffect(() => {
    const time = tail.tickTime?.toLocaleTimeString("uk", { hour12: false }) ?? "";
    if (tail.error) onStatus(tail.error);
    else if (file) onStatus(`${(tail.size / 1024).toFixed(0)} kB${time ? " · " + time : ""}`);
    else onStatus("");
  }, [tail.error, tail.size, tail.tickTime, file, onStatus]);

  /* Glued: keep the bottom in view. Released: count what arrived meanwhile
     (prepended history is old content, so it stays out of the counter). */
  useEffect(() => {
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
  }, [feed.items.length, magnet, tail.prependGen]);

  /* Older history grows the content above the viewport; keep what the user
     was reading in place by compensating the scroll offset. */
  useLayoutEffect(() => {
    const el = scroller.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    anchorRef.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [tail.prependGen, visibleCount]);

  const revealOlder = () => {
    const el = scroller.current;
    if (el) anchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    if (hiddenLocal) setVisibleCount((value) => value + RENDER_STEP);
    else if (tail.hasMore) void tail.loadOlder().then(() => setVisibleCount((value) => value + RENDER_STEP));
  };
  const canRevealOlder = hiddenLocal > 0 || tail.hasMore;

  const lastItem = feed.items.at(-1);
  const working: { icon: LucideIcon; label: string } =
    lastItem?.kind === "cmd" && lastItem.call.status === "run"
      ? { icon: Wrench, label: `виконує ${lastItem.call.cmd.split(/[\s:]/, 1)[0] || "інструмент"}…` }
      : lastItem?.kind === "think"
        ? { icon: Sparkle, label: "думає…" }
        : { icon: Sparkle, label: "працює…" };

  const jumpToTail = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setMagnet(true, true);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {file && feed.items.length ? (
        magnet ? (
          file.activity === "live" ? (
            <div
              className={`pointer-events-none absolute bottom-2 right-3 z-10 inline-flex items-center gap-1 rounded-full bg-ok px-2 py-0.5 text-[10px] font-bold text-white shadow-card transition-transform duration-200 ${
                pulse ? "scale-125" : "scale-100"
              }`}
            >
              <ArrowDownToLine className="h-3 w-3" aria-hidden /> живий хвіст
            </div>
          ) : null
        ) : (
          <button
            className="absolute bottom-2 right-3 z-10 inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-semibold text-ink shadow-card hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Повернутись до живого хвоста"
            onClick={jumpToTail}
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden /> {newCount ? `${newCount} нових` : "вниз"}
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
      <div className={compact ? "px-3 pb-4 text-[13px]" : "mx-auto w-full max-w-[1060px] px-6 pb-16"}>
        {!file ? (
          <div className="mt-[20vh] text-center text-dim">Вибери лог зліва — стрічка оновлюється сама</div>
        ) : (
          <>
            {compact && canRevealOlder ? (
              <button
                className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-line bg-bg px-2 py-1 text-[11px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                disabled={tail.loadingOlder}
                onClick={revealOlder}
              >
                {tail.loadingOlder ? (
                  "завантаження…"
                ) : (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden /> показати раніше
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
                  ? "завантаження…"
                  : hiddenLocal
                    ? `показати раніше (сховано ${hiddenLocal})`
                    : "завантажити раніше з файлу"}
              </button>
            ) : null}
            {!compact && !canRevealOlder && feed.items.length ? (
              <div className="mb-3 text-center text-[11px] text-dim">початок розмови</div>
            ) : null}
            {compact ? null : <TaskHeader file={file} files={files} onSelect={onSelect} />}
            {feed.items.length ? (
              <>
                {visibleItems.map((item, idx) => (
                  <FeedItem key={idx + feed.items.length - visibleItems.length} item={item} />
                ))}
                {file.pendingQuestion || file.waitingInput ? <QuestionCard key={file.pendingQuestion?.toolUseId ?? "waiting"} file={file} /> : null}
                {!file.pendingQuestion && !file.waitingInput && endedQuestion ? (
                  <div className="my-4 rounded-[8px] border border-line bg-chip px-4 py-3 text-[13px] font-semibold text-dim">{endedQuestion}</div>
                ) : null}
                {file.activity === "live" ? <WorkingRow icon={working.icon} label={working.label} /> : null}
                {file.activity === "recent" && isAwaitingUser(file) ? (
                  <div className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-[#b8860b]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#d29a2f]" aria-hidden /> закінчив хід — чекає відповіді
                  </div>
                ) : file.activity === "recent" && isSubagent(file) && file.proc !== "running" ? (
                  <div className="mt-2 flex items-center gap-1 text-[11.5px] font-semibold text-accent">
                    <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> повернувся з результатом
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-[14vh] text-center text-dim">
                {tail.loading
                  ? "Завантаження…"
                  : tail.size === 0
                    ? "Ще без виводу — файл поки порожній"
                    : feed.hiddenServiceCount
                      ? `Видимих повідомлень нема — лише службові записи (${feed.hiddenServiceCount}). Натисни «Службові»`
                      : "Порожньо (немає рядків для показу)"}
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
