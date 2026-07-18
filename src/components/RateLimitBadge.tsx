"use client";

import { useState } from "react";
import { Check, Loader2, RefreshCcw } from "lucide-react";

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
 * successor; when it reports the successor already exists, the card renders
 * that as the terminal truth instead of pretending a new reseat started.
 */
export function RateLimitBadge({ rateLimit, file }: { rateLimit?: RateLimitState | null; file?: FileEntry }) {
  const { locale, t } = useLocale();
  const [reseat, setReseat] = useState<"idle" | "pending" | "requested" | "already-reseated" | "failed">("idle");
  const [reseatPhase, setReseatPhase] = useState<string | null>(null);
  const [reseatError, setReseatError] = useState<string | null>(null);
  const limit = rateLimit ?? file?.rateLimit;
  if (!limit) return null;
  const label = rateLimitText(t, locale, limit);
  const canReseat = Boolean(file?.conversationId && !file.migration);
  const busy = reseat === "pending" || reseat === "requested";
  const settled = reseat === "already-reseated";
  const buttonTitle = settled
    ? t("rateLimit.reseatAlready")
    : reseatError ?? (reseat === "requested" && reseatPhase === "waiting-turn" ? t("rateLimit.reseatWaitingTurn") : t("rateLimit.reseatTitle"));
  return (
    <>
      <Badge tone="danger" data-rate-limited="" title={label}>
        {label}
      </Badge>
      {canReseat ? (
        <button
          type="button"
          data-rate-limit-reseat=""
          {...(settled ? { "data-rate-limit-reseated": "" } : {})}
          disabled={busy || settled}
          className="inline-flex shrink-0 touch-manipulation items-center gap-1 rounded-full border border-danger/40 bg-canvas px-1.5 py-0.5 text-[9.5px] font-bold text-danger hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          title={buttonTitle}
          onClick={async (event) => {
            /* The chip lives inside clickable cards — the action must not
               open/focus the column. */
            event.stopPropagation();
            if (busy || settled) return;
            setReseat("pending");
            setReseatError(null);
            const result = await postConversationReseat(file!.conversationId!, file!.path);
            if (result.ok) {
              /* "already-reseated" is terminal: a successor owns this thread,
                 the stale card must never look like it started a new reseat.
                 Otherwise stay disabled until the next poll swaps in the
                 migration ribbon; the server is idempotent either way. */
              setReseat(result.state === "already-reseated" ? "already-reseated" : "requested");
              setReseatPhase(result.phase);
            } else {
              setReseat("failed");
              setReseatError(result.error);
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {busy ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : settled ? (
            <Check className="h-2.5 w-2.5" aria-hidden />
          ) : (
            <RefreshCcw className="h-2.5 w-2.5" aria-hidden />
          )}
          {settled ? t("rateLimit.reseatAlready") : reseat === "requested" ? t("rateLimit.reseatRequested") : t("rateLimit.reseat")}
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
