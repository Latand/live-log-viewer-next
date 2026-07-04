"use client";

import { Link2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { X } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

import { cleanTitle, engineBadge } from "./utils";

/** Accent of the agent-link gesture: the arrow, the target border highlight
    (see the [data-link-hover] rule in globals.css) and the send button. */
const LINK_COLOR = "#0d9488";
/** Pointer travel that turns a pill press into a link drag instead of a click. */
const DRAG_THRESHOLD = 7;
const CARD_W = 340;
const CARD_MARGIN = 8;
/** Rough card height reserved when clamping it to the bottom viewport edge. */
const CARD_RESERVE = 320;

interface LinkTarget {
  el: HTMLElement;
  file: FileEntry;
}

/* Conversation panes register their DOM node so an arrow dragged from any
   pane can hit-test siblings and deliver to the file they currently render.
   Registration refreshes on every poll, keeping the pid current. */
const targets = new Map<string, LinkTarget>();

export function registerLinkTarget(file: FileEntry, el: HTMLElement): () => void {
  targets.set(file.path, { el, file });
  return () => {
    if (targets.get(file.path)?.el === el) targets.delete(file.path);
  };
}

function targetAt(x: number, y: number, excludePath: string): LinkTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-link-path]");
  const path = el?.getAttribute("data-link-path");
  if (!el || !path || path === excludePath) return null;
  const hit = targets.get(path);
  return hit && hit.el === el ? hit : null;
}

function clearHighlight() {
  for (const el of document.querySelectorAll("[data-link-hover]")) el.removeAttribute("data-link-hover");
}

/** S-curve from the pill toward the cursor or the drop point. */
function arrowD(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(48, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

interface DragState {
  startX: number;
  startY: number;
  anchorX: number;
  anchorY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  hover: LinkTarget | null;
  detach: () => void;
}

interface DropState {
  file: FileEntry;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/**
 * Drag-to-link gesture off the handoff pill: pull an arrow onto another
 * agent's pane (its border lights up in the link color while hovered) and a
 * drop opens a card that sends that agent this conversation's transcript path
 * plus a user-written ask, through the existing /api/tmux delivery.
 *
 * The arrow follows the cursor via direct `d` writes on the SVG path — no
 * React state per move — matching how the pill itself tracks the pointer.
 */
export function useAgentLink(source: FileEntry, onDragStart?: () => void) {
  const [dragging, setDragging] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const stateRef = useRef<DragState | null>(null);
  const draggingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pathRef = useRef<SVGPathElement | null>(null);
  const rawId = useId();
  /* useId emits characters url(#…) cannot address; only [A-Za-z0-9-] stays. */
  const markerId = "link-arrow-" + rawId.replace(/[^a-zA-Z0-9-]/g, "");

  useEffect(
    () => () => {
      stateRef.current?.detach();
      stateRef.current = null;
      document.body.style.cursor = "";
      clearHighlight();
    },
    [],
  );

  const onPillPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (stateRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();

    const onMove = (ev: PointerEvent) => {
      const st = stateRef.current;
      if (!st) return;
      st.lastX = ev.clientX;
      st.lastY = ev.clientY;
      if (!st.active) {
        if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) < DRAG_THRESHOLD) return;
        st.active = true;
        draggingRef.current = true;
        suppressClickRef.current = true;
        document.body.style.cursor = "crosshair";
        clearHighlight();
        setDrop(null);
        setAnchor({ x: st.anchorX, y: st.anchorY });
        setDragging(true);
        onDragStart?.();
      }
      pathRef.current?.setAttribute("d", arrowD(st.anchorX, st.anchorY, ev.clientX, ev.clientY));
      const hit = targetAt(ev.clientX, ev.clientY, source.path);
      if (hit?.el !== st.hover?.el) {
        st.hover?.el.removeAttribute("data-link-hover");
        hit?.el.setAttribute("data-link-hover", "1");
        st.hover = hit;
      }
    };

    const onUp = (ev: PointerEvent) => {
      const st = stateRef.current;
      stateRef.current = null;
      st?.detach();
      draggingRef.current = false;
      document.body.style.cursor = "";
      if (!st?.active) return;
      setDragging(false);
      if (st.hover) {
        /* The target keeps its highlight while the ask card is open. */
        setDrop({
          file: st.hover.file,
          from: { x: st.anchorX, y: st.anchorY },
          to: { x: ev.clientX, y: ev.clientY },
        });
      } else {
        clearHighlight();
      }
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    stateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      anchorX: rect.right,
      anchorY: rect.top + rect.height / 2,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      hover: null,
      detach,
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** True once right after a drag, so the pill's click handler can skip. */
  const consumeClick = () => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  };

  const closeDrop = () => {
    clearHighlight();
    setDrop(null);
  };

  const overlay =
    dragging || drop
      ? createPortal(
          <div className="pointer-events-none fixed inset-0 z-[95]">
            <svg className="block h-full w-full">
              <defs>
                <marker id={markerId} markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
                  <path d="M0,0 L8,4.5 L0,9 Z" fill={LINK_COLOR} />
                </marker>
              </defs>
              <path
                ref={(el) => {
                  pathRef.current = el;
                  /* First paint mid-drag: the move handler wrote nothing yet
                     because the path mounts on the render the drag started. */
                  const st = stateRef.current;
                  if (el && st?.active) el.setAttribute("d", arrowD(st.anchorX, st.anchorY, st.lastX, st.lastY));
                }}
                d={drop ? arrowD(drop.from.x, drop.from.y, drop.to.x, drop.to.y) : undefined}
                fill="none"
                stroke={LINK_COLOR}
                strokeWidth={2.5}
                strokeLinecap="round"
                markerEnd={`url(#${markerId})`}
              />
              <circle cx={drop ? drop.from.x : (anchor?.x ?? 0)} cy={drop ? drop.from.y : (anchor?.y ?? 0)} r={4} fill={LINK_COLOR} />
            </svg>
            {drop ? <LinkAskCard key={drop.file.path} source={source} drop={drop} onClose={closeDrop} /> : null}
          </div>,
          document.body,
        )
      : null;

  return { onPillPointerDown, consumeClick, draggingRef, overlay };
}

/**
 * The ask card at the drop point: shows who receives the link, what context
 * they get, and requires a written ask before sending. Delivery goes through
 * POST /api/tmux — a live pane gets the text pasted in, a finished
 * conversation is resumed in a fresh tmux window first.
 */
function LinkAskCard({ source, drop, onClose }: { source: FileEntry; drop: DropState; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const target = drop.file;
  const badge = engineBadge(target);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  /* A confirmed delivery lingers just long enough to read, then tidies up. */
  useEffect(() => {
    if (status?.kind !== "ok") return;
    const timer = window.setTimeout(onClose, 1800);
    return () => window.clearTimeout(timer);
  }, [status, onClose]);

  const left = Math.max(CARD_MARGIN, Math.min(drop.to.x + 14, window.innerWidth - CARD_W - CARD_MARGIN));
  const top = Math.max(CARD_MARGIN, Math.min(drop.to.y + 12, window.innerHeight - CARD_RESERVE));

  const send = async () => {
    if (busy || !ask.trim()) return;
    setBusy(true);
    setStatus(null);
    const text =
      `Тобі передали контекст іншого агента — розмову «${cleanTitle(source.title, 80)}». ` +
      `Її транскрипт: ${source.path} — спочатку прочитай цей файл, щоб мати повний контекст, а тоді виконай прохання нижче.\n\n${ask.trim()}`;
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(target.pid !== null ? { pid: target.pid } : {}), path: target.path, text }),
      });
      const json = (await res.json()) as { ok?: boolean; target?: string; spawned?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося надіслати" });
        return;
      }
      setStatus({
        kind: "ok",
        text: json.spawned ? `агент прокинувся у tmux ${json.target ?? ""}` : `надіслано у tmux ${json.target ?? ""}`,
      });
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={cardRef}
      className="pointer-events-auto fixed flex w-[340px] cursor-default flex-col gap-2.5 rounded-[12px] border border-line bg-panel p-3 shadow-[0_8px_28px_rgba(20,20,30,0.14)]"
      style={{ left, top }}
    >
      <div className="flex items-center gap-1.5">
        <Link2 className="h-3.5 w-3.5 shrink-0" style={{ color: LINK_COLOR }} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold">звʼязати агентів</span>
        <button
          type="button"
          aria-label="Закрити картку звʼязування"
          onClick={onClose}
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1.5 rounded-[8px] border border-line bg-bg px-2 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="w-[64px] shrink-0 text-[10px] font-semibold text-dim">кому</span>
          <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold" style={badge.style}>
            {badge.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold" title={cleanTitle(target.title)}>
            {cleanTitle(target.title, 60)}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="w-[64px] shrink-0 text-[10px] font-semibold text-dim">контекст</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink" title={source.path}>
            {source.path}
          </span>
        </div>
      </div>
      <p className="text-[10.5px] text-dim">
        Агент отримає шлях до цього транскрипта з пропозицією прочитати розмову. Додай, що саме в нього попросити:
      </p>
      <textarea
        value={ask}
        onChange={(event) => setAsk(event.target.value)}
        rows={4}
        autoFocus
        placeholder="що зробити з цим контекстом…"
        aria-label="Прохання для звʼязаного агента"
        className="resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <div className="flex items-center">
        <button
          type="button"
          disabled={busy || !ask.trim()}
          onClick={() => void send()}
          className="ml-auto rounded-[8px] border px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          style={{ backgroundColor: LINK_COLOR, borderColor: LINK_COLOR }}
        >
          {busy ? "звʼязую…" : "▶ Звʼязати"}
        </button>
      </div>
      {busy ? <span className="text-[10.5px] text-dim">якщо агент не запущений — резюмую його вікно (до хвилини)…</span> : null}
      {status ? (
        <span className={`text-[11px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>{status.text}</span>
      ) : null}
    </div>
  );
}
