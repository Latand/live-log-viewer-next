"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";

import type { SchemeRect } from "./layout";
import type { SubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";
import { layoutBadges } from "./subagentBadgeLayout";
import { subagentsOf } from "./subagentBadgeModel";

export interface SubagentBadgesProps {
  conversationId: string;
  entries: readonly FileEntry[];
  cardRect: SchemeRect;
  onNavigate: (conversationId: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
  anchorRegistry?: SubagentBadgeAnchorRegistry;
}

function seedHue(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : words[0]?.slice(0, 2) || "AI").toUpperCase();
}

export function SubagentBadges({ conversationId, entries, cardRect, onNavigate, onExpandedChange, anchorRegistry }: SubagentBadgesProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const suppressTouchClick = useRef(false);
  const children = useMemo(() => subagentsOf(conversationId, entries), [conversationId, entries]);
  const positions = useMemo(() => layoutBadges(children, cardRect), [children, cardRect]);
  const hasExpandedChild = expandedId !== null && children.some((child) => child.id === expandedId);

  useEffect(() => {
    onExpandedChange?.(hasExpandedChild);
  }, [hasExpandedChild, onExpandedChange]);
  useEffect(() => {
    if (!anchorRegistry) return;
    const anchors = new Map(
      positions.flatMap((position) => position.kind === "badge"
        ? [[position.child.id, { x: position.x + position.size / 2, y: position.y + position.size / 2 }] as const]
        : []),
    );
    if (!anchors.size) return;
    return anchorRegistry.replace(conversationId, anchors);
  }, [anchorRegistry, conversationId, positions]);
  if (!positions.length) return null;

  return (
    <>
      {positions.map((position) => {
        const relativeStyle = {
          left: position.x - cardRect.x,
          top: position.y - cardRect.y,
          height: position.size,
        };
        if (position.kind === "overflow") {
          return (
            <span
              key="overflow"
              data-subagent-overflow
              className="absolute z-[6] inline-flex w-[30px] items-center justify-center rounded-full border border-border bg-card text-[10px] font-bold tabular-nums text-muted shadow-1"
              style={relativeStyle}
              title={`${position.count} more subagents`}
              aria-label={`${position.count} more subagents`}
            >
              +{position.count}
            </span>
          );
        }

        const child = position.child;
        const expanded = expandedId === child.id;
        const unavailable = child.state === "dead";
        const dimmed = unavailable || child.state === "closed";
        const hue = seedHue(child.avatarSeed);
        const tooltip = `${child.title} · ${child.engine}${child.model ? ` / ${child.model}` : ""}${unavailable ? " · unavailable" : ""}`;
        return (
          <button
            key={child.id}
            type="button"
            data-subagent-badge={child.id}
            data-subagent-state={child.state}
            aria-expanded={expanded}
            aria-disabled={unavailable}
            aria-label={child.title}
            title={tooltip}
            className={`absolute flex max-w-[220px] items-center overflow-hidden rounded-full border border-card bg-card text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${
              expanded ? "z-[70] w-[220px]" : "z-[6] w-[30px]"
            } ${dimmed ? "opacity-45 grayscale" : ""} ${unavailable ? "cursor-default" : "cursor-pointer hover:shadow-2"}`}
            style={{
              ...relativeStyle,
              transform: expanded ? "scale(var(--inv-z, 1))" : undefined,
              transformOrigin: "15px center",
            }}
            onMouseEnter={() => setExpandedId(child.id)}
            onMouseLeave={() => setExpandedId((current) => current === child.id ? null : current)}
            onFocus={() => setExpandedId(child.id)}
            onBlur={() => setExpandedId((current) => current === child.id ? null : current)}
            onPointerUp={(event) => {
              if (event.pointerType !== "touch" || unavailable) return;
              event.preventDefault();
              suppressTouchClick.current = true;
              if (expanded) onNavigate(child.id);
              else setExpandedId(child.id);
            }}
            onClick={() => {
              if (suppressTouchClick.current) {
                suppressTouchClick.current = false;
                return;
              }
              if (!unavailable) onNavigate(child.id);
            }}
          >
            <span
              className="relative z-[1] inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[9px] font-black tracking-[-0.04em] text-white"
              style={{
                background: `linear-gradient(135deg, oklch(72% 0.17 ${hue}), oklch(48% 0.2 ${(hue + 58) % 360}))`,
              }}
              aria-hidden
            >
              {initials(child.title)}
              {child.state === "running" ? (
                <span className="absolute inset-[-2px] rounded-full ring-2 ring-success/70 animate-pulse motion-reduce:animate-none" />
              ) : null}
            </span>
            <span className={`min-w-0 truncate px-2.5 text-[11px] font-semibold text-primary ${expanded ? "opacity-100" : "opacity-0"}`}>
              {child.title}
            </span>
          </button>
        );
      })}
    </>
  );
}
