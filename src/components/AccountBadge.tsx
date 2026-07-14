"use client";

import { type AccountAuthHealth, useEngineAccounts } from "@/hooks/useEngineAccounts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { requestAccountPanel } from "@/lib/accounts/openPanel";
import { type MessageKey, type TFunction, useLocale } from "@/lib/i18n";

import { Hint } from "./Hint";
import { hueFromId } from "./scheme/agentLinks";

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
 * Clicking opens the existing accounts panel focused on this account. On the
 * phone the chip collapses to a 20px hue circle inside a 44px tap target.
 *
 * The account health is read from the live per-engine registry projection, so a
 * conversation that migrates accounts (issue #40) reflects its current account.
 */
export function AccountBadge({ engine, accountId }: { engine: "claude" | "codex"; accountId: string }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const accounts = useEngineAccounts(engine);
  const tint = accountTint(accountId);
  const health = healthOf(accounts.accounts.find((account) => account.id === accountId));
  const label = hintLabel(t, accountId, engine, health);
  const open = () => requestAccountPanel(engine, accountId);
  const aria = t("branch.accountAria", { id: accountId });

  if (isMobile) {
    return (
      <Hint label={label}>
        <button
          type="button"
          onClick={open}
          aria-label={aria}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span
            className="flex h-5 w-5 items-center justify-center rounded-full font-mono text-[10px] font-bold uppercase"
            style={{ backgroundColor: tint.circleBg, color: tint.dot }}
            aria-hidden
          >
            {accountId.charAt(0)}
          </span>
        </button>
      </Hint>
    );
  }

  return (
    <Hint label={label}>
      <button
        type="button"
        onClick={open}
        aria-label={aria}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/80 px-1.5 py-0.5 font-mono text-[9.5px] text-muted hover:border-accent/45 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint.dot }} aria-hidden />
        <span>@ {truncateId(accountId)}</span>
      </button>
    </Hint>
  );
}

function hintLabel(t: TFunction, accountId: string, engine: "claude" | "codex", health: AccountAuthHealth | null): string {
  const engineName = ENGINE_LABEL[engine];
  return health
    ? t("branch.accountTip", { id: accountId, engine: engineName, health: t(AUTH_HEALTH_KEY[health]) })
    : t("branch.accountTipPlain", { id: accountId, engine: engineName });
}
