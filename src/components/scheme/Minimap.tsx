"use client";

import { useRef } from "react";

import { TASK_TONES } from "@/components/tasks/taskModel";
import { engineColor } from "@/components/utils";
import { useLocale } from "@/lib/i18n";

import type { SchemeLayout, SchemeRect } from "./layout";
import { TASK_W, taskCardHeight, type PlacedTask } from "./taskGeometry";
import type { WorkerStack } from "./workerCollapse";

export interface Camera {
  x: number;
  y: number;
  z: number;
}

const MAP_W = 216;
const MAP_H = 148;

/** One collapsed worker-stack origin, drawn as a single legend dot (issue #136). */
export interface StackDot {
  key: string;
  color: string;
}

/** Minimap dot tone per collapsed worker-stack origin (issue #136): orchestration
    origins (flow/pipeline) in accent, spawner/worktree origins in gray. */
export const STACK_DOT_COLOR: Record<WorkerStack["kind"], string> = {
  flow: "var(--color-accent)",
  pipeline: "var(--color-accent)",
  origin: "var(--color-muted)",
  worktree: "var(--color-strong)",
};

/** One minimap dot per collapsed worker stack (issue #136), tinted by origin. */
export function stackDotsFor(stacks: readonly WorkerStack[]): StackDot[] {
  return stacks.map((stack) => ({ key: stack.key, color: STACK_DOT_COLOR[stack.kind] }));
}

/**
 * Scaled-down world in the corner: every node as an engine-colored block,
 * the current viewport as an accent frame. Click or drag to jump the camera.
 */
export function Minimap({
  layout,
  world,
  tasks = [],
  currentWork = null,
  stackDots = [],
  cam,
  vp,
  onJump,
}: {
  layout: SchemeLayout;
  /** World box to scale down — the layout box grown to include off-layout task
      cards (issue #17), origin possibly negative. Everything is drawn in world
      coordinates and shifted by this origin so a relocated card still shows. */
  world: SchemeRect;
  /** Tasks render as 3 px status-colored dots; their edges never show here. */
  tasks?: PlacedTask[];
  /** Faint outline of the operator's current-work framing. */
  currentWork?: SchemeRect | null;
  /** Collapsed worker stacks (issue #136): one dot per origin, shown as a compact
      legend so folded workers read as a handful of dots, never an agent flood. */
  stackDots?: StackDot[];
  cam: Camera;
  vp: { w: number; h: number };
  onJump: (wx: number, wy: number) => void;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const scale = Math.min(MAP_W / world.w, MAP_H / world.h);
  const ox = (MAP_W - world.w * scale) / 2;
  const oy = (MAP_H - world.h * scale) / 2;

  const jumpTo = (event: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    onJump((event.clientX - rect.left - ox) / scale + world.x, (event.clientY - rect.top - oy) / scale + world.y);
  };

  return (
    <div
      ref={ref}
      data-scheme-ui
      className="absolute bottom-3 right-3 z-40 cursor-pointer overflow-hidden rounded-[10px] border border-border bg-card/95 shadow-1"
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
        <g transform={`translate(${ox - world.x * scale} ${oy - world.y * scale}) scale(${scale})`}>
          {/* On-canvas quiet-branch stacks: one dot each, so a stack is a single
              mark on the map, never a wall of member cards (issue #136). */}
          {layout.stacks.map((stack) => (
            <circle key={stack.key} cx={stack.x + stack.w / 2} cy={stack.y + stack.h / 2} r={7 / scale} fill="var(--color-muted)" opacity={0.6} />
          ))}
          {layout.drafts.map((draft) => (
            <rect key={draft.key} x={draft.x} y={draft.y} width={draft.w} height={draft.h} rx={18} fill="var(--color-muted)" opacity={0.3} />
          ))}
          {layout.decks.map((deck) => (
            <rect key={deck.key} x={deck.x} y={deck.y} width={deck.w} height={deck.h} rx={18} fill="var(--color-accent)" opacity={0.3} />
          ))}
          {layout.groups.filter((group) => group.kind === "pipeline").map((group) => (
            <rect
              key={group.key}
              data-minimap-pipeline={group.id}
              x={group.x}
              y={group.y}
              width={group.w}
              height={group.h}
              rx={18}
              fill={`hsl(${group.hue} 62% 42% / 0.08)`}
              stroke={`hsl(${group.hue} 62% 42%)`}
              strokeWidth={2 / scale}
            >
              <title>{group.label}</title>
            </rect>
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
          {currentWork ? (
            <rect
              data-minimap-current-work="true"
              x={currentWork.x}
              y={currentWork.y}
              width={currentWork.w}
              height={currentWork.h}
              rx={14}
              fill="none"
              stroke="var(--color-warning)"
              strokeDasharray={`${7 / scale} ${5 / scale}`}
              strokeWidth={2 / scale}
              opacity={0.8}
            />
          ) : null}
          <rect
            x={-cam.x / cam.z}
            y={-cam.y / cam.z}
            width={vp.w / cam.z}
            height={vp.h / cam.z}
            fill="color-mix(in srgb, var(--color-accent) 8%, transparent)"
            stroke="var(--color-accent)"
            strokeWidth={2.5 / scale}
          />
        </g>
      </svg>
      {/* Collapsed worker stacks live off-canvas, so they get a compact legend
          here — ONE dot per origin, all of them (issue #136): the acceptance
          contract is one dot per stack, so no stack identity is ever hidden
          behind a counter. The legend wraps and the dots shrink a touch past a
          dozen so a busy board stays inside the corner without dropping any. */}
      {stackDots.length ? (
        <div
          className="pointer-events-none absolute bottom-1 left-1 flex max-h-[70%] max-w-[150px] flex-wrap content-end items-center gap-[3px]"
          title={t("minimap.stacks", { count: stackDots.length })}
          aria-hidden
        >
          {stackDots.map((dot) => (
            <span
              key={dot.key}
              className={`shrink-0 rounded-full ${stackDots.length > 24 ? "h-1 w-1" : "h-1.5 w-1.5"}`}
              style={{ backgroundColor: dot.color }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
