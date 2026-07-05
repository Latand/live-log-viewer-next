"use client";

import { memo } from "react";

import { TASK_TONES } from "@/components/tasks/taskModel";

import { MOVE_EASE, MOVE_MS } from "./nodes";
import type { TaskEdgeGeom } from "./taskGeometry";

/* Coral of a failed delivery beats the task's own status tone. */
const FAILED_COLOR = "#d97757";

/**
 * Dashed status-colored beziers from task cards to their assigned agents.
 * Rides the transformed world div; geometry animates via style-level `d`
 * transitions exactly like EdgesLayer, so layout reshuffles glide. The svg
 * itself is click-through — only failed edges carry a widened invisible hit
 * path whose click retries that one delivery.
 */
export const TaskEdgesLayer = memo(function TaskEdgesLayer({
  edges,
  width,
  height,
  onRetry,
}: {
  edges: TaskEdgeGeom[];
  width: number;
  height: number;
  /** Ref-stable: retries one failed target of one task. */
  onRetry: (taskId: string, path: string) => void;
}) {
  if (!edges.length) return null;
  return (
    <svg width={width} height={height} className="pointer-events-none absolute left-0 top-0 z-[2]">
      {edges.map((edge) => {
        const color = edge.failed ? FAILED_COLOR : TASK_TONES[edge.status].color;
        const mx = (edge.x1 + edge.x2) / 2;
        const curve = `M ${edge.x1} ${edge.y1} C ${mx} ${edge.y1}, ${mx} ${edge.y2}, ${edge.x2} ${edge.y2}`;
        /* Cubic with these controls passes through the plain midpoint. */
        const midX = (edge.x1 + edge.x2) / 2;
        const midY = (edge.y1 + edge.y2) / 2;
        return (
          <g key={edge.key} opacity={edge.failed ? 0.95 : 0.65}>
            <path
              d={curve}
              style={{ d: `path("${curve}")`, transition: `d ${MOVE_MS}ms ${MOVE_EASE}` } as React.CSSProperties}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray="5 7"
            />
            <circle
              cx={edge.x2}
              cy={edge.y2}
              r={4}
              fill={color}
              style={
                {
                  cx: `${edge.x2}px`,
                  cy: `${edge.y2}px`,
                  transition: `cx ${MOVE_MS}ms ${MOVE_EASE}, cy ${MOVE_MS}ms ${MOVE_EASE}`,
                } as React.CSSProperties
              }
            />
            {edge.failed ? (
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
                  fill="#fff"
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
