"use client";

import { memo, useMemo } from "react";

import { TASK_TONES } from "@/components/tasks/taskModel";

import { MOVE_EASE, MOVE_MS } from "./nodes";
import { type TaskEdgeGeom, type TaskEdgeRoute } from "./taskGeometry";

/* Coral of a failed delivery beats the task's own status tone. */
const FAILED_COLOR = "var(--color-danger)";
/* Muted teal marks the provenance thread back to the originating session. */
const SOURCE_COLOR = "var(--color-info)";
/* A crossing the router could not avoid is faded to this fraction of its normal
   opacity — it then reads as running *behind* the card it must pass. */
const CROSS_FADE = 0.4;

/**
 * Dashed status-colored beziers from task cards to their assigned agents.
 * Rides the transformed world div; geometry animates via style-level `d`
 * transitions exactly like EdgesLayer, so layout reshuffles glide. Each curve
 * routes around unrelated task cards *and* panes/decks/stacks (issue #17), and
 * coincident edges are fanned into parallel lanes so they never overdraw; an
 * unavoidable crossing is faded so it reads as passing behind. The svg itself is
 * click-through — only failed edges carry a widened invisible hit path whose
 * click retries that one delivery.
 */
export const TaskEdgesLayer = memo(function TaskEdgesLayer({
  edges,
  world,
  routes,
  onRetry,
}: {
  edges: TaskEdgeGeom[];
  /** World box to span — origin (world.x/world.y) may be negative, so the svg
      is positioned and view-boxed to it, allowing a negative origin so a card
      left of (0,0) stays in view. The world box already includes routed detours,
      so no path or marker is clipped. */
  world: { x: number; y: number; w: number; h: number };
  /** Routed geometry per edge key — computed once in SchemeBoard so the world
      box can grow to contain it. */
  routes: ReadonlyMap<string, TaskEdgeRoute>;
  /** Ref-stable: retries one failed target of one task. */
  onRetry: (taskId: string, path: string) => void;
}) {
  const routed = useMemo(() => edges.map((edge) => ({ edge, route: routes.get(edge.key)! })), [edges, routes]);
  if (!edges.length) return null;
  return (
    <svg
      width={world.w}
      height={world.h}
      viewBox={`${world.x} ${world.y} ${world.w} ${world.h}`}
      className="pointer-events-none absolute z-[2]"
      style={{ left: world.x, top: world.y }}
    >
      {routed.map(({ edge, route }) => {
        /* A source edge is provenance, not an active hand-off: it reads as a
           faint green thread so it never competes with the status-colored
           assignment links. */
        const isSource = edge.relation === "source";
        const color = edge.failed ? FAILED_COLOR : isSource ? SOURCE_COLOR : TASK_TONES[edge.status].color;
        const baseOpacity = edge.failed ? 0.95 : isSource ? 0.4 : 0.65;
        /* An unavoidable card crossing is dimmed so it reads as running behind
           the card, clear of the tangle. */
        const opacity = route.crosses ? baseOpacity * CROSS_FADE : baseOpacity;
        const curve = route.d;
        const midX = route.mid.x;
        const midY = route.mid.y;
        return (
          <g key={edge.key} opacity={opacity}>
            <path
              d={curve}
              style={{ d: `path("${curve}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
              fill="none"
              stroke={color}
              strokeWidth={isSource ? 1.75 : 2.5}
              strokeLinecap="round"
              strokeDasharray={isSource ? "2 6" : "5 7"}
            />
            <circle
              cx={edge.x2}
              cy={edge.y2}
              r={isSource ? 3 : 4}
              fill={color}
              style={
                {
                  cx: `${edge.x2}px`,
                  cy: `${edge.y2}px`,
                  transition: `cx ${MOVE_MS}ms ${MOVE_EASE}, cy ${MOVE_MS}ms ${MOVE_EASE}`,
                } as React.CSSProperties
              }
            />
            {edge.failed && edge.relation === "assignment" ? (
              <g
                className="pointer-events-auto cursor-pointer"
                role="button"
                aria-label={`retry ${edge.path}`}
                onClick={() => onRetry(edge.taskId, edge.path)}
              >
                <title>{edge.error ?? ""}</title>
                {/* Widened invisible hit path: the dashed hairline itself is
                    unclickable at board zoom. */}
                <path d={curve} fill="none" stroke="transparent" strokeWidth={22} style={{ pointerEvents: "stroke" }} />
                <circle
                  cx={midX}
                  cy={midY}
                  r={11}
                  fill="var(--color-card)"
                  stroke={FAILED_COLOR}
                  strokeWidth={2}
                  style={
                    {
                      cx: `${midX}px`,
                      cy: `${midY}px`,
                      transition: `cx ${MOVE_MS}ms ${MOVE_EASE}, cy ${MOVE_MS}ms ${MOVE_EASE}`,
                    } as React.CSSProperties
                  }
                />
                <text
                  x={midX}
                  y={midY + 4.5}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={700}
                  fill={FAILED_COLOR}
                  style={
                    {
                      x: `${midX}px`,
                      y: `${midY + 4.5}px`,
                      transition: `x ${MOVE_MS}ms ${MOVE_EASE}, y ${MOVE_MS}ms ${MOVE_EASE}`,
                    } as React.CSSProperties
                  }
                >
                  ⚠
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
});
