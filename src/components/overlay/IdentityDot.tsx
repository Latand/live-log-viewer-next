"use client";

import { useEffect, useRef } from "react";

import type { TFunction } from "@/lib/i18n";

/**
 * The overlay's identity element (#691): one dot, present at every size
 * including Rail and compact.
 *
 * It is the ONLY animation in the surface, and it costs one animation-frame
 * loop writing straight to the DOM — the same technique the existing mic meter
 * uses to avoid re-rendering the composer sixty times a second. Under
 * `prefers-reduced-motion` it becomes a static coloured dot beside the state
 * word that is already there, so the information survives and only the motion
 * goes.
 */

export type AgentState = "idle" | "listening" | "speaking" | "working";

const STATE_KEY = {
  idle: "overlay.state.idle",
  listening: "overlay.state.listening",
  speaking: "overlay.state.speaking",
  working: "overlay.state.working",
} as const;

const STATE_TONE: Record<AgentState, string> = {
  idle: "bg-muted",
  listening: "bg-accent",
  speaking: "bg-success",
  working: "bg-warning",
};

export function agentStateLabel(state: AgentState, t: TFunction): string {
  return t(STATE_KEY[state]);
}

export function IdentityDot({
  state,
  size,
  level,
  reducedMotion,
  t,
}: {
  state: AgentState;
  /** 28px on mobile, 20px on desktop. */
  size: number;
  /** Live microphone level, 0..1, sampled by the caller's audio graph. Only
      `listening` uses it. */
  level?: () => number;
  reducedMotion: boolean;
  t: TFunction;
}) {
  const ring = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const node = ring.current;
    if (!node || reducedMotion || state === "idle" || typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    const started = Date.now();
    const draw = () => {
      const elapsed = (Date.now() - started) / 1000;
      const amplitude = state === "listening"
        ? Math.min(1, Math.max(0, level?.() ?? 0))
        /* Speaking pulses and working breathes on their own clock; neither
           needs a microphone to have something to say. */
        : (Math.sin(elapsed * (state === "speaking" ? 6 : 2)) + 1) / 2;
      node.style.transform = `scale(${(1 + amplitude * 0.45).toFixed(3)})`;
      node.style.opacity = (0.15 + amplitude * 0.35).toFixed(3);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [state, level, reducedMotion]);

  const label = agentStateLabel(state, t);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      data-testid="overlay-identity"
      data-state={state}
      data-motion={reducedMotion ? "static" : "animated"}
    >
      {/* The halo carries every pixel of motion, so the dot itself — the part
          that says which state this is — never moves. */}
      {!reducedMotion && state !== "idle" ? (
        <span
          ref={ring}
          aria-hidden
          className={`absolute inset-0 rounded-full ${STATE_TONE[state]}`}
          style={{ opacity: 0.2 }}
        />
      ) : null}
      <span
        aria-hidden
        className={`rounded-full ${STATE_TONE[state]}`}
        style={{ width: size * 0.55, height: size * 0.55 }}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
