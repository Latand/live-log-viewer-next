"use client";

import { useEffect, useRef, useState } from "react";

import { MoreHorizontal } from "lucide-react";
import { ArrowUpToLine, Check, FoldVertical, Loader2, Play, Square, SquareTerminal } from "@/components/icons";

import { Hint } from "@/components/Hint";
import { AgentRuntimeControls, DisabledRuntimeControls, ResumeRuntimeControls } from "@/components/AgentRuntimeControls";
import { AttachTerminalDialog } from "@/components/AttachTerminalDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { interruptRuntime } from "@/hooks/useRuntime";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { mintIdempotencyKey } from "@/components/runtime/runtimeModel";
import { useAgentCapabilities } from "./useAgentCapabilities";
import {
  stripHasVisibleControls,
  type Capability,
  type ControlName,
  type StripCapabilities,
  type StripSurface,
} from "./agentCapabilities";

/** Width faces (design §3). Continuous scheme-node zoom picks these by measured
    pane width, not a media query. */
type StripLayout = "full" | "narrow" | "mini";

/** One icon button honoring a control's capability: enabled, or disabled with a
    tooltip naming why/when (the reason is appended to the aria-label so screen
    readers hear it too — design §4). Hidden controls never reach here. */
function StripButton({
  t,
  cap,
  ariaLabel,
  hint,
  busy,
  onClick,
  children,
  className = "",
  isMobile,
}: {
  t: TFunction;
  cap: Capability;
  ariaLabel: MessageKey;
  hint: MessageKey;
  busy?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  isMobile: boolean;
}) {
  const disabled = cap.state === "disabled";
  /* An enabled control may still carry an explanatory `note` (e.g. a subagent
     Stop that interrupts the root agent). Both the disabled reason and the
     enabled note ride into the aria-label and the hover hint so the effect is
     never a surprise and screen readers hear it too (§4). */
  const explain = disabled ? t(cap.reason) : cap.state === "enabled" && cap.note ? t(cap.note) : "";
  const label = explain ? `${t(ariaLabel)} — ${explain}` : t(ariaLabel);
  const size = isMobile ? "h-11 w-11" : "p-2";
  return (
    <Hint label={explain || t(hint)}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        disabled={disabled || busy}
        onClick={onClick}
        className={`inline-flex shrink-0 items-center justify-center gap-1 rounded-control text-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${size} ${className}`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : children}
      </button>
    </Hint>
  );
}

/** The mode chip — where the message goes (design §2 item 1). */
function ModeChip({ t, surface }: { t: TFunction; surface: StripSurface }) {
  const face = (() => {
    switch (surface) {
      case "structured":
        return { icon: <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden />, label: t("composer.structured"), title: t("composer.structuredHost") };
      case "live-subagent":
        return { icon: <ArrowUpToLine className="h-3 w-3 shrink-0" aria-hidden />, label: t("composer.root"), title: t("composer.titleRelay") };
      case "resume":
        return { icon: <Play className="h-3 w-3 shrink-0" aria-hidden />, label: t("strip.resume"), title: t("composer.titleSpawnResumed") };
      case "dead":
        return { icon: <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden />, label: t("strip.deadMode"), title: t("deadHost.body") };
      default:
        return { icon: <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden />, label: t("strip.live"), title: t("branch.live") };
    }
  })();
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-control bg-sunken px-1.5 py-1 text-caption font-semibold text-secondary"
      title={face.title}
    >
      {face.icon}
      <span className="truncate">{face.label}</span>
    </span>
  );
}

export interface AgentControlStripViewProps {
  t: TFunction;
  isMobile: boolean;
  caps: StripCapabilities;
  layout: StripLayout;
  runtimeSlot: React.ReactNode | null;
  compactArmed: boolean;
  stopBusy: boolean;
  compactBusy: boolean;
  overflowOpen: boolean;
  onStop: () => void;
  onCompact: () => void;
  onTerminal: () => void;
  onToggleOverflow: () => void;
  status: { kind: "ok" | "info" | "err"; text: string } | null;
}

const visible = (cap: Capability) => cap.state !== "hidden";

/**
 * Presentational unified control strip (issue #241). Pure — its control set,
 * disabled-with-tooltip vs. hidden treatment, 44px mobile targets, and busy
 * states are DOM-tested against capability fixtures. Mounted once by
 * `BranchPane`, above the composer (and even when the composer is hidden).
 */
export function AgentControlStripView({
  t,
  isMobile,
  caps,
  layout,
  runtimeSlot,
  compactArmed,
  stopBusy,
  compactBusy,
  overflowOpen,
  onStop,
  onCompact,
  onTerminal,
  onToggleOverflow,
  status,
}: AgentControlStripViewProps) {
  const { controls, surface } = caps;
  /* Owner-critical controls always stay on the face (§3): Stop and the runtime
     pill. Compact and Terminal fold into the overflow on narrow/mini and on the
     phone. */
  const foldsSecondary = isMobile || layout !== "full";
  const overflowNeeded =
    foldsSecondary && (visible(controls.compact) || visible(controls.terminal));

  const stopBtn = visible(controls.stop) ? (
    <StripButton
      t={t}
      isMobile={isMobile}
      cap={controls.stop}
      ariaLabel="composer.interruptAria"
      hint="composer.interruptTitle"
      busy={stopBusy}
      onClick={onStop}
      className="hover:text-danger"
    >
      <Square className="h-4 w-4" fill="currentColor" aria-hidden />
    </StripButton>
  ) : null;

  const compactBtn = visible(controls.compact) ? (
    <StripButton
      t={t}
      isMobile={isMobile}
      cap={controls.compact}
      ariaLabel="composer.compactAria"
      hint={compactArmed ? "composer.compactConfirmTitle" : "composer.compactTitle"}
      busy={compactBusy}
      onClick={onCompact}
      className={compactArmed ? "bg-info/10 text-info" : "hover:text-info"}
    >
      {compactArmed ? (
        <>
          <Check className="h-4 w-4" aria-hidden />
          <span className="text-[10.5px] font-bold">{t("composer.compactConfirm")}</span>
        </>
      ) : (
        <FoldVertical className="h-4 w-4" aria-hidden />
      )}
    </StripButton>
  ) : null;

  const terminalBtn = visible(controls.terminal) ? (
    <StripButton
      t={t}
      isMobile={isMobile}
      cap={controls.terminal}
      ariaLabel="attach.dialogTitle"
      hint="attach.dialogTitle"
      onClick={onTerminal}
      className="hover:text-accent"
    >
      <SquareTerminal className="h-4 w-4" aria-hidden />
    </StripButton>
  ) : null;

  return (
    <div
      data-agent-control-strip
      data-strip-surface={surface}
      data-strip-layout={layout}
      className="flex shrink-0 flex-col gap-1 border-t border-border bg-card px-2.5 py-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ModeChip t={t} surface={surface} />
        {stopBtn}
        {/* Runtime pill/selects always stay on the face. */}
        {runtimeSlot}
        {/* Secondary controls: inline on the full desktop face, folded otherwise. */}
        {foldsSecondary ? null : compactBtn}
        {foldsSecondary ? null : terminalBtn}
        {overflowNeeded ? (
          <Hint label={t("strip.moreActions")}>
            <button
              type="button"
              aria-expanded={overflowOpen}
              aria-label={t("strip.moreActions")}
              onClick={onToggleOverflow}
              className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isMobile ? "h-11 w-11" : "p-2"
              }`}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </Hint>
        ) : null}
      </div>
      {overflowNeeded && overflowOpen ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {compactBtn}
          {terminalBtn}
        </div>
      ) : null}
      {status ? (
        <span
          role="status"
          aria-live={status.kind === "err" ? "assertive" : "polite"}
          className={`truncate text-caption font-semibold ${status.kind === "ok" ? "text-success" : status.kind === "info" ? "text-warning" : "text-danger"}`}
        >
          {status.text}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Container: computes the capability matrix for this conversation, builds the
 * runtime group for the surface, and wires the stop/compact/attach actions. The
 * header keeps only identity + status; this footer strip is the single action
 * surface (design §2).
 */
export function AgentControlStrip({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const { caps, attachMode, structuredSession } = useAgentCapabilities(file);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<StripLayout>("full");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactArmed, setCompactArmed] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "info" | "err"; text: string } | null>(null);

  /* Width is the collapse trigger (§3) — scheme nodes vary continuously with
     zoom, so a ResizeObserver on the strip beats any media query. */
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 999;
      setLayout(width >= 430 ? "full" : width >= 300 ? "narrow" : "mini");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!compactArmed) return;
    const id = window.setTimeout(() => setCompactArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [compactArmed]);

  if (!stripHasVisibleControls(caps)) return null;

  const stop = async () => {
    if (stopBusy) return;
    setStopBusy(true);
    setStatus(null);
    try {
      const result = structuredSession
        ? await interruptRuntime(structuredSession.session.conversationId, mintIdempotencyKey())
        : await fetch("/api/tmux", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "interrupt", path: file.path }),
          }).then(async (response) => {
            const body = (await response.json()) as { ok?: boolean; error?: string };
            return { ok: response.ok && body.ok === true, error: body.error };
          });
      setStatus(result.ok ? { kind: "ok", text: t("composer.escapeSent") } : { kind: "err", text: result.error ?? t("composer.failedInterrupt") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setStopBusy(false);
    }
  };

  const compact = async () => {
    if (!compactArmed) {
      setCompactArmed(true);
      return;
    }
    setCompactArmed(false);
    if (compactBusy) return;
    setCompactBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "compact", path: file.path }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      setStatus(response.ok && body.ok ? { kind: "ok", text: t("composer.compactSent") } : { kind: "err", text: body.error ?? t("composer.failedCompact") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setCompactBusy(false);
    }
  };

  const runtimeSlot = runtimeSlotFor(t, caps.surface, caps.controls.runtime, file);

  return (
    <div ref={rootRef}>
      <AgentControlStripView
        t={t}
        isMobile={isMobile}
        caps={caps}
        layout={layout}
        runtimeSlot={runtimeSlot}
        compactArmed={compactArmed}
        stopBusy={stopBusy}
        compactBusy={compactBusy}
        overflowOpen={overflowOpen}
        onStop={() => void stop()}
        onCompact={() => void compact()}
        onTerminal={() => setAttachOpen(true)}
        onToggleOverflow={() => setOverflowOpen((open) => !open)}
        status={status}
      />
      {attachOpen ? <AttachTerminalDialog file={file} mode={attachMode} onClose={() => setAttachOpen(false)} /> : null}
    </div>
  );
}

/** The runtime (model·effort·apply) group for a surface, or null when hidden. */
function runtimeSlotFor(t: TFunction, surface: StripSurface, cap: Capability, file: FileEntry): React.ReactNode | null {
  if (cap.state === "hidden") return null;
  if (file.engine !== "claude" && file.engine !== "codex") return null;
  if (surface === "live-root") return <AgentRuntimeControls file={file} />;
  if (surface === "resume") return <ResumeRuntimeControls file={file} />;
  if (surface === "structured" && cap.state === "disabled") return <DisabledRuntimeControls file={file} reason={t(cap.reason)} />;
  return null;
}
