"use client";

import { accountIdFromPath, DEFAULT_ACCOUNT_ID } from "@/lib/accounts/badge";
import { activeCardMigration, cardMigrationState, migrationTargetName } from "@/lib/accounts/migration";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { hueFromId } from "./scheme/agentLinks";
import { effortTint, effortTitle, engineBadge } from "./utils";

/**
 * Fixed card anatomy (issue #964): every compact conversation card reads in the
 * same three rows, whatever mix of operational states it is in.
 *
 *   1. identity/status — activity, ONE primary identity treatment, the
 *      operator-facing status word (#961's CardStatusBadge, consumed as-is).
 *   2. content — title and current-work preview.
 *   3. ops — account/switch, rate limit, wakeup, recency: operational facts
 *      that appear only when they are non-default, so a quiet card's rows stay
 *      visually empty instead of filling with placeholder chips.
 *
 * The rows carry `data-card-row` so tests and rendered evidence can assert the
 * anatomy instead of screenshot-diffing class soup. This module owns no state
 * machine: account-switch phases come from the migration projection the full
 * card already trusts (`activeCardMigration`/`cardMigrationState`), and the
 * status slot stays #961's territory.
 */

/** The account/switch fact a compact card's ops row shows, projected level-wise
    from the same authorities as the full card's ribbon. `settled` is the quiet
    truth — which account the conversation runs under right now. */
export type AccountSwitchFacts =
  | { kind: "pending" | "switching" | "failed"; target: string | null; source: string | null }
  | { kind: "settled"; accountId: string };

export function accountSwitchFacts(file: FileEntry): AccountSwitchFacts | null {
  if (file.engine !== "claude" && file.engine !== "codex") return null;
  const accountId = accountIdFromPath(file.path);
  const live = activeCardMigration(file.migration, accountId);
  const state = cardMigrationState(live);
  if (state === "pending" || state === "switching" || state === "failed") {
    return { kind: state, target: migrationTargetName(live), source: live?.sourceLabel?.trim() || accountId };
  }
  return { kind: "settled", accountId };
}

/** ~14ch cap, same budget as the full header's account badge; the full id
    stays in the chip title. */
function truncateId(id: string, max = 14): string {
  return id.length > max ? `${id.slice(0, max - 1)}…` : id;
}

const SWITCH_TONE: Record<"pending" | "switching" | "failed", string> = {
  pending: "border-warning/45 bg-warning-soft text-warning",
  switching: "border-accent/45 bg-accent-soft text-accent",
  failed: "border-danger/40 bg-danger-soft text-danger",
};

/**
 * The ops-row account slot: during a live switch it names the phase and the
 * target account («A → B» stays explicit through preflight, switching and
 * recovery); settled, it shows the plain account identity with its hue dot.
 * Passive on purpose — these hosts (map cards, switch cards, far labels) are
 * pick surfaces; the interactive switcher stays on the full card's AccountBadge.
 */
export function AccountSwitchChip({
  file,
  showSettled = true,
  fontClassName = "text-[9.5px]",
}: {
  file: FileEntry;
  /** Collapsed-stack rows show only live switches; the settled account would
      repeat on every quiet branch of the same conversation. */
  showSettled?: boolean;
  fontClassName?: string;
}) {
  const { t } = useLocale();
  const facts = accountSwitchFacts(file);
  if (!facts) return null;
  if (facts.kind === "settled") {
    if (!showSettled || facts.accountId === DEFAULT_ACCOUNT_ID) return null;
    const hue = hueFromId(facts.accountId);
    return (
      <span
        data-card-switch="settled"
        className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-border/80 px-1.5 py-0.5 font-mono ${fontClassName} text-muted`}
        title={t("branch.accountAria", { id: facts.accountId })}
      >
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: `color-mix(in srgb, hsl(${hue} 60% 50%) 85%, var(--color-card))` }}
        />
        <span className="truncate">@ {truncateId(facts.accountId)}</span>
      </span>
    );
  }
  const face =
    facts.kind === "failed"
      ? t("cardSwitch.failed")
      : facts.target
        ? t(facts.kind === "pending" ? "cardSwitch.pendingTo" : "cardSwitch.switchingTo", { label: facts.target })
        : t(facts.kind === "pending" ? "cardSwitch.pending" : "cardSwitch.switching");
  const phase =
    facts.kind === "pending"
      ? t("migrate.cardPending")
      : facts.kind === "failed"
        ? t("migrate.cardFailed")
        : facts.target
          ? t("migrate.cardSwitching", { label: facts.target })
          : t("migrate.cardSwitchingUnnamed");
  /* The full route — which account it leaves, which it joins — rides the
     title, so the compact face stays one chip wide. */
  const title = facts.source && facts.target ? `${t("cardSwitch.route", { from: facts.source, to: facts.target })} — ${phase}` : phase;
  return (
    <span
      data-card-switch={facts.kind}
      className={`inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 font-bold ${fontClassName} ${SWITCH_TONE[facts.kind]}`}
      title={title}
      aria-label={title}
    >
      <span aria-hidden>⇄</span>
      <span className="truncate">{face}</span>
    </span>
  );
}

/**
 * The identity row's ONE primary identity treatment: the model chip in the
 * engine's effort-shifted tint when the model is known (engine and effort tier
 * stay in the tooltip), the engine label as fallback — the SwitchCard pattern,
 * shared so every compact card resolves identity the same way instead of
 * stacking an engine chip AND a model chip.
 */
export function CardIdentityChip({ file, fontClassName = "text-[9.5px]" }: { file: FileEntry; fontClassName?: string }) {
  const badge = engineBadge(file);
  if (file.model) {
    return (
      <span
        className={`min-w-0 truncate rounded-full px-1.5 py-0.5 font-mono font-semibold ${fontClassName}`}
        style={{ backgroundColor: effortTint(file).soft, color: effortTint(file).color }}
        title={[badge.label, effortTitle(file)].filter(Boolean).join(" · ")}
      >
        {file.model}
      </span>
    );
  }
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 font-bold ${fontClassName}`} style={badge.style} title={effortTitle(file)}>
      {badge.label}
    </span>
  );
}
