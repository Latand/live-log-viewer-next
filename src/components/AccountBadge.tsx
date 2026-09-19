"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Check, ChevronDown } from "@/components/icons";
import { type AccountAuthHealth, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { conversationIdentity } from "@/lib/accounts/identity";
import { pickApplying, readPickedAccount, setPickedAccount, useIntendedAccount } from "@/lib/accounts/intendedAccount";
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

function migrationProjectionKey(migration: FileEntry["migration"]): string | null {
  if (!migration) return null;
  return [
    migration.intentId,
    migration.revision ?? "",
    migration.phase,
    migration.targetAccountId,
    migration.failure ?? "",
  ].join("\u0000");
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
  /* The menu renders through a portal with fixed positioning: card headers
     clip overflow, so an in-flow absolute menu was cut off and unreachable. */
  const [menuPosition, setMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const migrationBaselineRef = useRef<string | null>(null);
  /* #1846: a pick is the conversation's intended account, shown here and on every other account surface in
     the same frame, and the conversation moves with its next message. Nothing waits for a confirmation. */
  const key = file ? conversationIdentity(file) : accountId;
  const { next } = useIntendedAccount(key, accountId, runtimeSession?.pendingReconfigure?.accountId);
  const moving = Boolean(file) && next !== accountId;
  /* A pick a message already engaged is moving the conversation: too late to take back (#1846 review). */
  const switching = moving && pickApplying(runtimeSession, file);
  const tint = accountTint(accountId);
  const health = healthOf(accounts.accounts.find((account) => account.id === accountId));
  /* The pick is named by the labels the menu rows use, as every other account surface names it (#1846). */
  const nameOf = (id: string) => accounts.accounts.find((account) => account.id === id)?.label || id;
  const runsOnNext = t("mobile2.composer.accountRunsOnNext", { account: nameOf(accountId), next: nameOf(next) });
  const label = moving
    ? `${hintLabel(t, accountId, engine, health)} · ${runsOnNext}`
    : hintLabel(t, accountId, engine, health);
  const aria = t("branch.accountAria", { id: accountId });

  /* A conversation off the structured transport moves through the migration drain at once, and says so
     only when that move failed: the pick goes back and the reason is told. */
  useEffect(() => {
    const migration = file?.migration;
    const picked = readPickedAccount(key);
    if (!picked
      || !migration?.failure
      || migration.targetAccountId !== picked
      || migrationProjectionKey(migration) === migrationBaselineRef.current) return;
    migrationBaselineRef.current = null;
    setPickedAccount(key, null);
    pushTaskToast("err", migration.failure);
  }, [file?.migration, key]);

  /* Portal menu closes on any press outside the chip or the menu itself. */
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open]);

  const toggleMenu = () => {
    if (!open) {
      const rect = anchorRef.current?.getBoundingClientRect();
      setMenuPosition(rect ? { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) } : { top: 8, right: 8 });
    }
    setOpen((value) => !value);
  };

  /** Picks where the next message goes; picking the account it runs on takes a waiting pick back. */
  const switchConversation = async (targetId: string) => {
    if (!file || targetId === next || (switching && targetId === accountId)) return;
    const previous = readPickedAccount(key);
    setPickedAccount(key, targetId);
    setOpen(false);
    migrationBaselineRef.current = migrationProjectionKey(file.migration);
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
        error?: string;
        accountOverride?: { outsidePool?: boolean; recorded?: boolean };
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? t("accounts.switchFailed"));
      /* #1279: the switch went through, and it went outside the accounts this
         project's work is normally drawn from. Said at the moment of the
         gesture, because the operator is entitled to make it and entitled to
         know it was recorded as theirs — and, when the journal would not take
         the record, entitled to know that the switch they just made is the one
         thing the project view will not show them afterwards. */
      if (body.accountOverride?.outsidePool) {
        pushTaskToast(
          body.accountOverride.recorded === false ? "err" : "ok",
          t(body.accountOverride.recorded === false
            ? "accounts.switchedOutsidePoolUnrecorded"
            : "accounts.switchedOutsidePool"),
        );
      }
    } catch (error) {
      if (readPickedAccount(key) === targetId) setPickedAccount(key, previous);
      pushTaskToast("err", error instanceof Error ? error.message : t("accounts.switchFailed"));
    }
  };

  const button = (
    <button
      type="button"
      onClick={() => file ? toggleMenu() : requestAccountPanel(engine, accountId)}
      aria-label={aria}
      aria-haspopup={file ? "menu" : undefined}
      aria-expanded={file ? open : undefined}
      data-conversation-account-chip
      data-conversation-account-next={moving ? next : undefined}
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
          {accountId.charAt(0)}
        </span>
      ) : (
        <>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint.dot }} aria-hidden />
          <span>@ {truncateId(nameOf(accountId))}</span>
          {moving ? <span className="text-accent">→ {truncateId(nameOf(next))}</span> : null}
          {file ? <ChevronDown className="h-2.5 w-2.5" aria-hidden /> : null}
        </>
      )}
    </button>
  );

  const menu = open && file && menuPosition ? createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-conversation-account-menu
      onPointerDown={(event) => event.stopPropagation()}
      style={{ top: menuPosition.top, right: menuPosition.right }}
      className="fixed z-[95] min-w-52 rounded-surface border border-border bg-raised p-1.5 font-sans text-ui shadow-2"
    >
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
        {t("accounts.conversationTitle")}
      </div>
      {accounts.accounts.map((account) => {
        const available = account.authPresent && !account.loginPending;
        /* While a pick waits, the account it runs on is the way back (#1846); not once the move is under way. */
        const leaving = moving && account.id === accountId;
        const cancels = leaving && !switching;
        return (
          <button
            key={account.id}
            type="button"
            role="menuitemradio"
            aria-checked={account.id === next}
            disabled={(leaving && switching) || (!available && !cancels)}
            onClick={() => void switchConversation(account.id)}
            className="flex min-h-9 w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-sunken disabled:opacity-45"
          >
            <span className="min-w-0 flex-1 truncate">{account.label}</span>
            {cancels ? (
              <span className="shrink-0 text-[11px] font-semibold text-accent" data-conversation-account-cancel>
                {t("mobile2.composer.accountCancelSwitch")}
              </span>
            ) : leaving ? (
              <span className="shrink-0 text-[11px] font-semibold text-muted" data-conversation-account-switching>
                {t("mobile2.composer.accountSwitching")}
              </span>
            ) : null}
            {account.id === next ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}
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
    </div>,
    document.body,
  ) : null;

  return (
    <span ref={anchorRef} className="relative inline-flex" onPointerDown={(event) => event.stopPropagation()}>
      <Hint label={label}>{button}</Hint>
      {menu}
      {moving ? (
        <span className="sr-only" role="status">{runsOnNext}</span>
      ) : null}
    </span>
  );
}

function hintLabel(t: TFunction, accountId: string, engine: "claude" | "codex", health: AccountAuthHealth | null): string {
  const engineName = ENGINE_LABEL[engine];
  return health
    ? t("branch.accountTip", { id: accountId, engine: engineName, health: t(AUTH_HEALTH_KEY[health]) })
    : t("branch.accountTipPlain", { id: accountId, engine: engineName });
}
