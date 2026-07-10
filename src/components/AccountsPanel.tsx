"use client";

import { Fragment, useEffect, useRef, useState } from "react";

import {
  accountNoticeText,
  claudeLoginErrKey,
  NONTERMINAL_CLAUDE_LOGIN_PHASES,
  type AccountOption,
  type EngineAccountsState,
} from "@/hooks/useEngineAccounts";
import { accountSelectOutcome, autoBalanceLine, bannerModel, type MigrationPreview } from "@/lib/accounts/migration";
import { type TFunction, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";

import { Check, Loader2, X } from "./icons";
import { engineTintOf } from "./utils";

/** Amber that clears contrast on the panel background — state legibility never
    leans on color alone, so this pairs with the "needs sign-in" text chip. */
const NEEDS_LOGIN_COLOR = "#8a5a00";

function engineDisplay(engine: "claude" | "codex"): string {
  return engine === "claude" ? "Claude" : "Codex";
}

/** Capacity-chip color ramp mirrors the limits bars: engine tint with headroom,
    amber as it tightens, red when nearly spent. */
function capacityColor(percent: number, engineColor: string): string {
  if (percent <= 10) return "#c62828";
  if (percent <= 30) return "#d29a2f";
  return engineColor;
}

function CapacityChip({ account, engine }: { account: AccountOption; engine: "claude" | "codex" }) {
  const { t } = useLocale();
  const effective = account.effective;
  if (!effective || effective.freshness === "unavailable") return null;
  const tint = engineTintOf(engine);
  const window = t(effective.window === "weekly" ? "limits.windowWeekly" : "limits.windowSession");
  const stale = effective.freshness === "stale";
  const color = capacityColor(effective.percent, tint.color);
  return (
    <span
      className={`shrink-0 rounded-full border border-line bg-bg px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${stale ? "opacity-55" : ""}`}
      style={{ color }}
      title={t(stale ? "accounts.effectiveStale" : "accounts.effectiveTip", { window })}
    >
      {t("accounts.effective", { pct: Math.round(effective.percent) })}
    </span>
  );
}

type RowState = "active" | "needsLogin" | "pending" | "idle";

function rowState(account: AccountOption, activeId: string): RowState {
  if (account.loginPending) return "pending";
  if (!account.authPresent) return "needsLogin";
  if (account.id === activeId) return "active";
  return "idle";
}

function StateChip({ state }: { state: RowState }) {
  const { t } = useLocale();
  if (state === "pending") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-dim">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
        {t("accounts.pendingLogin")}
      </span>
    );
  }
  if (state === "needsLogin") return <span className="shrink-0 text-[10px] font-semibold" style={{ color: NEEDS_LOGIN_COLOR }}>{t("accounts.needsLogin")}</span>;
  if (state === "active") return <span className="shrink-0 text-[10px] font-semibold text-dim">{t("accounts.active")}</span>;
  return null;
}

function AccountRow({ account, engine, activeId, onSelect, disabled }: { account: AccountOption; engine: "claude" | "codex"; activeId: string; onSelect: () => void; disabled: boolean }) {
  const { t } = useLocale();
  const state = rowState(account, activeId);
  const isActive = account.id === activeId;
  return (
    <div>
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">{isActive ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}</span>
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${isActive ? "font-bold text-ink" : "font-semibold"}`}>{account.label}</span>
        <CapacityChip account={account} engine={engine} />
        <StateChip state={state} />
      </button>
      {state === "pending" && account.deviceAuth ? (
        <div className="flex items-center gap-2 px-3 pb-1.5 pl-[26px] text-[10px] text-dim">
          <a href={account.deviceAuth.url} target="_blank" rel="noreferrer" className="truncate underline">{t("accounts.openLogin")}</a>
          <code className="select-all font-semibold text-ink">{account.deviceAuth.code}</code>
        </div>
      ) : null}
    </div>
  );
}

/** The Claude sign-in slice for one account row (issue #61). Renders the live
    login phase (browser link + bounded code entry, Cancel), a sanitized failure
    with Retry, or a Sign in affordance for a managed unauthenticated account —
    and never removes the account. Codex rows never mount this (device login owns
    its own inline affordance in AccountRow). */
function ClaudeLoginRow({ account, state, loginBusy }: { account: AccountOption; state: EngineAccountsState; loginBusy: boolean }) {
  const { t } = useLocale();
  const login = account.login ?? null;
  const phase = login?.phase;
  const nonterminal = login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(login.phase);
  // The op's own Cancel/Submit gate on the shared mutation lock; the Sign in and
  // Retry affordances also stand down while any Claude login is nonterminal (C10).
  const busy = state.mutation !== null;
  const rowRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Drop the pasted code the moment we leave code entry so it never lingers or
  // re-submits after a phase change (C6). Adjusting state during render (the
  // React-endorsed "reset on prop change" pattern) keeps it off an effect; the
  // row is also keyed by operationId so a fresh op after a retry starts clean.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase !== "awaiting_code") {
      setCode("");
      setSubmitted(false);
    }
  }

  // Keep focus inside the sub-row when a control the operator just pressed
  // unmounts across a phase change (C9). Other transitions preserve their focus.
  useEffect(() => {
    if (wantFocus.current) {
      wantFocus.current = false;
      rowRef.current?.focus();
    }
  });
  const activate = (run: () => void) => {
    wantFocus.current = true;
    run();
  };

  if (nonterminal && login) {
    const cancelable = phase !== "canceling";
    const cancelButton = (
      <button
        type="button"
        onClick={() => activate(() => void state.cancelLogin(login.operationId))}
        disabled={busy || !cancelable}
        className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {t("accounts.claudeLogin.cancel")}
      </button>
    );
    const spinnerLine = (key: "accounts.claudeLogin.starting" | "accounts.claudeLogin.awaitingBrowser" | "accounts.claudeLogin.verifying" | "accounts.claudeLogin.canceling") => (
      <div className="flex items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-dim" aria-hidden />
        <span className="min-w-0 flex-1 text-[11px] text-dim">{t(key)}</span>
        {cancelable ? cancelButton : null}
      </div>
    );
    const hintId = `${login.operationId}-hint`;
    return (
      <div
        ref={rowRef}
        tabIndex={-1}
        role="group"
        aria-label={t("accounts.claudeLogin.groupAria", { label: account.label })}
        className="flex flex-col gap-1.5 px-3 pb-2 pl-[26px] focus-visible:outline-none"
      >
        {phase === "starting" ? spinnerLine("accounts.claudeLogin.starting") : null}
        {phase === "awaiting_browser" ? spinnerLine("accounts.claudeLogin.awaitingBrowser") : null}
        {phase === "verifying" ? spinnerLine("accounts.claudeLogin.verifying") : null}
        {phase === "canceling" ? spinnerLine("accounts.claudeLogin.canceling") : null}
        {phase === "awaiting_code" ? (
          <>
            {/* The link renders only in awaiting_code — it is stale once the code
                is submitted. The URL is server-vetted; render it verbatim. */}
            {login.loginUrl ? (
              <a href={login.loginUrl} target="_blank" rel="noreferrer noopener" className="text-[11px] font-semibold text-accent underline">
                {t("accounts.claudeLogin.openLink")}
              </a>
            ) : null}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (submitted || busy || code.trim() === "") return;
                activate(() => {
                  setSubmitted(true);
                  void state.submitLoginCode(login.operationId, code);
                });
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                maxLength={8192}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={t("accounts.claudeLogin.codeLabel")}
                aria-describedby={hintId}
                placeholder={t("accounts.claudeLogin.codePlaceholder")}
                className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <button
                type="submit"
                disabled={busy || submitted || code.trim() === ""}
                className="h-8 shrink-0 rounded-[8px] border border-line bg-bg px-2.5 text-[11px] font-semibold hover:bg-chip disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("accounts.claudeLogin.submit")}
              </button>
            </form>
            <p id={hintId} className="text-[10px] leading-snug text-dim">{t("accounts.claudeLogin.codeHint")}</p>
            <div className="flex justify-end">{cancelButton}</div>
          </>
        ) : null}
      </div>
    );
  }

  // Terminal failure (failed / timed_out / interrupted): sanitized copy + Retry.
  if (login && login.result?.status === "failure") {
    return (
      <div ref={rowRef} tabIndex={-1} role="alert" className="flex items-center gap-2 px-3 pb-2 pl-[26px] focus-visible:outline-none">
        <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-err">{t(claudeLoginErrKey(login.result.code))}</span>
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("accounts.retry")}
        </button>
      </div>
    );
  }

  // Managed account with no auth and no live op (covers canceled and the broken
  // production account): a Sign in affordance that restarts login in place.
  if (account.kind === "managed" && !account.authPresent) {
    return (
      <div ref={rowRef} tabIndex={-1} className="flex items-center gap-2 px-3 pb-2 pl-[26px] focus-visible:outline-none">
        <button
          type="button"
          onClick={() => activate(() => void state.retryLogin(account.id))}
          disabled={busy || loginBusy}
          className="shrink-0 rounded-[7px] border border-line bg-bg px-2.5 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("accounts.claudeLogin.signIn")}
        </button>
      </div>
    );
  }

  return null;
}

/** Derived polite announcement for the sign-in live region (C9): the code-ready
    prompt while any account awaits its code, then the signed-in confirmation.
    Deriving from current state means the aria-live text changes exactly on the
    transition, with no effect and no mount-time announcement. */
function claudeAnnouncement(engine: "claude" | "codex", accounts: AccountOption[], t: TFunction): string {
  if (engine !== "claude") return "";
  const awaitingCode = accounts.find((account) => account.login?.phase === "awaiting_code");
  if (awaitingCode) return t("accounts.claudeLogin.announceCodeReady", { label: awaitingCode.label });
  const signedIn = accounts.find((account) => account.login?.phase === "authenticated");
  if (signedIn) return t("accounts.claudeLogin.announceDone", { label: signedIn.label });
  return "";
}

/** Progress banner pinned at the top of the panel while an intent drains, and a
    one-line notice once it settles. `aria-live="polite"` announces completion
    once (the region owns the migration + auto-balance announcements). */
function MigrationBanner({ state }: { state: EngineAccountsState }) {
  const { t } = useLocale();
  const model = bannerModel(state.migration);
  const engine = engineDisplay(state.engine);
  if (!model) return null;
  const draining = model.state === "draining";
  return (
    <div role="status" aria-live="polite" aria-label={t("migrate.bannerAria", { engine })} className="flex flex-col gap-1 border-b border-line bg-accent/5 px-3 py-2">
      {draining ? (
        <>
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none text-accent" aria-hidden />
            <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-ink">
              {model.auto ? <span className="mr-1 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent">{t("autobalance.bannerTag")}</span> : null}
              {t("migrate.banner", { label: model.targetLabel, done: model.done, total: model.total })}
            </span>
            {model.failed ? (
              <button
                type="button"
                onClick={() => void state.retryFailedMigration()}
                disabled={state.mutation !== null}
                className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("migrate.bannerRetryFailed", { n: model.failed })}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void state.stopMigration()}
              disabled={state.mutation !== null}
              className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("migrate.stop")}
            </button>
          </div>
          {model.waitingTurn || model.failed ? (
            <div className="flex gap-2 pl-5 text-[10.5px] text-dim">
              {model.waitingTurn ? <span>{t("migrate.bannerWaiting", { n: model.waitingTurn })}</span> : null}
              {model.failed ? <span className="text-err">{t("migrate.bannerFailed", { n: model.failed })}</span> : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] text-dim">
            {model.failed > 0
              ? t("migrate.failedNotice", { label: model.targetLabel, n: model.failed })
              : model.state === "stopped"
                ? t("migrate.stoppedNotice", { label: model.targetLabel })
                : t("migrate.completeNotice", { engine, label: model.targetLabel })}
          </span>
          {model.failed > 0 ? (
            // A terminal intent that still carries failed-recoverable sessions
            // keeps the bulk retry (Terra retains the intent while counts.failed
            // stays positive), so terminal recoverable failures remain recoverable.
            <button
              type="button"
              onClick={() => void state.retryFailedMigration()}
              disabled={state.mutation !== null}
              className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("migrate.bannerRetryFailed", { n: model.failed })}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Per-engine Auto balance switch + description + status line. The switch uses
    `role="switch"` with `aria-checked` and text (never color alone); the status
    line is a polite live region. */
function AutoBalanceSection({ state }: { state: EngineAccountsState }) {
  const { t, locale } = useLocale();
  // A coarse clock so the cooldown countdown line stays fresh between polls,
  // read from state (never Date.now() in render — React Compiler purity).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const auto = state.autoBalance;
  if (!auto) return null;
  const engine = engineDisplay(state.engine);
  const labelFor = (id: string) => state.accounts.find((account) => account.id === id)?.label ?? id;
  const line = autoBalanceLine(auto, now, locale);
  const windowName = (w: string) => t(w === "weekly" ? "limits.windowWeekly" : "limits.windowSession");
  const statusText =
    line.kind === "hidden"
      ? null
      : line.kind === "idle"
        ? t("autobalance.idle", { time: String(line.params.time) })
        : line.kind === "waitingFresh"
          ? t("autobalance.waitingFresh")
          : line.kind === "cooldown"
            ? t("autobalance.cooldown", { n: Number(line.params.n) })
            : line.kind === "draining"
              ? t("autobalance.draining")
              : t("autobalance.switched", {
                  to: labelFor(String(line.params.to)),
                  from: labelFor(String(line.params.from)),
                  pct: Number(line.params.pct),
                  time: String(line.params.time),
                  window: windowName(String(line.params.window)),
                });
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[12px] font-bold text-ink">{t("autobalance.title")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={auto.enabled}
          aria-label={t("autobalance.toggleAria", { engine })}
          disabled={state.mutation !== null}
          onClick={() => void state.setAutoBalance(!auto.enabled)}
          className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${auto.enabled ? "bg-accent" : "bg-chip"}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${auto.enabled ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
        </button>
      </div>
      <p className="mt-0.5 text-[10.5px] leading-snug text-dim">{t("autobalance.desc", { threshold: auto.thresholdPercent })}</p>
      <p role="status" aria-live="polite" className="mt-1 min-h-[13px] text-[10.5px] font-semibold text-dim">
        {statusText}
      </p>
    </div>
  );
}

/** The scope confirm step: replaces the account list in place so the operator
    reads exactly what moves before anything mutates. Focus moves to the title;
    Escape backs out here first (see the dialog's keydown handler). */
function ConfirmStep({
  state,
  targetId,
  preview,
  onDone,
  onCancel,
}: {
  state: EngineAccountsState;
  targetId: string;
  preview: MigrationPreview;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const engine = engineDisplay(state.engine);
  const label = preview.targetLabel;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const retarget = Boolean(state.migration && state.migration.state === "draining");
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <div className="px-3 py-2.5">
      <h3 ref={titleRef} tabIndex={-1} className="text-[12.5px] font-bold text-ink focus-visible:outline-none">
        {retarget ? t("migrate.retargetTitle", { label }) : t("migrate.confirmTitle", { engine, label })}
      </h3>
      <p className="mt-1 text-[11px] leading-snug text-dim">
        {retarget
          ? t("migrate.retargetBody", { current: state.migration!.targetLabel, label })
          : t("migrate.confirmBody", { total: preview.counts.total, idle: preview.counts.idle, busy: preview.counts.busy, label })}
      </p>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[8px] border border-line bg-bg px-2.5 py-1 text-[11px] font-semibold hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("migrate.confirmCancel")}
        </button>
        <button
          type="button"
          disabled={state.mutation !== null}
          onClick={() => {
            void state.selectAndMigrate(targetId, preview.previewRevision);
            onDone();
          }}
          className="rounded-[8px] border border-accent bg-accent px-2.5 py-1 text-[11px] font-bold text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {t("migrate.confirmCta")}
        </button>
      </div>
    </div>
  );
}

/**
 * Unified, engine-parameterized Accounts panel. Symmetric for Claude and Codex:
 * account list with capacity chips, per-engine Auto balance switch, a scope
 * confirm step before any migration, a draining banner with Stop, and the
 * add-account form.
 *
 * `placement` picks the desktop anchor for the caller's surface (mobile always
 * uses the bottom sheet):
 * - `"footer"` (the limits footer): a flyout beside the rail (`sm:left-full`),
 *   bottom-aligned, mirroring the resources CleanupPanel.
 * - `"header"` (the Switchboard header): a dropdown below the trigger
 *   (`sm:top-full`). The header sits at the top of an overflow-hidden modal, so
 *   a bottom-anchored flyout would grow upward out of that shell and clip; the
 *   header placement anchors downward and stays inside the box.
 */
export function AccountsPanel({
  state,
  onClose,
  placement = "footer",
}: {
  state: EngineAccountsState;
  onClose: () => void;
  placement?: "footer" | "header";
}) {
  const { t } = useLocale();
  const { accounts, active, status, notice, mutation, engine } = state;
  const [label, setLabel] = useState("");
  // While any Claude account has a live login op, the add/sign-in/retry starters
  // stand down so a second login can't race the supervisor (C10).
  const loginBusy = engine === "claude" && accounts.some((account) => account.login != null && NONTERMINAL_CLAUDE_LOGIN_PHASES.has(account.login.phase));
  // One polite live region per panel (C9). Derived from current state, so the
  // aria-live text changes exactly on the code-ready and signed-in transitions —
  // no effect/setState needed, and mount content is never announced.
  const announcement = claudeAnnouncement(engine, accounts, t);
  const [confirm, setConfirm] = useState<{ targetId: string; preview: MigrationPreview } | null>(null);
  /* A preview that fails to parse must never fall through to an instant switch
     (finding 3): the operator would silently reroute new spawns with no scope
     shown and no durable intent. The failed target is held here and shown as a
     recoverable, announced error with a Retry. */
  const [previewError, setPreviewError] = useState<{ targetId: string; label: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const engineName = engineDisplay(engine);
  // Desktop anchor per caller; both share the mobile bottom sheet. The header
  // placement drops downward (`sm:top-full`) so an overflow-hidden ancestor
  // can't clip the panel; the footer keeps the bottom-aligned right-side flyout.
  const placementClass =
    placement === "header"
      ? "sm:absolute sm:top-full sm:left-0 sm:mt-2 sm:bottom-auto sm:translate-x-0"
      : "sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0";

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Every switch surface previews first — there is no mode-less bare switch left
  // (issue #40). Clicking the already-active account is allowed too: its preview
  // surfaces sessions still stranded on a stale generation so a zero-scope,
  // revision-fenced migration can repair them.
  const onSelect = async (id: string) => {
    if (mutation) return;
    setPreviewError(null);
    const preview = await state.preview(id);
    switch (accountSelectOutcome(preview)) {
      case "recoverable-error":
        // A failed preview holds the target and surfaces a retryable error; it
        // never falls through to a switch (finding 3).
        setPreviewError({ targetId: id, label: accounts.find((account) => account.id === id)?.label ?? id });
        return;
      case "confirm":
        setConfirm({ targetId: id, preview: preview! });
        return;
      case "migrate":
        // No live sessions in scope: submit a zero-scope, revision-fenced
        // migration so new spawns adopt the target through the durable intent
        // path.
        await state.selectAndMigrate(id, preview!.previewRevision);
        return;
    }
  };

  const onAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || mutation) return;
    const created = await state.add(trimmed);
    if (created) setLabel("");
  };

  return (
    <>
      {/* Mobile-only backdrop that absorbs the outside tap so it closes only the
          sheet, never the project drawer beneath it (desktop is a flyout). */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        aria-label={t("accounts.close")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-40 cursor-default sm:hidden"
      />
      <div
        role="dialog"
        aria-label={t("accounts.titleFor", { engine: engineName })}
        // Escape is owned by this sheet's subtree: the confirm step backs out
        // first, then the sheet closes and returns focus. See handleOverlayEscape.
        onKeyDown={(event) => {
          if (event.key === "Escape" && confirm) {
            event.stopPropagation();
            setConfirm(null);
            return;
          }
          handleOverlayEscape(event, onClose);
        }}
        className={`fixed bottom-3 left-1/2 z-50 flex w-[min(360px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-line bg-panel shadow-[0_8px_28px_rgba(20,20,30,0.14)] ${placementClass}`}
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="text-[12.5px] font-bold">{t("accounts.titleFor", { engine: engineName })}</span>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("accounts.close")}
            onClick={onClose}
            className="ml-auto rounded-[6px] p-1 text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

        <MigrationBanner state={state} />

        {previewError ? (
          <div role="alert" aria-live="assertive" className="flex items-center gap-2 border-b border-line bg-[#fff5f5] px-3 py-1.5">
            <span className="min-w-0 flex-1 text-[11px] font-semibold text-err">
              {t("accounts.previewFailed", { label: previewError.label })}
            </span>
            <button
              type="button"
              disabled={mutation !== null}
              onClick={() => void onSelect(previewError.targetId)}
              className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              {t("accounts.retry")}
            </button>
          </div>
        ) : null}

        {confirm ? (
          <ConfirmStep
            state={state}
            targetId={confirm.targetId}
            preview={confirm.preview}
            onDone={() => setConfirm(null)}
            onCancel={() => setConfirm(null)}
          />
        ) : (
          <>
            <AutoBalanceSection state={state} />
            <div className="max-h-[min(300px,50vh)] overflow-y-auto py-1">
              {status === "loading" ? <div className="px-3 py-2 text-[11px] text-dim">{t("accounts.loading")}</div> : null}
              {status === "error" && accounts.length === 0 ? <div className="px-3 py-2 text-[11px] text-dim">{t("accounts.noAccounts")}</div> : null}
              {accounts.map((account) => (
                <Fragment key={account.id}>
                  <AccountRow account={account} engine={engine} activeId={active} disabled={mutation !== null} onSelect={() => void onSelect(account.id)} />
                  {engine === "claude" ? <ClaudeLoginRow key={account.login?.operationId ?? account.id} account={account} state={state} loginBusy={loginBusy} /> : null}
                </Fragment>
              ))}
            </div>
            <form onSubmit={onAdd} className="flex items-center gap-2 border-t border-line px-3 py-2">
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("accounts.labelPlaceholder")}
                className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
              <button
                type="submit"
                disabled={mutation !== null || label.trim() === "" || loginBusy}
                className="h-8 shrink-0 rounded-[8px] border border-line bg-bg px-2.5 text-[11px] font-semibold hover:bg-chip disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                {t("accounts.confirmAdd")}
              </button>
            </form>
            {notice ? (
              <div className="flex items-center gap-2 border-t border-line px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={accountNoticeText(t, notice)}>{accountNoticeText(t, notice)}</span>
                {notice.action ? (
                  <button
                    type="button"
                    disabled={mutation !== null}
                    onClick={() => void state.retryNotice().then((recovered) => {
                      if (recovered && notice.operation === "add") setLabel("");
                    })}
                    className="shrink-0 rounded-[7px] border border-line bg-bg px-2 py-0.5 text-[11px] font-semibold hover:bg-chip focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {t("accounts.retry")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
