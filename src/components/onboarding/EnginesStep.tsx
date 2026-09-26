"use client";

import { RefreshCw } from "lucide-react";

import { MobileAccountsBody } from "@/components/AccountsPanel";
import { CopilotAccountList, copilotSignedIn, useCopilotAccounts } from "@/components/CopilotFooterRow";
import { EngineMark } from "@/components/EngineMark";
import { engineTintOf } from "@/components/utils";
import type { AccountOption, EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { RoleEngine } from "@/lib/roles/types";

/**
 * Step 1 (#1876, design §2.1): which engines this machine can run right now.
 * Each engine's card is its account list: the accounts screen's own rows —
 * each account's state and its sign-in (the Claude browser-and-code flow, the
 * Codex device code) — with "Add a {engine} account" last, so several
 * accounts per engine are one row away (#2004) and there is one sign-in
 * implementation. Copilot sits beside them (#2166, newcomer audit F6) with the
 * footer switcher's own rows: it runs single agents, while the orchestrator
 * needs Claude or Codex, and the card says so.
 */

export type CliPresence = "found" | "missing" | null;

const ENGINE_NAME: Record<RoleEngine, string> = { claude: "Claude", codex: "Codex" };

/** Signed in, as the launch refusal counts it: a credential is present. */
export function accountConnected(account: AccountOption): boolean {
  return account.authPresent || account.authHealth === "authenticated";
}

export function engineConnected(state: Pick<EngineAccountsState, "accounts">): boolean {
  return state.accounts.some(accountConnected);
}

/** Connected as a launch counts it: a missing command outranks a present
    credential, since the engine cannot start either way. */
export function engineReady(state: Pick<EngineAccountsState, "accounts">, cli: CliPresence): boolean {
  return cli !== "missing" && engineConnected(state);
}

/** The account whose windows the cost hints read: the active one when it is
    signed in, otherwise the first that is. */
export function engineAccount(state: Pick<EngineAccountsState, "accounts" | "active">): AccountOption | null {
  const connected = state.accounts.filter(accountConnected);
  return connected.find((account) => account.id === state.active) ?? connected[0] ?? null;
}

/** The card's one-line summary of the list under it (design §2.1). */
function headerLine(state: EngineAccountsState, connected: boolean, t: TFunction): string {
  const signedIn = state.accounts.filter(accountConnected);
  const needSignIn = state.accounts.length - signedIn.length;
  const account = engineAccount(state);
  if (state.accounts.length > 1 && account) {
    const head = t("onboarding.engines.accountsHeader", { count: state.accounts.length, label: account.label });
    return needSignIn > 0 ? `${head} · ${t("onboarding.engines.accountsNeedSignIn", { count: needSignIn })}` : head;
  }
  if (connected) return account?.plan ? t("onboarding.engines.connected", { plan: account.plan }) : t("onboarding.engines.connectedNoPlan");
  return state.status === "error" ? t("onboarding.engines.authUnknown") : t("onboarding.engines.signedOut");
}

function EngineCard({ state, cli, now, onRecheck }: { state: EngineAccountsState; cli: CliPresence; now: number; onRecheck: () => void }) {
  const { t } = useLocale();
  const engine = state.engine;
  const missing = cli === "missing";
  const connected = engineReady(state, cli);
  const loading = state.status === "loading" && state.accounts.length === 0;
  const stateLine = loading ? null : missing ? t("onboarding.engines.missing") : headerLine(state, connected, t);
  const tone = connected ? "text-success" : missing ? "text-danger" : "text-warning";
  return (
    <div
      data-onboarding-engine={engine}
      data-engine-state={loading ? "loading" : connected ? "connected" : missing ? "missing" : "signed-out"}
      className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-border bg-card p-3"
      style={{ borderLeft: `3px solid var(--color-${engine})` }}
    >
      {loading ? (
        <div className="h-14 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" aria-busy />
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">
          <EngineMark engine={engine} size={18} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-primary">{ENGINE_NAME[engine]}</span>
            <span data-onboarding-engine-header="" className={`truncate text-ui ${tone}`} title={stateLine ?? undefined}>{stateLine}</span>
          </span>
          {missing ? (
            <button type="button" onClick={onRecheck} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              <RefreshCw className="h-3 w-3" aria-hidden />
              {t("onboarding.engines.recheck")}
            </button>
          ) : null}
        </div>
      )}
      {missing ? (
        <p className="text-ui text-secondary">{t(engine === "claude" ? "onboarding.engines.missingClaude" : "onboarding.engines.missingCodex")}</p>
      ) : null}
      {engine === "claude" && !missing ? <p className="text-ui text-secondary">{t("onboarding.engines.providerHelp")}</p> : null}
      {/* Every account the engine store knows, with its own sign-in, and the
          accounts panel's add row last (#2004): the same rows, not new UI. */}
      {loading ? null : (
        /* A missing command makes every sign-in and add press fail, so the
           rows stay listed but inert until Check again finds the command. */
        <div data-onboarding-accounts={engine} inert={missing} className={`-mx-3 -mb-3 border-t border-border ${missing ? "opacity-55" : ""}`}>
          <MobileAccountsBody engines={[state]} now={now} />
        </div>
      )}
    </div>
  );
}

/** Copilot's card: its accounts come from their own route, so the card reads
    that list and hands it the footer switcher's rows (#2166). */
function CopilotCard() {
  const { t } = useLocale();
  const accounts = useCopilotAccounts({ polling: true });
  const { body, load } = accounts;
  const loading = body === null;
  const missing = body !== null && !body.cli.present;
  const signedIn = copilotSignedIn(body);
  const stateLine = loading ? null : missing
    ? t("onboarding.engines.missing")
    : signedIn ? t("onboarding.engines.connectedCopilot", { label: signedIn.label }) : t("onboarding.engines.signedOut");
  const tone = signedIn && !missing ? "text-success" : missing ? "text-danger" : "text-warning";
  return (
    <div
      data-onboarding-engine="copilot"
      data-engine-state={loading ? "loading" : missing ? "missing" : signedIn ? "connected" : "signed-out"}
      className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-border bg-card p-3"
      style={{ borderLeft: `3px solid ${engineTintOf("copilot").color}` }}
    >
      {loading ? (
        <div className="h-14 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" aria-busy />
      ) : (
        <div className="flex min-w-0 items-center gap-2.5">
          <EngineMark engine="copilot" size={18} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-primary">Copilot</span>
            <span data-onboarding-engine-header="" className={`truncate text-ui ${tone}`} title={stateLine ?? undefined}>{stateLine}</span>
          </span>
          {missing ? (
            <button type="button" onClick={() => void load()} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">
              <RefreshCw className="h-3 w-3" aria-hidden />
              {t("onboarding.engines.recheck")}
            </button>
          ) : null}
        </div>
      )}
      {missing ? <p className="text-ui text-secondary">{t("onboarding.engines.missingCopilot")}</p> : null}
      {loading ? null : <p data-onboarding-copilot-note="" className="text-ui text-muted">{t("onboarding.engines.copilotNote")}</p>}
      {loading ? null : (
        <div data-onboarding-accounts="copilot" inert={missing} className={`-mx-3 -mb-3 flex flex-col gap-2 border-t border-border bg-sunken px-3 py-2.5 text-[11.5px] ${missing ? "opacity-55" : ""}`}>
          <CopilotAccountList accounts={accounts} />
        </div>
      )}
    </div>
  );
}

export function EnginesStep({ claude, codex, cli, now, onRecheck }: {
  claude: EngineAccountsState;
  codex: EngineAccountsState;
  cli: Record<RoleEngine, CliPresence>;
  now: number;
  onRecheck: () => void;
}) {
  const { t } = useLocale();
  const claudeOn = engineReady(claude, cli.claude);
  const codexOn = engineReady(codex, cli.codex);
  const settled = claude.status !== "loading" && codex.status !== "loading";
  const note = !settled
    ? null
    : claudeOn && codexOn
      ? null
      : claudeOn || codexOn
        ? t("onboarding.engines.oneOnly", { engine: claudeOn ? "Claude" : "Codex", other: claudeOn ? "Codex" : "Claude" })
        : t("onboarding.engines.neither");
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 items-start gap-4 max-sm:grid-cols-1 max-sm:gap-3">
        <EngineCard state={claude} cli={cli.claude} now={now} onRecheck={onRecheck} />
        <EngineCard state={codex} cli={cli.codex} now={now} onRecheck={onRecheck} />
        <CopilotCard />
      </div>
      {note ? (
        <p data-onboarding-engines-note="" className={`rounded-[8px] px-3 py-2 text-body ${claudeOn || codexOn ? "bg-sunken text-secondary" : "bg-warning-soft text-warning"}`}>{note}</p>
      ) : null}
    </div>
  );
}
