"use client";

import { useEffect, useState } from "react";

import { Play } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

export function ProcessStatusChip({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  if (file.proc === "running") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#e5f6ea] px-2 py-0.5 text-[11px] font-bold tabular-nums text-ok">
        <Play className="h-3 w-3" aria-hidden /> PID {file.pid}
      </span>
    );
  }
  if (file.proc === "killed" || file.activity === "stalled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#f7e8e8] px-2 py-0.5 text-[11px] font-bold text-err">
        {t("task.interruptedBadge")}
      </span>
    );
  }
  if (file.proc === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[11px] font-bold text-dim">
        {t("task.finishedBadge")}
      </span>
    );
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

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${compact ? "text-[10.5px]" : "text-xs"}`}>
      {hideChip ? null : chip}
      {file.proc === "running" ? (
        confirming ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5">
            {compact ? null : (
              <span className="truncate px-1 text-[11px] font-semibold text-err">{t("task.confirmKill", { pid: file.pid ?? "" })}</span>
            )}
            <button
              className={`inline-flex items-center whitespace-nowrap rounded-lg bg-err text-[11px] font-bold tabular-nums text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50 ${
                isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
              }`}
              disabled={killing}
              onClick={kill}
            >
              {forceNext ? "SIGKILL" : compact ? t("task.killPid", { pid: file.pid ?? "" }) : t("task.confirmKillYes")}
            </button>
            <button
              className={`inline-flex items-center whitespace-nowrap rounded-lg border border-line bg-panel text-[11px] font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
              }`}
              onClick={() => setConfirming(false)}
            >
              {compact ? t("common.no") : t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            className={`inline-flex items-center whitespace-nowrap rounded-full border border-line bg-panel text-[11px] font-semibold text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
            }`}
            aria-label={t("task.stopAria", { pid: file.pid ?? "" })}
            onClick={() => setConfirming(true)}
          >
            {t("task.kill")}
          </button>
        )
      ) : null}
      {message ? <span className="max-w-[220px] truncate text-[11px] font-semibold text-dim">{message}</span> : null}
    </span>
  );
}

export function TaskHeader({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  if (file.root !== "claude-tasks") return null;
  return (
    <div className="mb-4 mt-1 rounded-[14px] border border-line bg-panel px-4 py-3 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ProcessStatusChip file={file} />
      </div>
      {file.cmd ? (
        <>
          <div className="mb-1 text-[13.5px] font-semibold">{file.cmdDesc || t("task.backgroundCommand")}</div>
          <code className="block whitespace-pre-wrap break-words rounded-lg border border-line bg-[#fafafc] px-2.5 py-2 font-mono text-[12.5px]">
            $ {file.cmd}
          </code>
        </>
      ) : (
        <div className="text-[13.5px] text-dim">{t("task.commandNotFound")}</div>
      )}
    </div>
  );
}
