"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MoreHorizontal } from "lucide-react";
import { ArrowUpToLine, Check, FoldVertical, Loader2, Play, RotateCw, Square, SquareTerminal } from "@/components/icons";

import { Hint } from "@/components/Hint";
import { AttachTerminalDialog } from "@/components/AttachTerminalDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { interruptRuntime, refreshRuntime } from "@/hooks/useRuntime";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { humanReceiptReasonKey, mintIdempotencyKey, type RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { turnIsRunning } from "./turnDuration";
import { useAgentCapabilities } from "./useAgentCapabilities";
import {
  stripHasVisibleControls,
  type Capability,
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

/** The mode chip — where the message goes (design §2 item 1). The `structured`
    surface renders no chip (issue #390): a structured host is the normal
    conversation shape, so the badge carried no routing information — the
    remaining chips all do. */
function ModeChip({ t, surface }: { t: TFunction; surface: StripSurface }) {
  const face = (() => {
    switch (surface) {
      case "structured":
        return null;
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
  if (!face) return null;
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
  compactArmed: boolean;
  stopBusy: boolean;
  compactBusy: boolean;
  /** The compact Re-check control's in-flight state; the container owns it.
      Optional so presentational harnesses can render the strip without it. */
  recheckBusy?: boolean;
  overflowOpen: boolean;
  onStop: () => void;
  onCompact: () => void;
  onRecheck?: () => void;
  onTerminal: () => void;
  onToggleOverflow: () => void;
  status: { kind: "ok" | "info" | "err"; text: string } | null;
}

const visible = (cap: Capability) => cap.state !== "hidden";

/**
 * The strip's status line. Most entries are a finished sentence, decided when
 * the action answered. The interrupt is not: "sent Escape — agent interrupted"
 * asserts something about the TURN, and the card paints that same turn as a
 * running spinner right below. So the interrupt keeps the turn it was aimed at
 * and resolves its wording against the live turn state instead of freezing a
 * claim that the next poll can contradict.
 */
type StripStatus =
  | { kind: "ok" | "info" | "err"; text: string }
  | { kind: "interrupt"; turnStartedAt: number | null };

/**
 * What the interrupt note may truthfully say beside the working spinner. The
 * turn the Escape was aimed at decides, and it decides FIRST:
 *
 *  - the card has moved on to another turn → the note is about a turn the
 *    operator can no longer see, so it retires;
 *  - that same turn is still running → the Escape is on its way, and the card
 *    says exactly that instead of announcing a stop that has not happened;
 *  - that same turn is over → the completed interrupt, as before.
 *
 * Identity, not liveness, is what retires the note — and that makes retirement
 * terminal. Retiring only while the newer turn RAN left the note to come back
 * the moment it ended, telling the operator that a turn nobody interrupted was
 * interrupted, and again after every turn after that.
 */
function resolvedStatus(
  status: StripStatus | null,
  file: Pick<FileEntry, "lastTurn" | "activity">,
  t: TFunction,
): { kind: "ok" | "info" | "err"; text: string } | null {
  if (!status || status.kind !== "interrupt") return status;
  if ((file.lastTurn?.startedAt ?? null) !== status.turnStartedAt) return null;
  return turnIsRunning(file)
    ? { kind: "ok", text: t("composer.escapeSentWaiting") }
    : { kind: "ok", text: t("composer.escapeSent") };
}

/**
 * Operator-facing text for a compact that did not start. Receipt reasons are
 * machine tokens (`busy-turn`, `stale-generation`, …) meant for the durable
 * record, so they go through the same reason→sentence map the composer's
 * receipt chips use; anything unmapped falls back to the generic failure line
 * rather than showing a token to someone reading Ukrainian.
 */
function compactFailureText(
  t: TFunction,
  reason: string | null | undefined,
  error: string | undefined,
  code: string | undefined,
): string {
  const key = humanReceiptReasonKey(reason);
  if (key) return t(key);
  /* A refusal that never became a receipt still has a machine code. The
     capability body's `error` is a server-side English sentence, so the code is
     what gets translated. */
  if (code === "unsupported-capability") return t("receipt.human.unsupportedCapability");
  return error ?? t("composer.failedCompact");
}

/**
 * What the durable compact receipt turned out to be (#1214). The strip's own
 * "sent" line is optimistic by necessity — it is written the moment the journal
 * admits the operation — so the receipt replaces it as soon as the operation
 * terminalizes. `uncertain` is the Claude path's honest ending: the command was
 * typed into the conversation and no compaction boundary was ever witnessed,
 * which the operator is told in those words rather than left to guess.
 */
function compactReceiptStatus(
  t: TFunction,
  receipt: RuntimeReceipt | undefined,
): { kind: "ok" | "info" | "err"; text: string } | null {
  if (!receipt) return null;
  if (receipt.status === "delivered") return { kind: "ok", text: t("composer.compactObserved") };
  if (receipt.status === "uncertain") {
    return {
      kind: "info",
      text: humanReceiptReasonKey(receipt.reason)
        ? t(humanReceiptReasonKey(receipt.reason)!)
        : t("receipt.human.compactSentUnobserved"),
    };
  }
  if (receipt.status === "rejected" || receipt.status === "failed") {
    return { kind: "err", text: compactFailureText(t, receipt.reason, undefined, undefined) };
  }
  return null;
}

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
  compactArmed,
  stopBusy,
  compactBusy,
  recheckBusy = false,
  overflowOpen,
  onStop,
  onCompact,
  onRecheck = () => undefined,
  onTerminal,
  onToggleOverflow,
  status,
}: AgentControlStripViewProps) {
  const { controls, surface } = caps;
  /* Owner-critical controls always stay on the face (§3): Stop. The runtime
     control moved into the composer's bottom row as the RuntimePill (issue
     #390). Compact and Terminal fold into the overflow on narrow/mini and on
     the phone. */
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

  /* Re-check (issue #561 item 4): a compact icon standing beside the interrupt
     state, never a wide banner button. It forces a fresh runtime snapshot, so
     it is the one recovery route that stays reachable in every surface state —
     including the blocked ones where Stop itself is disabled. It therefore
     stays on the face at every width instead of folding into the overflow. */
  const recheckBtn = (
    <StripButton
      t={t}
      isMobile={isMobile}
      cap={{ state: "enabled" }}
      ariaLabel="deadHost.recheck"
      hint="strip.recheckHint"
      busy={recheckBusy}
      onClick={onRecheck}
      className="hover:text-accent"
    >
      <RotateCw className="h-4 w-4" aria-hidden />
    </StripButton>
  );

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
        {recheckBtn}
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
 * Container: computes the capability matrix for this conversation and wires
 * the stop/compact/attach actions. The header keeps only identity + status;
 * the runtime control lives in the composer's RuntimePill (issue #390).
 */
export function AgentControlStrip({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const { caps, attachMode, structuredSession } = useAgentCapabilities(file);

  const observerRef = useRef<ResizeObserver | null>(null);
  const [layout, setLayout] = useState<StripLayout>("full");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const [compactArmed, setCompactArmed] = useState(false);
  /** The durable operation a confirmed compact gesture owns until it lands. */
  const compactOperationRef = useRef<string | null>(null);
  /** The admitted compact operation whose durable receipt the strip is still
      waiting on, so its real outcome replaces the optimistic line (#1214). */
  const [compactWatch, setCompactWatch] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [status, setStatus] = useState<StripStatus | null>(null);

  /** Every action starts from a clean line — including a settled compaction
      outcome, which would otherwise sit on the status line forever and hide the
      note the NEXT action wants to show (#1214). */
  const clearStatus = () => {
    setStatus(null);
    setCompactWatch(null);
  };

  /* One click, one command (operator request): the terminal button copies the
     COMPLETE resume command (cd + env + CLI) straight to the clipboard and
     confirms via the strip's own status toast — no dialog hop. The dialog
     remains the fallback for the live-tmux mode (two commands to choose from)
     and for any fetch/clipboard failure, so nothing is ever less capable than
     before. */
  const copyAttachCommand = async () => {
    if (attachMode === "live") {
      setAttachOpen(true);
      return;
    }
    clearStatus();
    try {
      const response = await fetch(`/api/attach-command?path=${encodeURIComponent(file.path)}`);
      const body = (await response.json()) as { fullCommand?: string; error?: string };
      if (response.ok && body.fullCommand) {
        const { copyText } = await import("@/components/feed/CopyButton");
        if (await copyText(body.fullCommand)) {
          setStatus({ kind: "ok", text: t("attach.copiedFull") });
          return;
        }
      }
    } catch {
      /* fall through to the dialog */
    }
    setAttachOpen(true);
  };

  /* Width is the collapse trigger (§3) — scheme nodes vary continuously with
     zoom, so a ResizeObserver on the strip beats any media query. A callback
     ref (not a mount-once effect) attaches it, because the strip root can mount
     LATE: an unresolved/gated surface renders nothing at first and the observed
     div only appears once host evidence arrives (#257). */
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 999;
      setLayout(width >= 430 ? "full" : width >= 300 ? "narrow" : "mini");
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    if (!compactArmed) return;
    const id = window.setTimeout(() => setCompactArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [compactArmed]);

  /* A claude-broker host has no compact subtype in its transport, so its
     compaction is a typed `/compact` whose completion the Viewer can only
     witness in the transcript (#1214). The strip's wording follows. */
  const claudeCompact = structuredSession?.session.hostKind === "claude-broker";
  const compactOutcome = compactReceiptStatus(
    t,
    compactWatch
      ? structuredSession?.receipts.find((receipt) =>
          receipt.kind === "compact" && receipt.operationId === compactWatch)
      : undefined,
  );

  if (!stripHasVisibleControls(caps)) return null;

  const stop = async () => {
    if (stopBusy) return;
    setStopBusy(true);
    clearStatus();
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
      setStatus(result.ok
        /* Keep the turn this Escape was aimed at: the note is about THAT turn,
           and the spinner beside it is about whichever turn is running now. */
        ? { kind: "interrupt", turnStartedAt: file.lastTurn?.startedAt ?? null }
        : { kind: "err", text: result.error ?? t("composer.failedInterrupt") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setStopBusy(false);
    }
  };

  const recheck = async () => {
    if (recheckBusy) return;
    setRecheckBusy(true);
    clearStatus();
    try {
      const ok = await refreshRuntime();
      if (!ok) setStatus({ kind: "err", text: t("deadHost.recheckFailed") });
    } finally {
      setRecheckBusy(false);
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
    clearStatus();
    /* #862: one durable operation per confirmed gesture. On a structured host
       this admits a real compaction, so a retry after a timeout or a failed
       response must replay that same operation — the id is only released once
       the request is known to have landed. `mintIdempotencyKey` is used for the
       same reason the composer does: `crypto.randomUUID` needs a secure
       context, and LAN http access gets the fallback. */
    const operationId = compactOperationRef.current ?? mintIdempotencyKey();
    compactOperationRef.current = operationId;
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "compact", path: file.path, operationId }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        receipt?: { status?: string; reason?: string | null };
      };
      /* A structured control answers 202 `ok` for an admitted receipt AND for
         one the journal refused, so the receipt — not the HTTP status — decides
         what the operator is told. Announcing a compaction that was rejected
         (a live turn is the ordinary case) would leave them waiting for a band
         that never arrives. */
      const settled = body.receipt?.status === "rejected" || body.receipt?.status === "failed";
      const accepted = response.ok && Boolean(body.ok) && !settled;
      /* The gesture's operation is released as soon as the journal reaches a
         verdict, refusal included. Idempotency replays a stored receipt for the
         same key forever, so holding the id past a rejection would answer every
         later click with that same stale refusal — the button would never
         compact this conversation again. It is held only while the outcome is
         genuinely unknown: a transport failure, or a throw below. */
      if (accepted || settled) compactOperationRef.current = null;
      setCompactWatch(accepted ? operationId : null);
      setStatus(accepted
        /* The Claude path reaches compaction by typing `/compact` into the
           conversation, so the admitted line promises a sent command and
           nothing more; the durable receipt says how it ended. */
        ? { kind: "ok", text: t(claudeCompact ? "composer.compactSentClaude" : "composer.compactSent") }
        : { kind: "err", text: compactFailureText(t, body.receipt?.reason, body.error, body.code) });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setCompactBusy(false);
    }
  };

  return (
    <div ref={rootRef}>
      <AgentControlStripView
        t={t}
        isMobile={isMobile}
        caps={caps}
        layout={layout}
        compactArmed={compactArmed}
        stopBusy={stopBusy}
        compactBusy={compactBusy}
        recheckBusy={recheckBusy}
        overflowOpen={overflowOpen}
        onStop={() => void stop()}
        onCompact={() => void compact()}
        onRecheck={() => void recheck()}
        onTerminal={() => void copyAttachCommand()}
        onToggleOverflow={() => setOverflowOpen((open) => !open)}
        status={compactOutcome ?? resolvedStatus(status, file, t)}
      />
      {attachOpen ? <AttachTerminalDialog file={file} mode={attachMode} onClose={() => setAttachOpen(false)} /> : null}
    </div>
  );
}
