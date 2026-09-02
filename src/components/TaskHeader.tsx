"use client";

import { useCallback, useEffect, useState } from "react";

import { Play } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { Hint } from "@/components/Hint";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import { cleanTitle } from "@/lib/title";
import type { Capability } from "./agentCapabilities";
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

/**
 * Killing a conversation's agent, apart from the control that draws it.
 *
 * Mobile v2 lane 3: the phone's Kill is a labelled row last in the
 * conversation's `⋯` menu, in danger colour, and it acts on the tap — no arm
 * step anywhere (README §2 rule 9, Q4). The row and the desktop's chip-side
 * button must never own two different kill paths, so both read this: the one
 * capability gate (#241 §4), the structured control channel for a structured
 * host (#242), and `/api/proc` with the SIGTERM→SIGKILL escalation otherwise.
 */
export interface ProcessKill {
  /** `enabled` shows the control, `disabled` shows it inert with a reason,
      `hidden` means this surface has nothing to kill. */
  state: Capability["state"];
  /** Why it is disabled, already translated; "" when it is not. */
  reason: string;
  busy: boolean;
  /** The next `/api/proc` attempt escalates to SIGKILL (a SIGTERM failed). */
  force: boolean;
  /** The outcome line the caller shows: a signal receipt, or a failure. */
  message: string;
  /** Fires the kill and answers whether the request was ACCEPTED. A caller
      that armed the action first keeps it armed on false, so the escalation
      the failure just unlocked is the next press rather than a re-arm. */
  kill: () => Promise<boolean>;
}

export function useProcessKill(file: FileEntry): ProcessKill {
  const { t } = useLocale();
  const [killing, setKilling] = useState(false);
  const [message, setMessage] = useState("");
  const [forceNext, setForceNext] = useState(false);
  const { caps, structuredSession } = useAgentCapabilities(file);
  const killCap = caps.controls.kill;
  const kill = useCallback(async (): Promise<boolean> => {
    setKilling(true);
    setMessage("");
    try {
      const result = await requestKill(file, structuredSession, forceNext);
      if (!result.ok) {
        setMessage(result.error ?? t("task.stopFailed"));
        if (!result.structured) setForceNext(true);
        return false;
      }
      setMessage(result.structured
        ? t("task.killRequested")
        : t("task.signalSent", { signal: forceNext ? "SIGKILL" : "SIGTERM", pid: result.pid ?? "" }));
      return true;
    } catch {
      setMessage(t("common.serverUnavailable"));
      setForceNext(true);
      return false;
    } finally {
      setKilling(false);
    }
  }, [file, structuredSession, forceNext, t]);
  return {
    state: killCap.state,
    reason: killCap.state === "disabled" ? t(killCap.reason) : "",
    busy: killing,
    force: forceNext,
    message,
    kill,
  };
}

/** The one kill request. Structured hosts (#242) go through the durable
    control channel keyed by the canonical ROOT conversation identity and never
    escalate; everything else posts to `/api/proc`, which resolves a live
    subagent's kill to its root pid server-side. */
async function requestKill(
  file: FileEntry,
  structuredSession: ReturnType<typeof useAgentCapabilities>["structuredSession"],
  force: boolean,
): Promise<{ ok: boolean; structured: boolean; pid?: number; error?: string }> {
  if (structuredSession) {
    const res = await fetch("/api/tmux", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "kill", conversationId: structuredSession.session.conversationId }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: res.ok && Boolean(json.ok), structured: true, error: json.error };
  }
  const res = await fetch("/api/proc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file.path, force }),
  });
  const json = (await res.json()) as { ok?: boolean; pid?: number; error?: string };
  return { ok: res.ok && Boolean(json.ok), structured: false, pid: json.pid, error: json.error };
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
  /* Kill obeys the one capability matrix (issue #241 §4) and one request path
     (`useProcessKill`): never a control that posts to `/api/proc` on a surface
     where the header PID isn't the thing to kill. */
  const kill = useProcessKill(file);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const chip = <ProcessStatusChip file={file} />;
  /* The armed row survives a REFUSED kill (#699/#700): a SIGTERM that failed
     is exactly when the operator wants the next press, and `useProcessKill`
     has already flipped the button's word to SIGKILL. Only an accepted request
     collapses the row. The phone never arms, so this is desktop-only. */
  const act = async () => {
    if (await kill.kill()) setConfirming(false);
  };
  /* What the destructive action will stop, by name (issue #700). */
  const killTargetName = cleanTitle(file.title, 48) || t("task.confirmKillUntitled");
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${compact ? "text-[10.5px]" : "text-xs"}`}>
      {hideChip ? null : chip}
      {kill.state === "disabled" ? (
        /* Structured host: the button exists (designed now, per #241) but is
           inert with a tooltip naming when it arrives (#240). */
        <Hint label={kill.reason}>
          <button
            type="button"
            aria-disabled
            disabled
            aria-label={`${t("task.kill")} — ${kill.reason}`}
            className={`inline-flex items-center whitespace-nowrap rounded-full border border-border bg-card text-[11px] font-semibold text-muted opacity-50 ${
              isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
            }`}
          >
            {t("task.kill")}
          </button>
        </Hint>
      ) : kill.state === "enabled" ? (
        /* No confirmation prompts on the phone (README §2 rule 9, Q4): Kill
           acts on the tap that names it, and the receipt carries the inverse.
           Desktop keeps the two-step arm from #699/#700, which names the
           conversation instead of a bare PID. */
        confirming && !isMobile ? (
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[8px] border border-danger/30 bg-danger-soft px-1.5 py-0.5">
            <span
              className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold text-danger"
              title={file.pid === null ? undefined : t("task.confirmKill", { pid: file.pid })}
            >
              {t("task.confirmKillNamed", { name: killTargetName })}
            </span>
            {file.pid === null ? null : (
              <span className="hidden shrink-0 text-[10px] tabular-nums text-muted sm:inline">PID {file.pid}</span>
            )}
            <button
              className="inline-flex shrink-0 items-center whitespace-nowrap rounded-lg bg-danger px-2 py-0.5 text-[11px] font-bold tabular-nums text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/50"
              disabled={kill.busy}
              onClick={act}
            >
              {kill.force ? "SIGKILL" : compact ? t("common.yes") : t("task.confirmKillYes")}
            </button>
            <button
              className="inline-flex items-center whitespace-nowrap rounded-lg border border-border bg-card px-2 py-0.5 text-[11px] font-semibold text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => setConfirming(false)}
            >
              {compact ? t("common.no") : t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            className={`inline-flex items-center whitespace-nowrap rounded-full border border-border bg-card text-[11px] font-semibold text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
              isMobile ? "min-h-11 px-3" : "px-2 py-0.5"
            }`}
            aria-label={t("task.stopAria", { pid: file.pid ?? "" })}
            disabled={isMobile && kill.busy}
            onClick={isMobile ? act : () => setConfirming(true)}
          >
            {t("task.kill")}
          </button>
        )
      ) : null}
      {kill.message ? <span className="max-w-[220px] truncate text-[11px] font-semibold text-muted">{kill.message}</span> : null}
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
