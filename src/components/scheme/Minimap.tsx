"use client";

import { useRef } from "react";

import { TASK_TONES } from "@/components/tasks/taskModel";
import { engineColor } from "@/components/utils";
import { useLocale } from "@/lib/i18n";

import type { SchemeLayout } from "./layout";
import { TASK_W, taskCardHeight, type PlacedTask } from "./taskGeometry";

export interface Camera {
  x: number;
  y: number;
  z: number;
}

const MAP_W = 216;
const MAP_H = 148;

/**
 * Scaled-down world in the corner: every node as an engine-colored block,
 * the current viewport as an accent frame. Click or drag to jump the camera.
 */
export function Minimap({
  layout,
  tasks = [],
  cam,
  vp,
  onJump,
}: {
  layout: SchemeLayout;
  /** Tasks render as 3 px status-colored dots; their edges never show here. */
  tasks?: PlacedTask[];
  cam: Camera;
  vp: { w: number; h: number };
  onJump: (wx: number, wy: number) => void;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const scale = Math.min(MAP_W / layout.width, MAP_H / layout.height);
  const ox = (MAP_W - layout.width * scale) / 2;
  const oy = (MAP_H - layout.height * scale) / 2;

  const jumpTo = (event: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    onJump((event.clientX - rect.left - ox) / scale, (event.clientY - rect.top - oy) / scale);
  };

  return (
    <div
      ref={ref}
      data-scheme-ui
      className="absolute bottom-3 right-3 z-40 cursor-pointer overflow-hidden rounded-[10px] border border-line bg-panel/95 shadow-card"
      style={{ width: MAP_W, height: MAP_H }}
      title={t("minimap.title")}
      onPointerDown={(event) => {
        event.stopPropagation();
        dragRef.current = true;
        jumpTo(event);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* pointer already gone — the drag still tracks move events */
        }
      }}
      onPointerMove={(event) => {
        if (dragRef.current) jumpTo(event);
      }}
      onPointerUp={(event) => {
        dragRef.current = false;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* capture was never taken */
        }
      }}
      onPointerCancel={() => {
        dragRef.current = false;
      }}
    >
      <svg width={MAP_W} height={MAP_H} aria-hidden>
        <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
          {layout.stacks.map((stack) => (
            <rect key={stack.key} x={stack.x} y={stack.y} width={stack.w} height={stack.h} rx={18} fill="#c9c9d1" opacity={0.45} />
          ))}
          {layout.drafts.map((draft) => (
            <rect key={draft.key} x={draft.x} y={draft.y} width={draft.w} height={draft.h} rx={18} fill="#9a9aa4" opacity={0.3} />
          ))}
          {layout.decks.map((deck) => (
            <rect key={deck.key} x={deck.x} y={deck.y} width={deck.w} height={deck.h} rx={18} fill="#5a51e0" opacity={0.3} />
          ))}
          {layout.nodes.map((node) => (
            <rect
              key={node.file.path}
              x={node.x}
              y={node.y}
              width={node.w}
              height={node.h}
              rx={18}
              fill={engineColor(node.file)}
              opacity={node.file.activity === "live" ? 0.85 : 0.35}
            />
          ))}
          {tasks.map((task) => (
            <circle
              key={task.id}
              cx={task.pos.x + TASK_W / 2}
              cy={task.pos.y + taskCardHeight(task) / 2}
              r={3 / scale}
              fill={TASK_TONES[task.status].color}
              opacity={task.status === "done" ? 0.5 : 0.95}
            />
          ))}
          <rect
            x={-cam.x / cam.z}
            y={-cam.y / cam.z}
            width={vp.w / cam.z}
            height={vp.h / cam.z}
            fill="rgba(90,81,224,0.08)"
            stroke="#5a51e0"
            strokeWidth={2.5 / scale}
          />
        </g>
      </svg>
    </div>
  );
}
