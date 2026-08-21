"use client";

import { Bot } from "lucide-react";

import { useLocale } from "@/lib/i18n";

/**
 * The project dashboard header's entry to the orchestrator dock (PRD #976
 * decision 6). A toggle, not a launcher: it opens and closes the panel, and the
 * panel decides what the project's orchestrator currently is. Desktop only —
 * the phone reaches the same orchestrator through its pinned conversation row
 * (slice C, #979).
 */
export function OrchestratorPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={t("orchPanel.toggleAria")}
      title={t("orchPanel.toggleAria")}
      data-orchestrator-toggle
      className={`flex shrink-0 items-center gap-1 rounded-control border px-2.5 py-1 text-[11.5px] font-bold shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        open ? "border-accent/45 bg-accent/10 text-accent" : "border-border bg-card text-primary hover:border-accent/45 hover:text-accent"
      }`}
    >
      <Bot className="h-3.5 w-3.5" aria-hidden /> {t("orchPanel.title")}
    </button>
  );
}
