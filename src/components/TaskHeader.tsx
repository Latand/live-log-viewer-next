"use client";

import { useEffect, useState } from "react";

import { Play } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Hint } from "@/components/Hint";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import { useAgentCapabilities } from "./useAgentCapabilities";
import type { FileEntry } from "@/lib/types";

export function ProcessStatusChip({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  if (file.proc === "running") {
    return (
      <Badge tone="success" data-capture-volatile="pid">
        <Play className="h-3 w-3" aria-hidden /> PID {file.pid}
      </Badge>
    );
  }
  if (file.proc === "killed" || file.activity === "stalled") {
    return <Badge tone="danger">{t("task.interruptedBadge")}</Badge>;
  }
  if (file.proc === "done") {
    return <Badge tone="neutral">{t("task.finishedBadge")}</Badge>;
  }
  return null;
}

export function ProcessStatusControls({
  file,
  compact = false,
  hideChip = false,
}: {
  file: FileEntry;
  compact?: boolean;
  /** Drops the informational PID/status chip and keeps only the kill action —
      the phone pane header has no room for read-only chips. */
  hideChip?: boolean;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [confirming, setConfirming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [message, setMessage] = useState("");
  const [forceNext, setForceNext] = useState(false);

  /* Kill obeys the one capability matrix (issue #241 §4) — never a control that
     posts to `/api/proc` on a surface where the header PID isn't the thing to
     kill. A structured host now shows an *enabled* Kill that enters the durable
     structured control channel (#242, `structuredSession` present); a
     dead/finished/unresolved host omits it; only a live tmux root/subagent (or a
     shell task) invokes the SIGTERM/SIGKILL endpoint. A live subagent's own
     proc/pid is null (the root writes its transcript), so /api/proc resolves the
     kill to the canonical root pid server-side. */
  const { caps, structuredSession } = useAgentCapabilities(file);
  const killCap = caps.controls.kill;

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const chip = <ProcessStatusChip file={file} />;
  const kill = async () => {
    setKilling(true);
    setMessage("");
    try {
      if (structuredSession) {
        /* Structured host (#242): Kill enters the durable structured control
           channel keyed by the canonical ROOT conversation identity — a single
           /api/tmux → dispatchStructuredControl request that never touches
           /api/proc, and with no SIGTERM/SIGKILL escalation (the host manages
           the process). For a structured-root subagent `structuredSession` is
           the ROOT's session, so the kill addresses the root, not the child. */
        const res = await fetch("/api/tmux", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "kill", conversationId: structuredSession.session.conversationId }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setMessage(json.error ?? t("task.stopFailed"));
          return;
        }
        setMessage(t("task.killRequested"));
        setConfirming(false);
        return;
      }
      const res = await fetch("/api/proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: file.path, force: forceNext }),
      });
      const json = (await res.json()) as { ok?: boolean; pid?: number; error?: string };
      if (!res.ok || !json.ok) {
        setMessage(json.error ?? t("task.stopFailed"));
        setForceNext(true);
        return;
      }
      setMessage(t("task.signalSent", { signal: forceNext ? "SIGKILL" : "SIGTERM", pid: json.pid ?? "" }));
      setConfirming(false);
    } catch {
      setMessage(t("common.serverUnavailable"));
      setForceNext(true);
    } finally {
      setKilling(false);
    }
  };

  const killDisabled = killCap.state === "disabled";
  const killReason = killDisabled ? t(killCap.reason) : "";
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${compact ? "text-[10.5px]" : "text-xs"}`}>
      {hideChip ? null : chip}
      {killDisabled ? (
        /* Structured host: the button exists (designed now, per #241) but is
           inert with a tooltip naming when it arrives (#240). */
        <Hint label={killReason}>
          <button
            type="button"
            aria-disabled
            disabled
            aria-label={`${t("task.kill")} — ${killReason}`}
            className={`inline-flex items-center whitespace-nowrap rounded-full border border-border bg-card text-[11px] font-semibold text-muted opacity-50 ${
              isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
            }`}
          >
            {t("task.kill")}
          </button>
        </Hint>
      ) : killCap.state === "enabled" ? (
        confirming ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-[8px] border border-danger/30 bg-danger-soft px-1.5 py-0.5">
            {compact ? null : (
              <span className="truncate px-1 text-[11px] font-semibold text-danger">{t("task.confirmKill", { pid: file.pid ?? "" })}</span>
            )}
            <button
              className={`inline-flex items-center whitespace-nowrap rounded-lg bg-danger text-[11px] font-bold tabular-nums text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50 ${
                isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
              }`}
              disabled={killing}
              onClick={kill}
            >
              {forceNext ? "SIGKILL" : compact ? t("task.killPid", { pid: file.pid ?? "" }) : t("task.confirmKillYes")}
            </button>
            <button
              className={`inline-flex items-center whitespace-nowrap rounded-lg border border-border bg-card text-[11px] font-semibold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
              }`}
              onClick={() => setConfirming(false)}
            >
              {compact ? t("common.no") : t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            className={`inline-flex items-center whitespace-nowrap rounded-full border border-border bg-card text-[11px] font-semibold text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
            }`}
            aria-label={t("task.stopAria", { pid: file.pid ?? "" })}
            onClick={() => setConfirming(true)}
          >
            {t("task.kill")}
          </button>
        )
      ) : null}
      {message ? <span className="max-w-[220px] truncate text-[11px] font-semibold text-muted">{message}</span> : null}
    </span>
  );
}

export function TaskHeader({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  if (file.root !== "claude-tasks") return null;
  return (
    <div className="mb-4 mt-1 rounded-[12px] border border-border bg-card px-4 py-3 shadow-1">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ProcessStatusChip file={file} />
      </div>
      {file.cmd ? (
        <>
          <div className="mb-1 text-[13px] font-semibold">{file.cmdDesc || t("task.backgroundCommand")}</div>
          <code className="block whitespace-pre-wrap break-words rounded-lg border border-border bg-sunken px-2.5 py-2 font-mono text-[12px]">
            $ {file.cmd}
          </code>
        </>
      ) : (
        <div className="text-[13px] text-muted">{t("task.commandNotFound")}</div>
      )}
    </div>
  );
}
