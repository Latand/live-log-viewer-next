"use client";

import { useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { postConversationReseat } from "@/lib/accounts/migration";
import { useLocale } from "@/lib/i18n";
import type { FileEntry, RateLimitState } from "@/lib/types";

import { rateLimitText } from "./rateLimit";

/**
 * Rate-limit chip plus the one-click successor reseat (issue #97). The button
 * shows only for a conversation the registry can move safely: it needs the
 * stable `conversationId` and stands down while any migration annotation is
 * present — lineage stays owned by the account-migration coordinator (#40),
 * this is just its per-card trigger. The server re-checks lineage and picks
 * the healthiest account itself, so a stale card can never fork a duplicate
 * successor.
 */
export function RateLimitBadge({ rateLimit, file }: { rateLimit?: RateLimitState | null; file?: FileEntry }) {
  const { locale, t } = useLocale();
  const [reseat, setReseat] = useState<"idle" | "pending" | "requested" | "failed">("idle");
  const [reseatError, setReseatError] = useState<string | null>(null);
  const limit = rateLimit ?? file?.rateLimit;
  if (!limit) return null;
  const label = rateLimitText(t, locale, limit);
  const canReseat = Boolean(file?.conversationId && !file.migration);
  const busy = reseat === "pending" || reseat === "requested";
  return (
    <>
      <Badge tone="danger" data-rate-limited="" title={label}>
        {label}
      </Badge>
      {canReseat ? (
        <button
          type="button"
          data-rate-limit-reseat=""
          disabled={busy}
          className="inline-flex shrink-0 touch-manipulation items-center gap-1 rounded-full border border-danger/40 bg-canvas px-1.5 py-0.5 text-[9.5px] font-bold text-danger hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          title={reseatError ?? t("rateLimit.reseatTitle")}
          onClick={async (event) => {
            /* The chip lives inside clickable cards — the action must not
               open/focus the column. */
            event.stopPropagation();
            if (busy) return;
            setReseat("pending");
            setReseatError(null);
            const result = await postConversationReseat(file!.conversationId!, file!.path);
            if (result.ok) {
              /* Stay disabled until the next poll swaps in the migration
                 ribbon; the server is idempotent either way. */
              setReseat("requested");
            } else {
              setReseat("failed");
              setReseatError(result.error);
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {busy ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCcw className="h-2.5 w-2.5" aria-hidden />
          )}
          {reseat === "requested" ? t("rateLimit.reseatRequested") : t("rateLimit.reseat")}
        </button>
      ) : null}
      {reseat === "failed" ? (
        <span role="alert" aria-live="assertive" className="min-w-0 truncate text-[9.5px] font-semibold text-danger" title={reseatError ?? undefined}>
          {reseatError ?? t("rateLimit.reseatFailed")}
        </span>
      ) : null}
    </>
  );
}
