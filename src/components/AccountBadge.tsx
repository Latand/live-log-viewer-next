"use client";

import { useEffect, useRef, useState } from "react";

import { Check, ChevronDown, Loader2 } from "@/components/icons";
import { type AccountAuthHealth, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { requestAccountPanel } from "@/lib/accounts/openPanel";
import { type MessageKey, type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { Hint } from "./Hint";
import type { RuntimeSession } from "./runtime/runtimeModel";
import { effectiveProfile } from "./runtimeProfile";
import { hueFromId } from "./scheme/agentLinks";
import { pushTaskToast } from "./tasks/taskToast";

/** Engine-agnostic account id → its transcript-derived id, exported for the
    caller so the badge stays a leaf that only paints. */
export { accountIdFromPath };

const AUTH_HEALTH_KEY: Record<AccountAuthHealth, MessageKey> = {
  authenticated: "accounts.auth.authenticated",
  signed_out: "accounts.auth.signedOut",
  unknown: "accounts.auth.unknown",
  error: "accounts.auth.error",
};

const ENGINE_LABEL: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };

/** Deterministic, theme-adaptive tint for an account id: a fixed hue from the
    id with pinned saturation/lightness, mixed against a theme surface token so
    it reads in both light and dark with no raw hex. The dot on the chip and the
    circle fill on mobile share the hue, so grouping reads across many windows. */
function accountTint(accountId: string): { dot: string; circleBg: string } {
  const hue = hueFromId(accountId);
  return {
    dot: `color-mix(in srgb, hsl(${hue} 60% 50%) 85%, var(--color-card))`,
    circleBg: `color-mix(in srgb, hsl(${hue} 62% 50%) 20%, var(--color-card))`,
  };
}

/** ~14ch cap so the id never crowds the meta row; the full id lives in the Hint. */
function truncateId(id: string, max = 14): string {
  return id.length > max ? `${id.slice(0, max - 1)}…` : id;
}

function healthOf(account: { authHealth?: AccountAuthHealth; authPresent?: boolean } | undefined): AccountAuthHealth | null {
  if (!account) return null;
  return account.authHealth ?? (account.authPresent ? "unknown" : "signed_out");
}

/**
 * Account badge — the third meta-chip on an agent window header, after the ctx
 * and branch chips (issue #229). Shows `@ <accountId>` with a deterministic hue
 * dot; the styled Hint carries the full id, engine, and live account health.
 * Conversation cards open a scoped account switcher; standalone badges open
 * the existing accounts panel. On the phone the chip collapses to a 20px hue
 * circle inside a 44px tap target.
 *
 * The account health is read from the live per-engine registry projection, so a
 * conversation that migrates accounts (issue #40) reflects its current account.
 */
export function AccountBadge({
  engine,
  accountId,
  file,
  runtimeSession,
}: {
  engine: "claude" | "codex";
  accountId: string;
  file?: FileEntry;
  runtimeSession?: RuntimeSession | null;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const accounts = useEngineAccounts(engine);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const operationRef = useRef<string | null>(null);
  const targetAccountRef = useRef<string | null>(null);
  const tint = accountTint(accountId);
  const health = healthOf(accounts.accounts.find((account) => account.id === accountId));
  const label = hintLabel(t, accountId, engine, health);
  const aria = t("branch.accountAria", { id: accountId });

  useEffect(() => {
    const operationId = operationRef.current;
    if (!operationId) return;
    const receipt = runtimeSession?.recentReceipts.find((candidate) =>
      candidate.operationId === operationId && candidate.kind === "reconfigure");
    if (!receipt) return;
    if (receipt.status === "applied") {
      operationRef.current = null;
      targetAccountRef.current = null;
      setPending(false);
      pushTaskToast("ok", t("accounts.conversationApplied"));
    } else if (receipt.status === "failed" || receipt.status === "rejected") {
      operationRef.current = null;
      targetAccountRef.current = null;
      setPending(false);
      pushTaskToast("err", receipt.reason ?? t("accounts.switchFailed"));
    }
  }, [runtimeSession, t]);

  useEffect(() => {
    if (!pending || targetAccountRef.current !== accountId) return;
    targetAccountRef.current = null;
    operationRef.current = null;
    setPending(false);
    pushTaskToast("ok", t("accounts.conversationApplied"));
  }, [accountId, pending, t]);

  const switchConversation = async (targetId: string) => {
    if (!file || targetId === accountId || pending) return;
    setPending(true);
    setOpen(false);
    targetAccountRef.current = targetId;
    try {
      const profile = effectiveProfile(file);
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reconfigure",
          path: file.path,
          conversationId: runtimeSession?.conversationId ?? file.conversationId,
          accountId: targetId,
          model: profile.model,
          effort: profile.effort,
          fast: engine === "codex" ? profile.fast : undefined,
        }),
      });
      const body = await response.json() as {
        ok?: boolean;
        operationId?: string;
        receipt?: { operationId: string; status: string };
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? t("accounts.switchFailed"));
      operationRef.current = body.operationId ?? body.receipt?.operationId ?? null;
    } catch (error) {
      targetAccountRef.current = null;
      setPending(false);
      pushTaskToast("err", error instanceof Error ? error.message : t("accounts.switchFailed"));
    }
  };

  const button = (
    <button
      type="button"
      onClick={() => file ? setOpen((value) => !value) : requestAccountPanel(engine, accountId)}
      aria-label={aria}
      aria-haspopup={file ? "menu" : undefined}
      aria-expanded={file ? open : undefined}
      aria-busy={pending || undefined}
      data-conversation-account-chip
      className={isMobile
        ? "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        : "inline-flex shrink-0 items-center gap-1 rounded-full border border-border/80 px-1.5 py-0.5 font-mono text-[9.5px] text-muted hover:border-accent/45 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"}
    >
      {isMobile ? (
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] font-bold uppercase"
          style={{ backgroundColor: tint.circleBg, color: tint.dot }}
          aria-hidden
        >
          {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : accountId.charAt(0)}
        </span>
      ) : (
        <>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint.dot }} aria-hidden />
          <span>@ {truncateId(accountId)}</span>
          {pending ? <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden /> : file ? <ChevronDown className="h-2.5 w-2.5" aria-hidden /> : null}
        </>
      )}
    </button>
  );

  return (
    <span className="relative inline-flex" onPointerDown={(event) => event.stopPropagation()}>
      <Hint label={label}>{button}</Hint>
      {open && file ? (
        <div
          role="menu"
          data-conversation-account-menu
          className="absolute right-0 top-full z-50 mt-1 min-w-52 rounded-surface border border-border bg-raised p-1.5 font-sans text-ui shadow-2"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {t("accounts.conversationTitle")}
          </div>
          {accounts.accounts.map((account) => {
            const available = account.authPresent && !account.loginPending;
            return (
              <button
                key={account.id}
                type="button"
                role="menuitemradio"
                aria-checked={account.id === accountId}
                disabled={!available || pending}
                onClick={() => void switchConversation(account.id)}
                className="flex min-h-9 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-sunken disabled:opacity-45"
              >
                <span className="min-w-0 flex-1 truncate">{account.label}</span>
                {account.id === accountId ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); requestAccountPanel(engine, accountId); }}
            className="mt-1 w-full border-t border-border px-2 pt-2 text-left text-[11px] font-semibold text-accent"
          >
            {t("accounts.manage")}
          </button>
        </div>
      ) : null}
      {pending ? <span className="sr-only" role="status">{t("accounts.conversationPending")}</span> : null}
    </span>
  );
}

function hintLabel(t: TFunction, accountId: string, engine: "claude" | "codex", health: AccountAuthHealth | null): string {
  const engineName = ENGINE_LABEL[engine];
  return health
    ? t("branch.accountTip", { id: accountId, engine: engineName, health: t(AUTH_HEALTH_KEY[health]) })
    : t("branch.accountTipPlain", { id: accountId, engine: engineName });
}
