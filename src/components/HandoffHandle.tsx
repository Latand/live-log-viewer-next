"use client";

import { ArrowRightLeft, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Check, X } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { ProcessStatusChip } from "./TaskHeader";
import { cleanTitle, engineBadge, engineTintOf, modelTint } from "./utils";

type Engine = "claude" | "codex";

const ENGINES: { key: Engine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

/** Vertical travel limits: below the pane header, above the composer. The
    composer's height varies (sent queue, image strip), so the bottom limit is
    measured from its live rect; BOTTOM_PAD is the gap kept above it. */
const TOP_PAD = 56;
const BOTTOM_PAD = 24;
/** Per-frame catch-up fraction of the remaining distance to the cursor. */
const LERP = 0.18;
/** Resting Y for the static (touch) variant and before the first move. */
const REST_Y = 88;
const HOVER_OPEN_MS = 130;
/** Minimum gap between the card and the pane's top/bottom edges. */
const CARD_GAP = 8;

/** Wrapper-relative card position clamped into the pane at open time; content
    taller than maxH scrolls instead of clipping under the pane's
    overflow-hidden. */
interface CardBox {
  top?: number;
  bottom?: number;
  maxH: number;
}

/** Handoff targets an on-disk transcript another agent can read back. */
export function canHandoff(file: FileEntry): boolean {
  return (file.root === "claude-projects" || file.root === "codex-sessions") && file.path.endsWith(".jsonl");
}

function engineStyle(engine: Engine): React.CSSProperties {
  const tint = engineTintOf(engine);
  return { backgroundColor: tint.soft, color: tint.color, borderColor: tint.color };
}

interface Props {
  file: FileEntry;
  /** Pane element the pill tracks the cursor within. */
  paneRef: React.RefObject<HTMLElement | null>;
}

/**
 * Cursor-following handoff pill on the left edge of an open conversation pane.
 * It glides to the pointer's height (rAF lerp on `transform` only, so the feed
 * never relayouts) and expands on hover into a card that spawns a fresh agent
 * inheriting this conversation's transcript path and working directory via the
 * existing /api/spawn machinery.
 */
export function HandoffHandle({ file, paneRef }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ target: REST_Y, current: REST_Y, raf: 0 });
  const openRef = useRef(false);
  const hoverTimer = useRef<number | null>(null);
  const copyTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [cardBox, setCardBox] = useState<CardBox>({ top: -18, maxH: 480 });
  const [hoverFine, setHoverFine] = useState(false);
  const [engine, setEngine] = useState<Engine>(file.engine === "codex" ? "codex" : "claude");
  const [cwd, setCwd] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [prompt, setPrompt] = useState(() => `Прочитай розмову агента у файлі ${file.path} і продовж роботу звідти: `);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const dirsListId = useId();

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setHoverFine(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setHoverFine(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* The magnet: pane-level pointermove records the cursor height, a rAF loop
     eases the pill toward it and writes only `transform` on the wrapper —
     never React state — so following the cursor costs no re-renders. */
  useEffect(() => {
    const pane = paneRef.current;
    const wrap = wrapRef.current;
    if (!pane || !wrap || !hoverFine) return;
    const pos = posRef.current;
    const apply = () => {
      wrap.style.transform = `translate3d(0, ${pos.current}px, 0)`;
    };
    const step = () => {
      const gap = pos.target - pos.current;
      if (Math.abs(gap) < 0.4) {
        pos.current = pos.target;
        apply();
        pos.raf = 0;
        return;
      }
      pos.current += gap * LERP;
      apply();
      pos.raf = requestAnimationFrame(step);
    };
    const onMove = (event: PointerEvent) => {
      if (openRef.current) return;
      const rect = pane.getBoundingClientRect();
      /* The wrapper renders right after TmuxComposer, so the previous sibling
         is the composer whose top caps the pill's travel. */
      const composerTop = wrap.previousElementSibling?.getBoundingClientRect().top ?? rect.bottom;
      const limit = Math.max(TOP_PAD, composerTop - rect.top - BOTTOM_PAD);
      pos.target = Math.min(limit, Math.max(TOP_PAD, event.clientY - rect.top));
      if (!pos.raf) pos.raf = requestAnimationFrame(step);
    };
    apply();
    pane.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      pane.removeEventListener("pointermove", onMove);
      if (pos.raf) cancelAnimationFrame(pos.raf);
      pos.raf = 0;
      /* A hover-capability flip (convertible switching to tablet mode) must
         park the now-static touch target back at its resting spot. */
      pos.target = REST_Y;
      pos.current = REST_Y;
      wrap.style.transform = `translate3d(0, ${REST_Y}px, 0)`;
    };
  }, [paneRef, hoverFine]);

  useEffect(
    () => () => {
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const setOpenBoth = (value: boolean) => {
    openRef.current = value;
    setOpen(value);
  };

  const openCard = () => {
    if (openRef.current) return;
    const pane = paneRef.current;
    /* Anchor near the pill, away from the nearest pane edge, and cap the
       height so the whole card always fits inside the pane. */
    if (pane) {
      const height = pane.getBoundingClientRect().height;
      const y = posRef.current.current;
      if (y > height * 0.55) {
        const edge = Math.min(y + 18, height - CARD_GAP);
        setCardBox({ bottom: y - edge, maxH: edge - CARD_GAP });
      } else {
        const edge = Math.max(CARD_GAP, y - 18);
        setCardBox({ top: edge - y, maxH: height - edge - CARD_GAP });
      }
    }
    setOpenBoth(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenBoth(false);
    };
    /* pointerdown covers mouse, touch and pen, so a tap outside also closes. */
    const onDown = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpenBoth(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  /* The inherited working directory comes from the transcript head on the
     server; recent project directories back it up as suggestions. */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/spawn?project=" + encodeURIComponent(file.project) + "&src=" + encodeURIComponent(file.path))
      .then((res) => res.json() as Promise<{ dirs?: string[]; cwd?: string | null }>)
      .then((json) => {
        if (cancelled) return;
        if (Array.isArray(json.dirs)) setDirs(json.dirs);
        const inherited = typeof json.cwd === "string" ? json.cwd : "";
        setCwd((prev) => prev || inherited || json.dirs?.[0] || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, file.project, file.path]);

  const copyPath = () => {
    navigator.clipboard
      ?.writeText(file.path)
      .then(() => {
        setCopied(true);
        if (copyTimer.current) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const spawn = async () => {
    if (busy || !cwd.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine, cwd: cwd.trim(), prompt }),
      });
      const json = (await res.json()) as { ok?: boolean; target?: string; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося запустити" });
        return;
      }
      setStatus({ kind: "ok", text: `запущено в tmux ${json.target ?? ""} — скоро з'явиться в списку` });
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setBusy(false);
    }
  };

  const badge = engineBadge(file);
  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute left-1.5 top-0 z-40 h-0 w-0"
      style={{ transform: `translate3d(0, ${REST_Y}px, 0)`, willChange: "transform" }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="Перекинути розмову іншому агенту"
        title="перекинути розмову іншому агенту"
        onPointerEnter={() => {
          if (!hoverFine || openRef.current) return;
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          hoverTimer.current = window.setTimeout(openCard, HOVER_OPEN_MS);
        }}
        onPointerLeave={() => {
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          hoverTimer.current = null;
        }}
        onClick={() => {
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          if (openRef.current) setOpenBoth(false);
          else openCard();
        }}
        className={`pointer-events-auto absolute left-0 top-0 flex h-9 w-6 -translate-y-1/2 items-center justify-center rounded-full border bg-panel shadow-card transition-[opacity,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          open ? "border-accent/50 text-accent opacity-100" : "border-line text-dim opacity-60 hover:border-accent/45 hover:text-accent hover:opacity-100"
        }`}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          className="pointer-events-auto absolute left-8 z-50 flex w-[340px] cursor-default flex-col gap-2.5 overflow-y-auto rounded-[12px] border border-line bg-panel p-3 shadow-[0_8px_28px_rgba(20,20,30,0.14)] [&>*]:shrink-0"
          style={{ top: cardBox.top, bottom: cardBox.bottom, maxHeight: cardBox.maxH }}
        >
          <div className="flex items-center gap-1.5">
            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-[12px] font-bold">перекинути розмову іншому агенту</span>
            <button
              type="button"
              aria-label="Закрити картку передачі"
              onClick={() => setOpenBoth(false)}
              className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          <div className="truncate text-[10.5px] font-semibold text-dim" title={cleanTitle(file.title)}>
            {cleanTitle(file.title, 70)}
          </div>
          <div className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-bg px-2 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="w-[64px] shrink-0 text-[10px] font-semibold text-dim">агент</span>
              <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={badge.style}>
                {badge.label}
              </span>
              {file.model ? (
                <span
                  className="min-w-0 truncate rounded-full px-1.5 py-0.5 font-mono text-[9px] font-semibold"
                  style={{ backgroundColor: modelTint(file).soft, color: modelTint(file).color }}
                >
                  {file.model}
                </span>
              ) : null}
              <ProcessStatusChip file={file} />
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="w-[64px] shrink-0 text-[10px] font-semibold text-dim">транскрипт</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink" title={file.path}>
                {file.path}
              </span>
              <button
                type="button"
                aria-label="Скопіювати шлях транскрипта"
                onClick={copyPath}
                className={`inline-flex shrink-0 items-center rounded-[8px] border border-line bg-panel px-1.5 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  copied ? "text-ok" : "text-dim hover:text-accent"
                }`}
              >
                {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              </button>
            </div>
            {file.kind ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="w-[64px] shrink-0 text-[10px] font-semibold text-dim">тип</span>
                <span className="min-w-0 truncate text-[10.5px] font-semibold text-ink">{file.kind}</span>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Кому передати розмову">
            {ENGINES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={engine === key}
                onClick={() => setEngine(key)}
                style={engine === key ? engineStyle(key) : undefined}
                className={`flex-1 rounded-[8px] border px-2 py-1.5 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  engine === key ? "" : "border-line bg-bg text-dim hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
            директорія (успадкована)
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              list={dirsListId}
              placeholder="/home/…/Projects/…"
              aria-label="Робоча директорія нового агента"
              className="rounded-[8px] border border-line bg-bg px-2 py-1.5 font-mono text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <datalist id={dirsListId}>
              {dirs.map((dir) => (
                <option key={dir} value={dir} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
            промпт для нового агента
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="що зробити далі…"
              aria-label="Промпт для нового агента"
              className="resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[12px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <div className="flex items-center">
            <button
              type="button"
              disabled={busy || !cwd.trim()}
              onClick={() => void spawn()}
              className="ml-auto rounded-[8px] border border-accent bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            >
              {busy ? "перекидаю…" : "▶ Перекинути"}
            </button>
          </div>
          {busy ? <span className="text-[10.5px] text-dim">чекаю, поки CLI підніметься (до хвилини)…</span> : null}
          {status ? (
            <span className={`text-[11px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>{status.text}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
