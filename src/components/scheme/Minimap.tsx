"use client";

import { useRef } from "react";

import { engineColor } from "@/components/utils";

import type { SchemeLayout } from "./layout";

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
  cam,
  vp,
  onJump,
}: {
  layout: SchemeLayout;
  cam: Camera;
  vp: { w: number; h: number };
  onJump: (wx: number, wy: number) => void;
}) {
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
      title="Мінімапа — клікни або тягни, щоб перейти"
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
