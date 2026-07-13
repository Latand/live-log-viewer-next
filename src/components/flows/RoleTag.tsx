"use client";

import type { FlowRoleKey } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";

/**
 * Role identity of a loop card, pinned over its top edge: which side of the
 * implement↔review cycle the card is, and whether that side works right now.
 * The active side pulses green, the waiting one stays quiet.
 */
export function RoleTag({ role, active }: { role: FlowRoleKey; active: boolean }) {
  const { t } = useLocale();
  return (
    <div
      className={`pointer-events-none absolute -top-3 left-4 z-[12] flex h-6 items-center gap-1.5 rounded-full border px-2.5 shadow-1 ${
        active ? "border-success/50 bg-success-soft" : "border-border bg-card"
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${active ? "animate-pulse bg-success" : "bg-strong"}`} aria-hidden />
      <span className={`text-[10px] font-bold tracking-[0.06em] ${active ? "text-success" : "text-primary"}`}>
        {t(role === "implementer" ? "scheme.roleImplementer" : "scheme.roleReviewer")}
      </span>
      <span className={`text-[10px] font-semibold ${active ? "text-success" : "text-muted"}`}>
        {t(active ? "scheme.roleWorking" : "scheme.roleWaiting")}
      </span>
    </div>
  );
}
