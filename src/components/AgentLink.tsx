"use client";

import { Link2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { appendComposerDraft } from "./TmuxComposer";
import { cleanTitle } from "./utils";

/** Accent of the agent-link gesture: the arrow, the target border highlight
    (see the [data-link-hover] rule in globals.css) and the drop chip. */
const LINK_COLOR = "#0d9488";
/** Pointer travel that turns a pill press into a link drag instead of a click. */
const DRAG_THRESHOLD = 7;
/** How long the arrow and its confirmation chip linger after a drop. */
const FLASH_MS = 1600;

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

function targetAt(x: number, y: number, excludePath: string | null): LinkTarget | null {
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
  label: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface LinkDragSpec {
  /** Path never offered as a target — the arrow's own source pane. */
  exclude?: string;
  /** Pane drop: deliver and return the confirmation-chip text (null skips the flash). */
  onDrop: (hit: { file: FileEntry }, point: { x: number; y: number }) => string | null;
  /** Drop on empty space, after the arrow cleans up. */
  onMiss?: (point: { x: number; y: number }) => void;
  onDragStart?: () => void;
}

/**
 * Drag-to-link gesture off a pill: pull an arrow onto another agent's pane
 * (its border lights up in the link color while hovered) and the drop itself
 * delivers — what exactly lands there is the caller's `onDrop`. No
 * intermediate card.
 *
 * The arrow follows the cursor via direct `d` writes on the SVG path — no
 * React state per move — matching how the pill itself tracks the pointer.
 */
export function useLinkDrag(spec: LinkDragSpec) {
  const [dragging, setDragging] = useState(false);
  /* The window listeners attach once per gesture; the ref keeps them reading
     the freshest closures (deliveryBlocked and friends move every render).
     Synced in an effect — effects settle before any pointer event fires. */
  const specRef = useRef(spec);
  useEffect(() => {
    specRef.current = spec;
  }, [spec]);
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
        specRef.current.onDragStart?.();
      }
      pathRef.current?.setAttribute("d", arrowD(st.anchorX, st.anchorY, ev.clientX, ev.clientY));
      const hit = targetAt(ev.clientX, ev.clientY, specRef.current.exclude ?? null);
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
        /* The drop is the delivery. The arrow and the target highlight
           linger through the confirmation flash. */
        const label = specRef.current.onDrop(st.hover, { x: ev.clientX, y: ev.clientY });
        if (label !== null) {
          setDrop({
            label,
            from: { x: st.anchorX, y: st.anchorY },
            to: { x: ev.clientX, y: ev.clientY },
          });
        } else {
          clearHighlight();
        }
      } else {
        clearHighlight();
        specRef.current.onMiss?.({ x: ev.clientX, y: ev.clientY });
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

  /* The confirmation lingers just long enough to read, then tidies up. */
  useEffect(() => {
    if (!drop) return;
    const timer = window.setTimeout(() => {
      clearHighlight();
      setDrop(null);
    }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [drop]);

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
            {drop ? <DropFlash drop={drop} /> : null}
          </div>,
          document.body,
        )
      : null;

  return { onPillPointerDown, consumeClick, draggingRef, overlay };
}

/**
 * The handoff flavor of the link drag: the drop puts the handoff context
 * (this conversation's title and transcript path) straight into the target
 * pane's composer, focused and ready for the ask.
 */
export function useAgentLink(source: FileEntry, onDragStart?: () => void) {
  const { t } = useLocale();
  return useLinkDrag({
    exclude: source.path,
    onDragStart,
    onDrop: (hit) => {
      appendComposerDraft(
        conversationIdentity(hit.file),
        t("link.handoffContext", { title: cleanTitle(source.title, 80), path: source.path, ask: "" }).trimEnd() + "\n\n",
      );
      return t("link.dropped", { title: cleanTitle(hit.file.title, 48) });
    },
  });
}

/**
 * The confirmation chip at the drop point: the delivery already happened on
 * the drop, so this only says what landed where before the overlay fades on
 * the hook's timer.
 */
function DropFlash({ drop }: { drop: DropState }) {
  const left = Math.max(8, Math.min(drop.to.x + 14, window.innerWidth - 288));
  const top = Math.max(8, Math.min(drop.to.y + 12, window.innerHeight - 44));
  return (
    <div
      className="fixed flex max-w-[280px] items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-card"
      style={{ left, top, backgroundColor: LINK_COLOR }}
    >
      <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">{drop.label}</span>
    </div>
  );
}
