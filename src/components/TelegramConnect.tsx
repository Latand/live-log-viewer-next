"use client";

import { useEffect, useRef, useState } from "react";

import { Send } from "lucide-react";

import { useTelegramConnection, type TelegramConnectionState } from "@/hooks/useTelegramConnection";
import { type TFunction, useLocale } from "@/lib/i18n";
import { handleOverlayEscape } from "@/lib/overlay";
import type { TelegramErrorCode, TelegramPhase, TelegramStatusPayload } from "@/lib/telegram/contracts";

import { Loader2, Trash2, X } from "./icons";

/**
 * The Telegram row in the left-rail footer and its flyout panel (issue #1059).
 * Reuses the accounts-surface mechanics wholesale: the same desktop flyout
 * beside the rail with the mobile bottom sheet (AccountsPanel), client-side QR
 * rendering through the `qrcode` package (AccessQrButton), inline destructive
 * confirmation (AccountRow), and one polite aria-live region for phase
 * transitions (ClaudeLoginRow).
 */

/* Every phase has a `telegram.status.<phase>` message in both dictionaries
   (proven by the render tests), so the key is derived rather than tabulated. */
function statusKey(phase: TelegramPhase): Parameters<TFunction>[0] {
  return `telegram.status.${phase}` as Parameters<TFunction>[0];
}

export function telegramErrKey(code: TelegramErrorCode): Parameters<TFunction>[0] {
  const known: Record<TelegramErrorCode, Parameters<TFunction>[0]> = {
    credentials_missing: "telegram.err.credentials_missing",
    start_failed: "telegram.err.start_failed",
    bridge_failed: "telegram.err.bridge_failed",
    password_invalid: "telegram.err.password_invalid",
    network_failed: "telegram.err.network_failed",
    timed_out: "telegram.err.timed_out",
    canceled: "telegram.err.canceled",
    session_unsafe: "telegram.err.session_unsafe",
    connector_failed: "telegram.err.connector_failed",
    not_read_only: "telegram.err.not_read_only",
    logout_failed: "telegram.err.logout_failed",
    health_failed: "telegram.err.health_failed",
  };
  return known[code] ?? "telegram.err.bridge_failed";
}

function phaseColor(phase: TelegramPhase): string {
  if (phase === "connected") return "var(--color-success)";
  if (phase === "expired") return "var(--color-warning)";
  if (phase === "error") return "var(--color-danger)";
  if (phase === "disconnected") return "transparent";
  return "var(--color-accent)";
}

/** Derived polite announcement — changes exactly on the phase transition, so
    no effect and no mount-time announcement (the ClaudeLoginRow pattern). */
function announcement(status: TelegramStatusPayload | null, t: TFunction): string {
  if (!status) return "";
  if (status.phase === "awaiting_scan") return t("telegram.announceScan");
  if (status.phase === "awaiting_password") return t("telegram.announcePassword");
  if (status.phase === "connected") return t("telegram.announceConnected");
  return "";
}

function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Client-drawn QR for the tg://login token, keyed by url so a stale image
    never flashes for a refreshed token (the AccessQrButton pattern). */
function QrImage({ url }: { url: string }) {
  const { t } = useLocale();
  const [qr, setQr] = useState<{ url: string; dataUrl: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("qrcode")
      .then(({ toDataURL }) => toDataURL(url, { margin: 1, width: 200 }))
      .then((dataUrl) => {
        if (!cancelled) setQr({ url, dataUrl });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!qr || qr.url !== url) return <span className="mx-auto flex h-[200px] items-center text-[12px] text-primary">{t("telegram.qrGenerating")}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={qr.dataUrl} alt={t("telegram.qrAlt")} className="mx-auto h-[200px] w-[200px] rounded-[8px] bg-white p-1" />;
}

function ActionButton({ label, onClick, disabled, tone = "neutral" }: { label: string; onClick: () => void; disabled?: boolean; tone?: "neutral" | "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] shrink-0 items-center rounded-[7px] border border-border px-2.5 py-0.5 text-[11px] font-semibold disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px] ${
        tone === "danger" ? "bg-canvas text-danger hover:bg-danger-soft" : "bg-canvas hover:bg-sunken"
      }`}
    >
      {label}
    </button>
  );
}

/** Inline destructive confirmation, the AccountRow removal pattern: arm on the
    first press, execute only on an explicit confirm. */
function ConfirmingAction({ label, prompt, onConfirm, disabled, icon }: { label: string; prompt: string; onConfirm: () => void; disabled?: boolean; icon?: React.ReactNode }) {
  const { t } = useLocale();
  const [arming, setArming] = useState(false);
  if (!arming) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArming(true)}
        className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[10.5px] font-semibold text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {icon}
        {label}
      </button>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
      <span className="min-w-0 flex-1 text-right text-[10.5px] font-semibold leading-snug text-danger">{prompt}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setArming(false);
          onConfirm();
        }}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] bg-danger px-2 py-0.5 text-[10.5px] font-semibold text-white hover:opacity-90 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {t("telegram.confirmCta")}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArming(false)}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] px-2 py-0.5 text-[10.5px] font-semibold text-secondary hover:bg-canvas disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px]"
      >
        {t("telegram.confirmCancel")}
      </button>
    </span>
  );
}

export function TelegramPanel({ state, onClose }: { state: TelegramConnectionState; onClose: () => void }) {
  const { t } = useLocale();
  const { status, busy } = state;
  const phase = status?.phase ?? "disconnected";
  const closeRef = useRef<HTMLButtonElement>(null);
  const [password, setPassword] = useState("");
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // The password field drops the moment the phase leaves awaiting_password —
  // reset-on-prop-change, no effect (the ClaudeLoginRow pattern, C6).
  const [seenPhase, setSeenPhase] = useState<TelegramPhase>(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase !== "awaiting_password") setPassword("");
  }

  const cancelButton = (
    <ActionButton label={t("telegram.cancel")} onClick={() => void state.cancel()} disabled={busy} />
  );
  const spinnerLine = (label: string) => (
    <div className="flex items-center gap-2">
      <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none text-muted" aria-hidden />
      <span className="min-w-0 flex-1 text-[11px] text-muted">{label}</span>
      {cancelButton}
    </div>
  );
  const checkedAt = formatCheckedAt(status?.lastHealthCheckAt ?? null);

  return (
    <>
      {/* Mobile-only backdrop absorbing the outside tap (AccountsPanel). */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        aria-label={t("telegram.close")}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-40 cursor-default sm:hidden"
      />
      <div
        role="dialog"
        aria-label={t("telegram.title")}
        aria-busy={busy}
        onKeyDown={(event) => handleOverlayEscape(event, onClose)}
        className="fixed bottom-3 left-1/2 z-50 flex w-[min(320px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[14px] border border-border bg-card shadow-2 sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0"
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Send className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-accent)" }} aria-hidden />
          <span className="text-[12.5px] font-bold">{t("telegram.title")}</span>
          <span className="truncate text-[9.5px] font-medium text-muted">{t("telegram.readOnlyNote")}</span>
          <button
            ref={closeRef}
            type="button"
            aria-label={t("telegram.close")}
            onClick={onClose}
            className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[6px] p-1 text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </header>

        <p className="sr-only" role="status" aria-live="polite">{announcement(status, t)}</p>

        <div className="flex flex-col gap-2 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: phaseColor(phase), boxShadow: phase === "disconnected" ? "inset 0 0 0 1.5px var(--color-border)" : "none" }}
            />
            <span className="text-[11.5px] font-semibold text-primary">{t(statusKey(phase))}</span>
          </div>

          {phase === "disconnected" ? (
            <>
              <p className="text-[10.5px] leading-snug text-muted">{t("telegram.connectHint")}</p>
              <ActionButton label={t("telegram.connect")} onClick={() => void state.connect()} disabled={busy} />
            </>
          ) : null}

          {phase === "starting" ? spinnerLine(t("telegram.status.starting")) : null}
          {phase === "verifying" ? spinnerLine(t("telegram.status.verifying")) : null}

          {phase === "awaiting_scan" && status?.login ? (
            <>
              {status.login.qr ? <QrImage url={status.login.qr.url} /> : <span className="mx-auto text-[12px] text-primary">{t("telegram.qrGenerating")}</span>}
              <p className="text-[10.5px] leading-snug text-muted">{t("telegram.qrHint")}</p>
              <div className="flex justify-end">{cancelButton}</div>
            </>
          ) : null}

          {phase === "awaiting_password" && status?.login ? (
            <>
              {status.login.passwordError ? (
                <p role="alert" className="text-[10.5px] font-semibold text-danger">{t("telegram.passwordInvalid")}</p>
              ) : null}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (busy || password === "") return;
                  void state.submitPassword(password);
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="off"
                  aria-label={t("telegram.passwordLabel")}
                  placeholder={t("telegram.passwordPlaceholder")}
                  className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
                />
                <button
                  type="submit"
                  disabled={busy || password === ""}
                  className="h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
                >
                  {t("telegram.passwordSubmit")}
                </button>
              </form>
              <p className="text-[10px] leading-snug text-muted">{t("telegram.passwordHint")}</p>
              <div className="flex justify-end">{cancelButton}</div>
            </>
          ) : null}

          {phase === "connected" ? (
            <>
              <div className="flex min-w-0 items-baseline gap-1.5 text-[11px]">
                <span className="shrink-0 text-muted">{t("telegram.connectedAs")}</span>
                <span className="truncate font-semibold text-primary">{status?.identity?.name}</span>
                {status?.identity?.username ? <span className="truncate font-mono text-[10px] text-muted">@{status.identity.username}</span> : null}
              </div>
              {checkedAt ? <p className="text-[9.5px] font-semibold text-secondary">{t("telegram.lastCheck", { time: checkedAt })}</p> : null}
            </>
          ) : null}

          {phase === "expired" ? (
            <>
              <p className="text-[10.5px] leading-snug text-muted">{t("telegram.expiredHint")}</p>
              <ActionButton label={t("telegram.reconnect")} onClick={() => void state.connect()} disabled={busy} />
            </>
          ) : null}

          {phase === "error" ? (
            <>
              <p role="alert" className="text-[10.5px] font-semibold leading-snug text-danger">
                {t(telegramErrKey(status?.error?.code ?? "bridge_failed"))}
              </p>
              <ActionButton label={t("telegram.retry")} onClick={() => void state.connect()} disabled={busy} />
            </>
          ) : null}

          {(phase === "connected" || phase === "expired" || (phase === "error" && status?.credentialRef)) ? (
            <div className="flex flex-col gap-1 border-t border-border pt-1.5">
              {phase !== "expired" ? (
                <div className="flex items-center">
                  <ConfirmingAction
                    label={t("telegram.logout")}
                    prompt={t("telegram.logoutConfirm")}
                    onConfirm={() => void state.logout()}
                    disabled={busy}
                  />
                </div>
              ) : null}
              <div className="flex items-center">
                <ConfirmingAction
                  label={t("telegram.deleteLocal")}
                  prompt={t("telegram.deleteLocalConfirm")}
                  onConfirm={() => void state.deleteLocal()}
                  disabled={busy}
                  icon={<Trash2 className="h-3 w-3" aria-hidden />}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The footer entry point: one quiet row under the engine limits blocks. */
export function TelegramFooterRow() {
  const { t } = useLocale();
  const state = useTelegramConnection();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const phase = state.status?.phase ?? "disconnected";

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Outside-pointer close only; Escape belongs to the panel's dialog subtree
  // (the EngineLimitsBlock pattern, so one press never closes two layers).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Opening the panel refreshes the health reading it displays.
  useEffect(() => {
    if (open) void state.refresh(phase === "connected" || phase === "expired" || phase === "error");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("telegram.rowAria")}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center gap-2 px-3.5 py-1.5 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[36px]"
      >
        <Send className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="text-[11.5px] font-bold text-primary">{t("telegram.title")}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {state.status?.login ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none text-accent" aria-hidden /> : null}
          <span className="text-[10px] font-semibold text-muted">{t(statusKey(phase))}</span>
          <span
            aria-hidden
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: phaseColor(phase), boxShadow: phase === "disconnected" ? "inset 0 0 0 1.5px var(--color-border)" : "none" }}
          />
        </span>
      </button>
      {open ? <TelegramPanel state={state} onClose={close} /> : null}
    </div>
  );
}
