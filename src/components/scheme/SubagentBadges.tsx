"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { FileEntry } from "@/lib/types";
import { useLocale } from "@/lib/i18n";

import type { SchemeRect } from "./layout";
import type { SubagentBadgeAnchorRegistry } from "./subagentBadgeAnchors";
import { layoutBadges } from "./subagentBadgeLayout";
import { subagentsOf } from "./subagentBadgeModel";

export interface SubagentBadgesProps {
  conversationId: string;
  entries: readonly FileEntry[];
  cardRect: SchemeRect;
  /** Receives the badge's current-generation transcript PATH — the caller opens
      that exact entry rather than re-resolving the conversation id against file
      order (which can land on a stale earlier generation). */
  onNavigate: (path: string) => void;
  onExpandedChange?: (expanded: boolean) => void;
  anchorRegistry?: SubagentBadgeAnchorRegistry;
  /** Child paths/ids already placed on another surface (the tray) — excluded so
      a card renders in exactly one place (issue #142). */
  exclude?: ReadonlySet<string>;
  /** Hand-fold a promoted child into the parent tray (a durable fold pin). */
  onFold?: (id: string, path: string) => void;
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

export function SubagentBadges({ conversationId, entries, cardRect, onNavigate, onExpandedChange, anchorRegistry, exclude, onFold }: SubagentBadgesProps) {
  const { t } = useLocale();
  const foldLabel = (name: string) => t("subagentTray.fold", { name });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const suppressTouchClick = useRef(false);
  const children = useMemo(() => subagentsOf(conversationId, entries, exclude), [conversationId, entries, exclude]);
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
              data-chip-keepout
              data-scheme-ui
              className="pointer-events-auto absolute z-[6] inline-flex w-[30px] items-center justify-center rounded-full border border-border bg-card text-[10px] font-bold tabular-nums text-muted shadow-1"
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
          <span key={child.id} className="contents">
          {expanded && onFold && !unavailable ? (
            /* Hand-fold a live child into the parent tray (a durable fold pin) —
               a sibling control so the badge stays a single button. */
            <button
              type="button"
              data-subagent-fold={child.id}
              data-scheme-ui
              aria-label={foldLabel(child.title)}
              title={foldLabel(child.title)}
              className="pointer-events-auto absolute z-[71] inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-[11px] text-muted shadow-1 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55"
              style={{ left: position.x - cardRect.x + 202, top: position.y - cardRect.y + 5 }}
              onClick={() => onFold(child.id, child.path)}
            >
              <span aria-hidden>↧</span>
            </button>
          ) : null}
          <button
            type="button"
            data-subagent-badge={child.id}
            data-subagent-state={child.state}
            /* An edge-navigation chip reserves a clear band around this
               avatar/round stack (issue #474): its screen box is a chip
               keep-out so a revealed chip folds rather than paint over it. */
            data-chip-keepout
            /* data-scheme-ui exempts the badge from the camera's pan/tap capture
               so a coarse-pointer default hand board still delivers the tap;
               pointer-events-auto re-enables it inside the hand-mode
               pointer-events-none node layer. Panning elsewhere is untouched. */
            data-scheme-ui
            aria-expanded={expanded}
            aria-disabled={unavailable}
            aria-label={child.title}
            title={tooltip}
            className={`pointer-events-auto absolute flex max-w-[220px] items-center overflow-hidden rounded-full border border-card bg-card text-left shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 ${
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
              if (expanded) onNavigate(child.path);
              else setExpandedId(child.id);
            }}
            onClick={() => {
              if (suppressTouchClick.current) {
                suppressTouchClick.current = false;
                return;
              }
              if (!unavailable) onNavigate(child.path);
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
          </span>
        );
      })}
    </>
  );
}
