"use client";

import { CircleCheck, CircleX, Clock3, LoaderCircle, RotateCcw } from "lucide-react";

import { type TFunction, useLocale } from "@/lib/i18n";
import type { StructuredSpawnCardState } from "@/lib/types";

const stateIcon = {
  starting: LoaderCircle,
  binding: LoaderCircle,
  queued: Clock3,
  failed: CircleX,
  recovered: CircleCheck,
} as const;

function iconTone(state: StructuredSpawnCardState["state"]): string {
  if (state === "starting" || state === "binding") return "animate-spin text-accent";
  if (state === "failed") return "text-danger";
  return "text-success";
}

export function StructuredSpawnStatusView({ spawn, t, onRetry }: { spawn: StructuredSpawnCardState; t: TFunction; onRetry?: () => void }) {
  const Icon = stateIcon[spawn.state];

  return (
    <section
      className="flex min-h-56 flex-1 items-center justify-center px-6 py-10"
      data-spawn-state={spawn.state}
      role="status"
      aria-live={spawn.state === "failed" ? "assertive" : "polite"}
    >
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-surface-raised/45 px-5 py-6 text-center shadow-sm">
        <Icon
          aria-hidden="true"
          className={`mx-auto mb-3 size-6 ${iconTone(spawn.state)}`}
        />
        <p className="text-sm font-medium text-foreground">{t(`spawnCard.${spawn.state}`)}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t(`spawnCard.initial.${spawn.initialMessage}`)}</p>
        {spawn.error && <p className="mt-3 break-words text-xs text-danger">{spawn.error}</p>}
        {spawn.retrySafe && <p className="mt-3 text-xs text-muted-foreground">{t("spawnCard.retrySafe")}</p>}
        {spawn.state === "failed" && spawn.retrySafe && onRetry ? (
          <button
            type="button"
            className="mx-auto mt-4 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onRetry}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t("launchHistory.retryLabel")}
          </button>
        ) : null}
        <p className="mt-4 font-mono text-[10px] text-muted-foreground/70">
          {t("spawnCard.launch", { id: spawn.launchId.slice(0, 8) })}
        </p>
      </div>
    </section>
  );
}

export function StructuredSpawnStatus({ spawn, onRetry }: { spawn: StructuredSpawnCardState; onRetry?: () => void }) {
  const { t } = useLocale();
  return <StructuredSpawnStatusView spawn={spawn} t={t} onRetry={onRetry} />;
}
