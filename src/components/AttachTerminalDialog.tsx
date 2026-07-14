"use client";

import { useEffect, useState } from "react";

import { Check, Copy, Loader2, SquareTerminal, X } from "@/components/icons";
import { AlertTriangle } from "lucide-react";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { AttachCommand } from "@/lib/agent/attachCommand";
import type { AttachMode } from "./agentCapabilities";

async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* clipboard blocked (plain HTTP / permissions) — the field stays selectable */
  }
  return false;
}

/** One labelled command block with its own copy button and copied confirmation. */
function CopyRow({ t, label, value }: { t: TFunction; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="flex items-stretch gap-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-control border border-border bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-primary">
        {value}
      </code>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void copyText(value).then((ok) => ok && setCopied(true))}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 self-stretch rounded-control border border-border bg-canvas px-2.5 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:py-1"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? t("attach.copied") : t("attach.copy")}
      </button>
    </div>
  );
}

/** The live-tmux attach payload (§6): the running pane's attach command plus a
    read-only variant — no take-over warning, a read-only toggle instead. */
export interface LiveAttachPayload {
  command: string;
  readOnlyCommand: string;
}

export interface AttachTerminalDialogViewProps {
  t: TFunction;
  loading: boolean;
  error: string | null;
  /** Resume payload (structured / finished / dead hosts). */
  command: AttachCommand | null;
  /** Live-tmux payload (a running pane) — takes precedence over `command`. */
  live?: LiveAttachPayload | null;
  onClose: () => void;
  onSecondary?: () => void;
  secondaryBusy?: boolean;
}

/** Presentational attach dialog — instant, copyable, no waiting (issue #247
    item 2). Pure so its copy payloads and secondary action are DOM-tested. */
export function AttachTerminalDialogView({
  t,
  loading,
  error,
  command,
  live = null,
  onClose,
  onSecondary,
  secondaryBusy = false,
}: AttachTerminalDialogViewProps) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-3"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("attach.dialogTitle")}
        className="flex max-h-[85vh] w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-surface border border-border bg-card p-4 shadow-2"
      >
        <div className="flex items-start gap-2">
          <SquareTerminal className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-bold text-primary">{t("attach.dialogTitle")}</h2>
            {live ? (
              <p className="mt-0.5 text-label text-muted">{t("attach.hint")}</p>
            ) : command ? (
              <p className="mt-0.5 text-label text-muted">
                {t("attach.dialogIntro", { account: command.accountLabel })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {loading ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 py-4 text-label font-semibold text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("attach.loading")}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-control border border-danger/45 bg-danger-soft px-3 py-2 text-label font-semibold text-danger">
            {error}
          </div>
        ) : live ? (
          <>
            {/* Live pane: attach to the running conversation, or watch it
                read-only — no take-over warning, a read-only toggle instead. */}
            <CopyRow t={t} label={t("attach.copy")} value={live.command} />
            <CopyRow t={t} label={t("attach.copyReadonly")} value={live.readOnlyCommand} />
            <div className="flex items-start gap-1.5 text-caption font-semibold text-muted">
              <SquareTerminal className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t("attach.readonlyHint")}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => void copyText(live.command)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-label font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> {t("attach.copyFull")}
              </button>
              {onSecondary ? (
                <button
                  type="button"
                  onClick={onSecondary}
                  disabled={secondaryBusy}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-canvas px-3 text-label font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-9"
                >
                  {secondaryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  {t("attach.secondaryViewer")}
                </button>
              ) : null}
            </div>
          </>
        ) : command ? (
          <>
            <CopyRow t={t} label={t("attach.copyCwd")} value={`cd ${command.cwd}`} />
            <CopyRow t={t} label={t("attach.copyCommand")} value={command.command} />
            {command.note === "subagent-root" ? (
              <p className="text-caption text-muted">{t("attach.subagentNote")}</p>
            ) : null}
            <div className="flex items-start gap-1.5 text-caption font-semibold text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t("attach.takeoverWarning")}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => void copyText(command.fullCommand)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-accent bg-accent px-3 text-label font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> {t("attach.copyFull")}
              </button>
              {onSecondary ? (
                <button
                  type="button"
                  onClick={onSecondary}
                  disabled={secondaryBusy}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-canvas px-3 text-label font-semibold text-muted hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:min-h-9"
                >
                  {secondaryBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  {t("attach.secondaryViewer")}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Container: fetches the composed command from `/api/attach-command` the moment
 * it mounts (all data is already in the registry — no spawn, no wait) and drives
 * the presentational view. The legacy viewer-side pane survives as the explicit
 * secondary action.
 */
export function AttachTerminalDialog({ file, onClose, mode = "resume" }: { file: FileEntry; onClose: () => void; mode?: AttachMode }) {
  const { t } = useLocale();
  const [command, setCommand] = useState<AttachCommand | null>(null);
  const [live, setLive] = useState<LiveAttachPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [secondaryBusy, setSecondaryBusy] = useState(false);

  useEffect(() => {
    // The dialog mounts fresh each open, so `loading`/`error` already start at
    // their initial values — no synchronous reset needed in the effect body.
    let cancelled = false;
    // A live tmux pane attaches to the running pane (subagents resolve to their
    // root pane server-side via the transcript host); every other surface hands
    // out a resume command (§6, finding 3).
    const request = mode === "live"
      ? fetch(`/api/tmux?attach=1&path=${encodeURIComponent(file.path)}`).then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { attach?: LiveAttachPayload; error?: string };
          if (cancelled) return;
          if (!response.ok || !body.attach) setError(body.error ?? t("attach.unavailable"));
          else setLive({ command: body.attach.command, readOnlyCommand: body.attach.readOnlyCommand });
        })
      : fetch(`/api/attach-command?path=${encodeURIComponent(file.path)}`).then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as AttachCommand & { error?: string };
          if (cancelled) return;
          if (!response.ok) setError(body.error ?? t("attach.unavailable"));
          else setCommand(body);
        });
    request
      .catch(() => { if (!cancelled) setError(t("attach.network")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file.path, mode, t]);

  const openViewerPane = async () => {
    if (secondaryBusy) return;
    setSecondaryBusy(true);
    try {
      await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "attach-terminal", path: file.path }),
      });
    } catch {
      /* the primary copy path is the recommended one; ignore viewer-pane errors */
    } finally {
      setSecondaryBusy(false);
    }
  };

  return (
    <AttachTerminalDialogView
      t={t}
      loading={loading}
      error={error}
      command={command}
      live={live}
      onClose={onClose}
      onSecondary={() => void openViewerPane()}
      secondaryBusy={secondaryBusy}
    />
  );
}
