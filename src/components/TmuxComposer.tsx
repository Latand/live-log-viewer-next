"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { ArrowRight, ArrowUpToLine, Check, ChevronRight, Loader2, Play, X } from "@/components/icons";
import { CircleAlert, RotateCcw } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useCodexRealtime } from "@/hooks/useCodexRealtime";
import { interruptRuntime, useRuntimeBusState, type RuntimeSessionView } from "@/hooks/useRuntime";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import { useViewerSelectedContext, viewerSelectedContext } from "@/lib/selection/viewerSelectedContext";
import { useHostTarget } from "@/hooks/useHostTarget";
import { accountIdFromPath } from "@/lib/accounts/badge";
import { conversationIdentity } from "@/lib/accounts/identity";
import { activeCardMigration, cardMigrationState, migrationHoldsDelivery, migrationHoldsSends, migrationTargetName } from "@/lib/accounts/migration";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

import { ComposerBar, composerSlotKind, type ComposerSlotKind } from "./ComposerBar";
import { chatState } from "./mobile/mobileChatState";
import { SelectedContextBadge } from "./SelectedContextBadge";
import { OutboxDispatcher } from "./conversation/OutboxDispatcher";
import {
  adoptOutbox,
  cancelOutbox,
  claimOutboxDispatch,
  enqueueOutbox,
  markOutboxResponded,
  outboxHistory,
  outboxAwaitsTurnBoundary,
  outboxReceiptPatch,
  outboxStateForReceiptStatus,
  rebindOutboxEchoText,
  releaseHeldOutbox,
  transcriptEchoCount,
  updateOutbox,
  useOutbox,
  useTranscriptEchoes,
  type OutboxEntry,
  type OutboxState,
} from "./conversation/outbox";
import {
  ComposerAdmissionTimeoutError,
  composerAdmissionTiming,
  reconcileComposerReceipt,
  withComposerAdmissionDeadline,
} from "./composerAdmissionDeadline";
import { RuntimePill } from "./RuntimePill";
import { savedResumeProfile, sendRuntimeFrom, type RuntimeProfile } from "./runtimeProfile";
import { type PendingAttachment, type PendingFile, type PendingImage, type RestoredFile } from "./imageAttachments";
import {
  DELIVERY_WAIT_TICK_MS,
  deliveryUncertainWhy,
  deliveryWaitFor,
  deliveryWaitPossible,
  deliveryWaitText,
  type DeliveryWait,
} from "./runtime/deliveryWait";
import { ReceiptChip, runtimeReceiptStatusText } from "./runtime/ReceiptChip";
import {
  deliveryAttemptGroups,
  deliveryEchoes,
  deliveryProblem,
  dismissedReceiptsKey,
  type DeliveryAttemptGroup,
  messageReceiptForAssistantTurn,
  readDismissedReceipts,
  visibleStandaloneReceipts,
  withDismissedReceipts,
  writeDismissedReceipts,
} from "./runtime/deliveryState";
import { deliveryNoticeRun, describeReceiptFailure, failureCauseKey } from "./runtime/deliveryNotice";
import { mintIdempotencyKey, receiptIsAdmitted, receiptIsTerminal, type HostAxis, type TurnAxis } from "./runtime/runtimeModel";
import { tmuxComposerRuntimeDependencies } from "./tmuxComposerRuntime";
import { VoiceConversationButton } from "./VoiceConversation";
import { commitBridgeTurn, useBridgeTurnStartDrain } from "@/hooks/useBridgeReportRelay";
import {
  bridgeAcknowledgementFor,
  forgetBridgeAcknowledgement,
  rememberBridgeAcknowledgement,
} from "@/lib/bridge/pendingAcknowledgements";

import { VoiceFloatButton } from "./voice/VoiceFloatButton";
import { isDesignatedManagerConversation } from "./voice/managerIdentity";
import { viewerContextPrelude } from "./voice/viewerContextPrelude";
import {
  getServerVoiceComposerHostMounted,
  getServerVoiceSlot,
  getVoiceComposerSlot,
  isVoiceComposerHostMounted,
  publishVoiceComposerCardNode,
  publishVoiceComposerCardProps,
  publishVoiceDockSlot,
  subscribeVoiceSlots,
} from "./voice/voiceSlots";

/** The persisted "on resume" runtime profile as a POST body fragment (issue
    #241 §4). `fast` is a codex-only service-tier override. */
function resumeProfileBody(file: FileEntry): { model?: string; effort?: string; fast?: boolean } {
  // Only an *explicitly applied* profile overrides the resume — absent one, the
  // send carries zero model/effort/fast so the native resume boots with the
  // conversation's own recorded runtime (finding 4).
  const draft = savedResumeProfile(file);
  if (!draft) return {};
  return {
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(file.engine === "codex" ? { fast: draft.fast } : {}),
  };
}

/**
 * A delivery receipt shown above the composer. `state` tracks whether the
 * message actually reached an agent: `sent` landed in a live pane or booted a
 * spawn; `held`/`queued`/`recovering` are the account-migration delivery states
 * (the backend accepted and is holding the text for the successor generation);
 * `failed` means a held delivery was stranded (e.g. a rollback) and the user
 * can retry. Held/queued/recovering/failed receipts persist across both the
 * desktop and mobile composers until they resolve or the user dismisses them.
 */
type DeliveryReceiptState = "sent" | "held" | "queued" | "recovering" | "failed";

interface SentEntry {
  id: number;
  text: string;
  at: number;
  /** How the message left: into an existing pane or by booting a new window. */
  via: "pane" | "spawn";
  /** Delivery lifecycle (defaults to `sent` for legacy receipts without it). */
  state?: DeliveryReceiptState;
  /** Idempotency key echoed to the backend so a retry can't double-deliver. */
  clientMessageId?: string;
}

interface ComposerSendResult {
  ok?: boolean;
  structured?: boolean;
  error?: string;
  /** HTTP status of the response, absent when the response was lost. */
  status?: number;
  imagePaths?: string[];
  /** Inbox paths the send's non-image attachments landed on (#1224). */
  filePaths?: string[];
  target?: string;
  spawned?: boolean;
  outcome?: "delivered-to-live" | "resumed" | "held" | "queued" | "delivering" | "delivered" | "recovering" | "failed";
  receipt?: RuntimeReceipt;
}

const SENT_LIMIT = 8;
const SPAWN_TTL_MS = 90_000;
const PANE_TTL_MS = 10 * 60_000;
const RECOVERABLE_BUSY_RETRY_REASONS = new Set(["delivery-auto-retry", "interrupt-auto-retry"]);
const sentKey = (id: string) => "llvSent:" + id;

export function deliveryAttemptKey(current: string, stored?: string): string {
  return stored || current;
}

type RetryAwareReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
const retryParentOperationId = (receipt: RuntimeReceipt): string | null =>
  (receipt as RetryAwareReceipt).retryOfOperationId ?? null;

export function mergeRuntimeReceipts(
  runtimeReceipts: RuntimeReceipt[],
  immediateReceipts: RuntimeReceipt[],
): RuntimeReceipt[] {
  const allReceipts = [...runtimeReceipts, ...immediateReceipts];
  const keysByOperationId = new Map<string, Set<string>>();
  const operationsByIdempotencyKey = new Map<string, Set<string>>();
  for (const receipt of allReceipts) {
    const keys = keysByOperationId.get(receipt.operationId) ?? new Set<string>();
    keys.add(receipt.idempotencyKey);
    keysByOperationId.set(receipt.operationId, keys);
    const operations = operationsByIdempotencyKey.get(receipt.idempotencyKey) ?? new Set<string>();
    operations.add(receipt.operationId);
    operationsByIdempotencyKey.set(receipt.idempotencyKey, operations);
  }
  const revisionOrder = (left: RuntimeReceipt, right: RuntimeReceipt) =>
    right.revision - left.revision
      || Date.parse(right.at) - Date.parse(left.at)
      || left.operationId.localeCompare(right.operationId)
      || left.idempotencyKey.localeCompare(right.idempotencyKey);
  /* Tier one: within one operationId the journal's revision counter is the
     single ordering authority, whichever plane (durable bus or immediate
     response) carried the receipt. */
  const sourced = [
    ...runtimeReceipts.map((receipt) => ({ receipt, durable: true })),
    ...immediateReceipts.map((receipt) => ({ receipt, durable: false })),
  ].sort((left, right) => revisionOrder(left.receipt, right.receipt));
  const currentByOperation = new Map<string, { receipt: RuntimeReceipt; durable: boolean }>();
  for (const entry of sourced) {
    if (!currentByOperation.has(entry.receipt.operationId)) currentByOperation.set(entry.receipt.operationId, entry);
  }
  /* Tier two: distinct operations claiming one idempotency key are the same
     logical message seen through two planes — a retry's optimistic projection
     onto its parent operation versus the durable retry leaf on the bus.
     Revisions of different operations count from different scopes, so the
     durable journal receipt outranks a projection before newest-state order. */
  const idempotencyKeys = new Set<string>();
  const attempts: RuntimeReceipt[] = [];
  for (const entry of [...currentByOperation.values()].sort((left, right) =>
    Number(right.durable) - Number(left.durable) || revisionOrder(left.receipt, right.receipt))) {
    if (idempotencyKeys.has(entry.receipt.idempotencyKey)) continue;
    idempotencyKeys.add(entry.receipt.idempotencyKey);
    attempts.push(entry.receipt);
  }
  const byOperationId = new Map(attempts.map((receipt) => [receipt.operationId, receipt]));
  const projectedOperationIds = new Set(attempts
    .filter((receipt) =>
      (keysByOperationId.get(receipt.operationId)?.size ?? 0) > 1
      || (operationsByIdempotencyKey.get(receipt.idempotencyKey)?.size ?? 0) > 1)
    .map((receipt) => receipt.operationId));
  const superseded = new Set<string>();
  for (const receipt of attempts) {
    const lineage = new Set<string>([receipt.operationId]);
    const ancestors: string[] = [];
    let ancestor = retryParentOperationId(receipt);
    let cyclic = false;
    while (ancestor) {
      if (lineage.has(ancestor)) {
        cyclic = true;
        break;
      }
      lineage.add(ancestor);
      const parent = byOperationId.get(ancestor);
      if (!parent) break;
      ancestors.push(ancestor);
      ancestor = retryParentOperationId(parent);
    }
    if (!cyclic) {
      for (const operationId of ancestors) superseded.add(operationId);
      continue;
    }
    const cycle = [receipt.operationId, ...ancestors]
      .map((operationId) => byOperationId.get(operationId))
      .filter((candidate): candidate is RuntimeReceipt => Boolean(candidate));
    const projected = cycle.filter((candidate) => projectedOperationIds.has(candidate.operationId));
    if (projected.length === 1 && projected[0]!.operationId === receipt.operationId) {
      for (const operationId of ancestors) superseded.add(operationId);
    }
  }
  return attempts
    .filter((receipt) => !superseded.has(receipt.operationId))
    .sort((left, right) =>
      Date.parse(right.at) - Date.parse(left.at)
        || right.revision - left.revision
        || left.operationId.localeCompare(right.operationId)
        || left.idempotencyKey.localeCompare(right.idempotencyKey));
}

const NO_DISMISSED: ReadonlySet<string> = new Set();

export function RuntimeComposerReceipts({
  receipts,
  actionsDisabled = false,
  dismissed = NO_DISMISSED,
  nowMs,
  session = null,
  onRetry,
  onEdit,
  onDismiss,
  onDiscard,
}: {
  receipts: RuntimeReceipt[];
  actionsDisabled?: boolean;
  /** Operation ids the user dismissed (issue #264 rule 3): settled problems in
      this set stay hidden; a still-moving attempt always renders. */
  dismissed?: ReadonlySet<string>;
  /** Clock the delivery waits are measured against (issue #1213). Production
      omits it and the row ticks itself; a test pins the instant. */
  nowMs?: number;
  /** The conversation's own host and turn axes, when a structured session is
      behind this composer (issue #1213). The authority for whether a parked
      message waits on a running turn or on a window that is gone — a receipt's
      reason cannot answer that, and guessing prints a false explanation under a
      message that never arrived. */
  session?: { host: HostAxis; turn: TurnAxis } | null;
  onRetry: (receipt: RuntimeReceipt, mode?: "uncertain") => void;
  onEdit: (receipt: RuntimeReceipt) => void;
  /** Persists a dismissal — receives every settled operation id of the row. */
  onDismiss?: (operationIds: string[]) => void;
  onDiscard?: (receipt: RuntimeReceipt) => void;
}) {
  const { t } = useLocale();
  const statusId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  /* Visibility and grouping live in the delivery-state model (issue #264):
     resolved successes render nothing (the feed bubble is the receipt), a
     group superseded by a successful resend of the same text goes quiet, and
     dismissed settled problems stay dismissed. */
  const attemptGroups = deliveryAttemptGroups(receipts, dismissed);
  const visibleAttempts = attemptGroups.flatMap((group) => group.attempts);
  /* A wait only becomes news by getting older, and nothing else re-renders this
     row while a message is parked at a turn boundary. One local interval, no
     store and no bus: the elapsed label advances and the uncertain bound is
     crossed on its own. It runs only while some attempt is still in a wait —
     a composer whose stack is empty or wholly settled has no label to advance,
     and re-rendering it every 15 s buys nothing. */
  const [tick, setTick] = useState(() => nowMs ?? Date.now());
  const pinnedNow = nowMs !== undefined;
  const unsettled = visibleAttempts.some((receipt) => deliveryWaitPossible(receipt.status));
  useEffect(() => {
    if (pinnedNow || !unsettled) return;
    const timer = setInterval(() => setTick(Date.now()), DELIVERY_WAIT_TICK_MS);
    return () => clearInterval(timer);
  }, [pinnedNow, unsettled]);
  const now = nowMs ?? tick;
  const isMessage = (receipt: RuntimeReceipt) => receipt.kind === "send" || receipt.kind === "steer";
  const editable = (receipt: RuntimeReceipt) => isMessage(receipt)
    && (receipt.status === "failed" || receipt.status === "rejected")
    && typeof receipt.text === "string"
    && receipt.text.length > 0
    && receipt.text.length < 240;
  const retryFailed = (receipt: RuntimeReceipt) => onRetry(
    receipt,
    receipt.resend === "verify-first" ? "uncertain" : undefined,
  );
  /* Measured from the receipt's own IMMUTABLE admission stamp, never from
     `at`: the queue bounces a parked send `delivering`→`queued` on every
     auto-retry and `at` moves with it, which both under-reports the wait and
     keeps it from ever crossing the uncertain bound. Automatic and explicit
     unknown-fate retries keep the same operation, so one stamp covers the
     whole time this logical message is owed. */
  const waitFor = (group: DeliveryAttemptGroup): DeliveryWait | null => deliveryWaitFor({
    status: group.current.status,
    host: session?.host ?? null,
    turn: session?.turn ?? null,
    admittedAt: group.current.admittedAt ?? group.current.at,
    nowMs: now,
  });
  const supersededStatusLabels = (attempts: RuntimeReceipt[]): string[] => {
    const counts = new Map<string, number>();
    for (const attempt of attempts.slice(1)) {
      const label = runtimeReceiptStatusText(t, attempt);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  };
  const standaloneReceipts = visibleStandaloneReceipts(receipts, dismissed);
  /* #1362: a message receipt with no text echo used to render one standalone
     pill per attempt — three retries, three full-width pills, each carrying
     the whole sentence. Settled message failures belong to the notice and the
     history under it now; only still-moving and non-message operations keep a
     standalone chip. Textless failures with one cause share one history row. */
  const textlessProblems = standaloneReceipts
    .filter((receipt) => isMessage(receipt) && deliveryProblem(receipt.status))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const standaloneChips = standaloneReceipts.filter((receipt) => !textlessProblems.includes(receipt));
  const textlessRows = textlessProblems.reduce<RuntimeReceipt[][]>((rows, receipt) => {
    const last = rows[rows.length - 1];
    if (last && failureCauseKey(last[0]!.reason) === failureCauseKey(receipt.reason)) last.push(receipt);
    else rows.push([receipt]);
    return rows;
  }, []);
  /* The one compact notice (issue #1362) stands in for the summary line while
     a settled failure is showing: identical consecutive failures fold into it
     behind an attempt counter, the row names a terse cause, and the full
     sentence with its remediation waits behind expand/hover. The per-message
     history below keeps the detail — the notice is its disclosure, not a copy. */
  const notice = deliveryNoticeRun(attemptGroups, textlessProblems);
  const noticeFailure = notice ? describeReceiptFailure(t, notice.current.reason) : null;
  const noticeLine = notice
    ? noticeFailure?.cause
      ? `${t("composer.receiptFailed")} — ${noticeFailure.cause}`
      : t("composer.receiptFailed")
    : null;
  const noticeAttemptLabel = notice && notice.attempts.length > 1
    ? t("runtime.receipt.attemptCount", { count: notice.attempts.length })
    : null;
  /* Same rule as the row: a same-key retry exists for a confirmed failure of a
     message, never for a rejection (Edit mints the new key there) or a discard. */
  const noticeRetryable = Boolean(notice
    && notice.current.status === "failed"
    && isMessage(notice.current)
    && notice.current.reason !== "delivery-discarded");
  /* Collapsed is the default state, and it is what the operator photographed:
     a warning badge counting an attempt that was never coming. A row that went
     terminally uncertain counts as a PROBLEM here, so the summary reads
     differently for "still arriving" and for "never arrived" (issue #1213). */
  const uncertainCurrent = attemptGroups
    .filter((group) => waitFor(group)?.phase === "uncertain")
    .map((group) => group.current);
  const uncertainOperationIds = new Set(uncertainCurrent.map((receipt) => receipt.operationId));
  const pendingReceipts = visibleAttempts.filter((receipt) =>
    !receiptIsTerminal(receipt.status) && !uncertainOperationIds.has(receipt.operationId));
  const problemReceipts = [
    ...visibleAttempts.filter((receipt) => deliveryProblem(receipt.status)),
    ...textlessProblems,
    ...uncertainCurrent,
  ];
  /* The notice already IS the settled-failure indicator, so beside it the red
     count badge speaks only for deliveries that went terminally uncertain. */
  const problemBadgeCount = notice ? uncertainCurrent.length : problemReceipts.length;
  const busyRetry = pendingReceipts.some((receipt) => typeof receipt.reason === "string" && RECOVERABLE_BUSY_RETRY_REASONS.has(receipt.reason));
  const receiptSummaryLabel = t("runtime.receipt.summary", { count: visibleAttempts.length });
  const disclosureLabel = t(detailsOpen ? "runtime.receipt.hideDetails" : "runtime.receipt.showDetails");
  const summaryAriaLabel = noticeLine
    ? `${disclosureLabel}. ${noticeLine}${noticeAttemptLabel ? `. ${noticeAttemptLabel}` : ""}`
    : `${disclosureLabel}. ${receiptSummaryLabel}`;
  /* On a phone the notice's actions keep the 44px hit area in a 32px box (the
     composer's own icon-button pattern: the hit extends through `before:`),
     so the terse cause keeps its width beside them at 390px. */
  const noticeActionClass = "relative inline-flex h-11 w-8 shrink-0 items-center justify-center rounded-control text-muted before:absolute before:inset-y-0 before:-inset-x-1.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 sm:h-6 sm:w-6 sm:before:hidden";

  return (
    <>
      {visibleAttempts.length || textlessRows.length ? (
        <>
          {/* `open` is controlled: the details element can unmount while all
              message receipts are resolved and remount for the next attempt,
              and the disclosure label must keep matching the real element. */}
          <details
            /* Failure reads through a 2px danger edge, the glyph and the label
               only (design §3.7: role in the edge, never a full wash) — an
               annotation under the composer, subordinate to it in both themes. */
            className={`group w-full min-w-0 rounded-control border border-border ${
              notice ? "border-l-2 border-l-danger " : ""
            }bg-sunken/55 text-caption text-secondary`}
            data-runtime-receipt-stack
            {...(notice ? { "data-delivery-notice": "" } : {})}
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary
              aria-describedby={statusId}
              aria-label={summaryAriaLabel}
              /* The notice row drops the vertical padding so its 44px touch
                 actions fit inside the same 44px line the summary always had. */
              className={`flex min-h-11 max-h-11 cursor-pointer list-none items-center overflow-hidden rounded-control px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden ${
                notice ? "gap-1 sm:gap-1.5" : "gap-1 py-1"
              }`}
            >
              <ChevronRight className="h-3 w-3 shrink-0 text-muted transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
              {notice ? (
                <>
                  <CircleAlert className="h-3 w-3 shrink-0 text-danger" aria-hidden />
                  {/* At rest: status word + terse cause on one truncating line;
                      the whole sentence rides on hover. */}
                  <span
                    className="min-w-0 flex-1 truncate"
                    data-delivery-notice-cause
                    title={noticeFailure?.full ?? undefined}
                  >
                    <span className="font-semibold text-danger">{t("composer.receiptFailed")}</span>
                    {noticeFailure?.cause ? <span className="text-secondary">{` — ${noticeFailure.cause}`}</span> : null}
                  </span>
                  {/* Counters are plain muted text, never badges (design rule 5). */}
                  {noticeAttemptLabel ? (
                    <span className="shrink-0 tabular-nums text-muted" data-delivery-notice-count title={noticeAttemptLabel}>
                      <span aria-hidden>×{notice.attempts.length}</span>
                      <span className="sr-only">{noticeAttemptLabel}</span>
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <span className="shrink-0 font-semibold text-primary">
                    {receiptSummaryLabel}
                  </span>
                  <span
                    className="min-w-[3rem] flex-1 truncate text-right text-muted"
                    data-receipt-preview
                    title={visibleAttempts[0]!.text ?? undefined}
                  >
                    {visibleAttempts[0]!.text}
                  </span>
                </>
              )}
              <span className="flex shrink-0 items-center gap-1" data-receipt-counts>
                {pendingReceipts.length ? (
                  <Badge
                    tone="warning"
                    data-receipt-pending-count
                    aria-label={`${t("runtime.receipt.pendingCount", { count: pendingReceipts.length })}${busyRetry ? ` · ${t("runtime.receipt.busyRetry")}` : ""}`}
                    title={busyRetry ? t("runtime.receipt.busyRetry") : t("runtime.receipt.pendingCount", { count: pendingReceipts.length })}
                  >
                    {busyRetry ? (
                      <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
                    ) : null}
                    <span className="sr-only">
                      {t("runtime.receipt.pendingCount", { count: pendingReceipts.length })}
                      {busyRetry ? ` · ${t("runtime.receipt.busyRetry")}` : null}
                    </span>
                    <span aria-hidden data-receipt-count-value>{pendingReceipts.length}</span>
                  </Badge>
                ) : null}
                {problemBadgeCount ? (
                  <Badge
                    tone="danger"
                    data-receipt-problem-count
                    aria-label={t("runtime.receipt.problemCount", { count: problemBadgeCount })}
                    title={t("runtime.receipt.problemCount", { count: problemBadgeCount })}
                  >
                    <span aria-hidden>!</span>
                    <span className="sr-only">{t("runtime.receipt.problemCount", { count: problemBadgeCount })}</span>
                    <span aria-hidden data-receipt-count-value>{problemBadgeCount}</span>
                  </Badge>
                ) : null}
              </span>
              {/* The notice's own actions, quiet icon-buttons (design §3.5:
                  failed = danger + retry icon-button). A button carries its own
                  activation, so a click here never toggles the disclosure; the
                  explicit preventDefault says so in DOMs that toggle on bubble. */}
              {notice && (noticeRetryable || onDismiss) ? (
                <span className="-mr-1 flex shrink-0 items-center sm:mr-0" data-delivery-notice-actions>
                  {noticeRetryable ? (
                    <button
                      type="button"
                      data-delivery-notice-retry
                      aria-label={t("runtime.receipt.retry")}
                      title={t("runtime.receipt.retry")}
                      disabled={actionsDisabled}
                      className={`${noticeActionClass} hover:text-accent`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        retryFailed(notice.current);
                      }}
                    >
                      <RotateCcw className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                  {/* Dismissing the notice clears its whole group: every settled
                      attempt it counted (issue #264 rule 3 — a still-moving
                      attempt is never hidden). */}
                  {onDismiss ? (
                    <button
                      type="button"
                      data-delivery-notice-dismiss
                      aria-label={t("runtime.receipt.dismiss")}
                      title={t("runtime.receipt.dismiss")}
                      className={`${noticeActionClass} hover:text-danger`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDismiss(notice.dismissIds);
                      }}
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </summary>
            <div
              className="max-h-36 space-y-1 overflow-y-auto border-t border-border/70 p-1.5"
              data-runtime-receipt-details
            >
              {/* What expanding reveals (issue #1362): the full sentence and the
                  remediation after it, once for the run — never once per
                  attempt. Wraps rather than truncates: this is where the
                  operator reads what to do. */}
              {notice && noticeFailure?.detail ? (
                <div className="rounded-control bg-card/70 px-2 py-1 text-secondary" data-delivery-notice-detail>
                  <p className="whitespace-pre-wrap break-words" data-delivery-notice-sentence>
                    {noticeFailure.detail.sentence}
                  </p>
                  {noticeFailure.detail.remediation ? (
                    <p className="whitespace-pre-wrap break-words text-muted" data-delivery-notice-remediation>
                      {noticeFailure.detail.remediation}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {attemptGroups.map((group) => {
                const receipt = group.current;
                const history = supersededStatusLabels(group.attempts);
                const failed = receipt.status === "failed";
                const pending = !receiptIsTerminal(receipt.status);
                const wait = waitFor(group);
                const uncertain = wait?.phase === "uncertain";
                const serverBacked = !receipt.operationId.startsWith(UNCONFIRMED_RECEIPT_PREFIX);
                const exitable = uncertain && serverBacked;
                const discardable = serverBacked
                  && receipt.reason !== "delivery-discarded"
                  && (exitable || (failed && receipt.resend === "verify-first"));
                const retryingBusy = pending
                  && !uncertain
                  && typeof receipt.reason === "string"
                  && RECOVERABLE_BUSY_RETRY_REASONS.has(receipt.reason);
                return (
                  <div
                    key={receipt.operationId}
                    className="flex min-w-0 flex-col items-end gap-0.5 rounded-control bg-card/70 px-2 py-1"
                    {...(pending ? { "data-optimistic-message": "true" } : {})}
                  >
                    {/* The action chip (state badge + Retry/Edit) wraps under
                        the message on narrow screens instead of squeezing the
                        text into a sliver — the payload must stay readable at
                        390px in exactly the failed state that needs it. */}
                    <div className="flex w-full min-w-0 flex-wrap items-start justify-end gap-1.5">
                      <span
                        className="min-w-[8rem] flex-1 whitespace-pre-wrap break-words text-right text-secondary"
                        data-receipt-message
                      >
                        {receipt.text}
                      </span>
                      {group.attempts.length > 1 ? (
                        <Badge
                          tone="neutral"
                          data-receipt-attempt-count
                          aria-label={t("runtime.receipt.attemptCount", { count: group.attempts.length })}
                          title={t("runtime.receipt.attemptCount", { count: group.attempts.length })}
                        >
                          <span aria-hidden>×{group.attempts.length}</span>
                          <span className="sr-only">{t("runtime.receipt.attemptCount", { count: group.attempts.length })}</span>
                        </Badge>
                      ) : null}
                      <ReceiptChip
                        receipt={receipt}
                        wait={wait}
                        actionsDisabled={actionsDisabled}
                        onRetry={failed
                          ? () => retryFailed(receipt)
                          : exitable
                            ? () => onRetry(receipt, "uncertain")
                            : undefined}
                        onEdit={editable(receipt) ? () => onEdit(receipt) : undefined}
                        onDiscard={discardable && onDiscard ? () => onDiscard(receipt) : undefined}
                      />
                      {/* A settled problem is dismissible (issue #264 rule 3):
                          the dismissal records every settled attempt of the
                          row and persists, while a still-moving attempt in the
                          group keeps rendering — dismissal never hides live
                          delivery truth. */}
                      {onDismiss && deliveryProblem(receipt.status) ? (
                        <button
                          type="button"
                          aria-label={t("runtime.receipt.dismiss")}
                          title={t("runtime.receipt.dismiss")}
                          data-receipt-dismiss
                          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0 sm:px-0.5"
                          onClick={() => onDismiss(group.attempts
                            .filter((attempt) => receiptIsTerminal(attempt.status))
                            .map((attempt) => attempt.operationId))}
                        >
                          <X className="h-3 w-3" aria-hidden />
                        </button>
                      ) : null}
                      {receipt.status === "pending" && !uncertain ? (
                        <span
                          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none"
                          aria-hidden
                        />
                      ) : null}
                      {retryingBusy ? (
                        <span
                          className="min-w-0 max-w-[52%] truncate text-caption text-muted"
                          data-runtime-receipt-busy
                          title={t("runtime.receipt.busyRetry")}
                        >
                          {t("runtime.receipt.busyRetry")}
                        </span>
                      ) : null}
                    </div>
                    {/* Why it is not coming, in one sentence (issue #1213).
                        Wraps rather than truncates: this is where the operator
                        learns why the message was parked before choosing its
                        same-identity retry or terminal discard. */}
                    {uncertain ? (
                      <span
                        className="min-w-0 max-w-full text-right text-caption text-muted"
                        data-receipt-uncertain-why
                      >
                        {deliveryUncertainWhy(t, wait!)}
                      </span>
                    ) : null}
                    {history.length ? (
                      <span
                        className="min-w-0 max-w-full truncate text-caption text-muted"
                        data-receipt-history
                        title={history.join(" · ")}
                      >
                        {history.join(" · ")}
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {/* Textless message failures (no echo to group by): one history
                  row per consecutive cause, counted, with the same chip and
                  dismissal the standalone pills used to carry. */}
              {textlessRows.map((bucket) => {
                const receipt = bucket[0]!;
                return (
                  <div
                    key={receipt.operationId}
                    className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 rounded-control bg-card/70 px-2 py-1"
                    data-receipt-standalone-row
                  >
                    {bucket.length > 1 ? (
                      <Badge
                        tone="neutral"
                        data-receipt-attempt-count
                        aria-label={t("runtime.receipt.attemptCount", { count: bucket.length })}
                        title={t("runtime.receipt.attemptCount", { count: bucket.length })}
                      >
                        <span aria-hidden>×{bucket.length}</span>
                        <span className="sr-only">{t("runtime.receipt.attemptCount", { count: bucket.length })}</span>
                      </Badge>
                    ) : null}
                    <ReceiptChip
                      receipt={receipt}
                      actionsDisabled={actionsDisabled}
                      onRetry={receipt.status === "failed" ? () => retryFailed(receipt) : undefined}
                    />
                    {onDismiss ? (
                      <button
                        type="button"
                        aria-label={t("runtime.receipt.dismiss")}
                        title={t("runtime.receipt.dismiss")}
                        data-receipt-dismiss
                        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0 sm:px-0.5"
                        onClick={() => onDismiss(bucket.map((attempt) => attempt.operationId))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </details>
          <span
            id={statusId}
            className="sr-only"
            role="status"
            aria-live="polite"
            data-runtime-receipt-status
          >
            {t("runtime.receipt.statusSummary", {
              pending: t("runtime.receipt.statusPending", { count: pendingReceipts.length }),
              problems: t("runtime.receipt.statusProblems", { count: problemReceipts.length }),
            })}
            {` ${[
              ...attemptGroups.map((group) => {
                const wait = waitFor(group);
                const current = (wait && deliveryWaitText(t, wait, group.current.queuePosition))
                  ?? runtimeReceiptStatusText(t, group.current);
                return [current, ...supersededStatusLabels(group.attempts)].join(" · ");
              }),
              ...textlessRows.map((bucket) => (bucket.length > 1
                ? `${runtimeReceiptStatusText(t, bucket[0]!)} ×${bucket.length}`
                : runtimeReceiptStatusText(t, bucket[0]!))),
            ].join(". ")}.`}
            {busyRetry ? ` ${t("runtime.receipt.busyRetry")}` : null}
          </span>
        </>
      ) : null}
      {standaloneChips.map((receipt) => {
        const failed = receipt.status === "failed";
        return (
          <span key={receipt.operationId} className="inline-flex items-center gap-1">
            <ReceiptChip
              receipt={receipt}
              actionsDisabled={actionsDisabled}
              onRetry={isMessage(receipt) && failed ? () => retryFailed(receipt) : undefined}
              onEdit={editable(receipt) ? () => onEdit(receipt) : undefined}
            />
            {onDismiss && deliveryProblem(receipt.status) ? (
              <button
                type="button"
                aria-label={t("runtime.receipt.dismiss")}
                title={t("runtime.receipt.dismiss")}
                data-receipt-dismiss
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0 sm:px-0.5"
                onClick={() => onDismiss([receipt.operationId])}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

/**
 * Exact draft clearing after an accepted delivery. Removes precisely the
 * delivered text from the front of the draft: text typed while the send was in
 * flight survives, and a stale delivery for text the draft no longer holds
 * leaves it untouched.
 */
export function draftAfterDelivery(draft: string, delivered: string): string {
  const deliveredTrim = delivered.trim();
  if (!deliveredTrim) return draft;
  const start = draft.trimStart();
  if (start.startsWith(deliveredTrim)) return start.slice(deliveredTrim.length).trimStart();
  return draft;
}

/** One submitted draft generation whose fate is not yet settled: recorded when
    the attempt leaves for the wire, so a durable admission receipt for its
    idempotency key — however late it arrives, and on whichever plane — clears
    exactly this generation and nothing typed or attached afterwards. */
export interface PendingDelivery {
  key: string;
  /** The exact draft text this attempt carried — what admission clears. */
  text: string;
  /** Immutable snapshot of the attachments this attempt carried: a late
      admission removes exactly these from the composer, so images attached
      after the send stay put. */
  images: readonly PendingImage[];
  /** The non-image attachments this attempt carried (#1224). Memory-only:
      a document's bytes are far too large for synchronous browser storage, so a
      generation holding one persists as `payloadComplete: false` and is fenced
      from replay after a refresh rather than replayed without its files. */
  files?: readonly PendingFile[];
  /** Runtime selection frozen with the first request under this key. */
  runtime?: RuntimeProfile;
  /** The Viewer card selected when this attempt was dispatched (#844). Frozen
      with the generation so a replay re-sends the SAME reference: an idempotent
      retry must not silently re-point the operator's instruction at whatever
      happens to be selected now. */
  selectedContext?: SelectedContextRef;
  /** Records that runtime absence was captured deliberately. */
  runtimeCaptured?: true;
  /** False when a legacy/quota-limited record lacks bytes needed for an exact
      replay. Such a record remains observable for late receipt settlement and
      never lends its key to a new payload after remount. */
  payloadComplete?: false;
  /** Current runtime operation that owns this logical generation. A manual
      retry rotates the operation while preserving the generation. */
  operationId?: string;
  /** The immediate request crossed its deadline and snapshot reconciliation
      still owns this generation. Persisted so a refresh resumes observation. */
  reconciling?: true;
}

const PENDING_DELIVERY_LIMIT = 8;
const SETTLED_SEND_KEY_LIMIT = 32;

/** Text-only projection persisted per conversation so an unsettled generation
    survives a composer remount or a full page refresh (the attachment snapshot
    is memory-only — previews don't survive a refresh either). */
const pendingSendKey = (id: string) => "llvPendingSend:" + id;
const draftImagesKey = (id: string) => "llvDraftImages:" + id;
/** Names only, never bytes (#1224): a staged document is far too big for
    synchronous session storage, so what survives a card switch or a phone tab
    restore is enough to say WHICH file has to be attached again. */
const draftFilesKey = (id: string) => "llvDraftFiles:" + id;

interface PersistedPendingDelivery {
  key?: unknown;
  text?: unknown;
  images?: unknown;
  runtime?: unknown;
  runtimeCaptured?: unknown;
  reconciling?: unknown;
  payloadComplete?: unknown;
  operationId?: unknown;
}

function persistedRuntime(value: unknown): RuntimeProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const runtime: RuntimeProfile = {};
  if (typeof raw.model === "string") runtime.model = raw.model;
  if (typeof raw.effort === "string") runtime.effort = raw.effort;
  if (typeof raw.fast === "boolean") runtime.fast = raw.fast;
  return Object.keys(runtime).length ? runtime : undefined;
}

function persistedImages(value: unknown): PendingImage[] | null {
  if (!Array.isArray(value)) return null;
  const images: PendingImage[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.base64 !== "string" || typeof raw.mime !== "string") return null;
    images.push({
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      base64: raw.base64,
      mime: raw.mime,
      preview: `data:${raw.mime};base64,${raw.base64}`,
    });
  }
  return images;
}

function persistedFiles(value: unknown): RestoredFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: RestoredFile[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name) return null;
    files.push({
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      name: raw.name,
      ...(typeof raw.mime === "string" ? { mime: raw.mime } : {}),
    });
  }
  return files;
}

function readDraftFiles(id: string): RestoredFile[] {
  try {
    const raw = sessionStorage.getItem(draftFilesKey(id));
    return (raw === null ? null : persistedFiles(JSON.parse(raw))) ?? [];
  } catch {
    return [];
  }
}

/** Persists the NAMES of every staged non-image slot, whatever its status: a
    slot that came back un-restored is still a file the operator has to attach
    again, so its marker has to survive the next switch too. */
function writeDraftFiles(id: string, slots: readonly PendingAttachment[]): void {
  try {
    const files = slots
      .filter((slot) => slot.kind === "file")
      .map((slot) => ({ id: slot.id, name: slot.name, mime: slot.mime }));
    if (!files.length) sessionStorage.removeItem(draftFilesKey(id));
    else sessionStorage.setItem(draftFilesKey(id), JSON.stringify(files));
  } catch { /* The visible in-memory tray remains authoritative. */ }
}

function readDraftImages(id: string): PendingImage[] | null {
  try {
    const raw = sessionStorage.getItem(draftImagesKey(id));
    return raw === null ? null : persistedImages(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeDraftImages(id: string, images: readonly PendingImage[], preserveEmpty: boolean): void {
  try {
    if (!images.length && !preserveEmpty) {
      sessionStorage.removeItem(draftImagesKey(id));
      return;
    }
    sessionStorage.setItem(draftImagesKey(id), JSON.stringify(images.map(({ id: imageId, base64, mime }) => ({
      ...(imageId ? { id: imageId } : {}),
      base64,
      mime,
    }))));
  } catch { /* The visible in-memory tray remains authoritative. */ }
}

export function readPendingDeliveries(id: string): PendingDelivery[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(pendingSendKey(id)) ?? "[]") as PersistedPendingDelivery[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is PersistedPendingDelivery & { key: string; text: string } =>
        Boolean(entry) && typeof entry.key === "string" && typeof entry.text === "string")
      .slice(0, PENDING_DELIVERY_LIMIT)
      .map((entry) => {
        const images = persistedImages(entry.images);
        const payloadComplete = images !== null && entry.payloadComplete !== false;
        const runtime = persistedRuntime(entry.runtime);
        return {
          key: entry.key,
          text: entry.text,
          images: images ?? [],
          ...(runtime ? { runtime } : {}),
          ...(entry.runtimeCaptured === true ? { runtimeCaptured: true as const } : {}),
          ...(payloadComplete ? {} : { payloadComplete: false as const }),
          ...(typeof entry.operationId === "string" ? { operationId: entry.operationId } : {}),
          ...(entry.reconciling === true ? { reconciling: true as const } : {}),
        };
      });
  } catch {
    return [];
  }
}

export function writePendingDeliveries(id: string, pending: readonly PendingDelivery[]): void {
  try {
    if (pending.length) {
      sessionStorage.setItem(pendingSendKey(id), JSON.stringify(pending.map(({ key, text, images, files, runtime, runtimeCaptured, reconciling, payloadComplete, operationId }) => ({
        key,
        text,
        images: images.map(({ id: imageId, base64, mime }) => ({
          ...(imageId ? { id: imageId } : {}),
          base64,
          mime,
        })),
        ...(runtime ? { runtime } : {}),
        ...(runtimeCaptured ? { runtimeCaptured: true } : {}),
        ...(reconciling ? { reconciling: true } : {}),
        /* A generation whose files live only in memory is observable for late
           settlement but never lends its key to a replay (#1224). */
        ...(payloadComplete === false || files?.length ? { payloadComplete: false } : {}),
        ...(operationId ? { operationId } : {}),
      }))));
    } else {
      sessionStorage.removeItem(pendingSendKey(id));
    }
  } catch {
    /* Large image generations may exceed synchronous browser storage. Retain
       settlement metadata and explicitly fence the key from payload replay;
       the in-memory owner still holds all bytes until this mount ends. */
    try {
      sessionStorage.setItem(pendingSendKey(id), JSON.stringify(pending.map(({ key, text, runtime, runtimeCaptured, reconciling, operationId }) => ({
        key,
        text,
        ...(runtime ? { runtime } : {}),
        ...(runtimeCaptured ? { runtimeCaptured: true } : {}),
        ...(reconciling ? { reconciling: true } : {}),
        ...(operationId ? { operationId } : {}),
        payloadComplete: false,
      }))));
    } catch { /* opaque origin: in-memory settlement remains authoritative */ }
  }
}

function releasePendingReconciliation(entry: PendingDelivery): PendingDelivery {
  const released = { ...entry };
  delete released.reconciling;
  return released;
}

export function rebindPendingOperations(
  pending: readonly PendingDelivery[],
  receipts: readonly RuntimeReceipt[],
): PendingDelivery[] {
  return pending.map((entry) => {
    const owner = receipts.find((receipt) =>
      Boolean(entry.operationId) && retryParentOperationId(receipt) === entry.operationId)
      ?? receipts.find((receipt) => receipt.operationId === entry.operationId)
      ?? receipts.find((receipt) => receipt.idempotencyKey === entry.key);
    return owner && owner.operationId !== entry.operationId
      ? { ...entry, operationId: owner.operationId }
      : entry;
  });
}

/**
 * Settle pending generations against the current receipt set: a durably
 * admitted receipt (queued or beyond — {@link receiptIsAdmitted}) for a pending
 * key yields that generation for clearing and drops the entry, so repeated
 * receipts for one key clear at most once. For a pre-delivery admission the
 * generation's own text is what leaves the draft (the receipt's echo may be a
 * bounded summary, and clearing off a truncated echo would strand a tail); a
 * `delivered` receipt's text wins, since it is the server's record of what
 * actually reached the agent on a replayed key. Timeout (`uncertain`),
 * `pending`, failed/rejected, and unknown receipts change nothing.
 */
export function settlePendingDeliveries(
  pending: readonly PendingDelivery[],
  receipts: readonly RuntimeReceipt[],
): { settled: { entry: PendingDelivery; text: string }[]; remaining: PendingDelivery[] } {
  const admittedByKey = new Map<string, RuntimeReceipt>();
  const admittedByOperation = new Map<string, RuntimeReceipt>();
  for (const receipt of receipts) {
    if (!receiptIsAdmitted(receipt.status)) continue;
    const currentOperation = admittedByOperation.get(receipt.operationId);
    if (!currentOperation || (receipt.status === "delivered" && currentOperation.status !== "delivered")) {
      admittedByOperation.set(receipt.operationId, receipt);
    }
    const current = admittedByKey.get(receipt.idempotencyKey);
    if (!current || (receipt.status === "delivered" && current.status !== "delivered")) {
      admittedByKey.set(receipt.idempotencyKey, receipt);
    }
  }
  const settled: { entry: PendingDelivery; text: string }[] = [];
  const remaining: PendingDelivery[] = [];
  for (const entry of pending) {
    const receipt = admittedByKey.get(entry.key)
      ?? (entry.operationId ? admittedByOperation.get(entry.operationId) : undefined);
    if (!receipt) {
      remaining.push(entry);
      continue;
    }
    const deliveredText = receipt.status === "delivered" && typeof receipt.text === "string" && receipt.text
      ? receipt.text
      : entry.text;
    settled.push({ entry, text: deliveredText });
  }
  return { settled, remaining };
}

/** A synthetic, local-only receipt row for a generation whose reconciliation
    window closed without a durable admission or terminal receipt. It carries
    the original idempotency key. A later durable receipt for the same key
    supersedes it through mergeRuntimeReceipts tier two, keeping one visible row
    per message. The row records an unconfirmed state and leaves draft settlement
    to an authoritative receipt. */
const UNCONFIRMED_RECEIPT_PREFIX = "composer-unconfirmed:";
function unconfirmedReceiptOperationId(clientMessageId: string): string {
  return UNCONFIRMED_RECEIPT_PREFIX + clientMessageId;
}
function unconfirmedReceipt(clientMessageId: string, conversationId: string, text: string): RuntimeReceipt {
  return {
    operationId: unconfirmedReceiptOperationId(clientMessageId),
    idempotencyKey: clientMessageId,
    conversationId,
    kind: "send",
    status: "uncertain",
    text,
    at: new Date().toISOString(),
    revision: 0,
  };
}

/** Removes one attachment per delivered snapshot entry, so attachments added
    while the send was in flight survive. An id-bearing snapshot matches ONLY
    its intake id — if that slot is already gone, a late replayed receipt must
    settle as a no-op, never consume an identical image the user attached for
    the next message (PR #431). Only snapshots persisted by pre-id sessions
    (no id at all) settle by `base64+mime` content (issue #419). */
export function attachmentsAfterDelivery(
  current: readonly PendingImage[],
  delivered: readonly PendingImage[],
): PendingImage[] {
  const remaining = [...current];
  for (const sent of delivered) {
    const index = sent.id
      ? remaining.findIndex((image) => image.id === sent.id)
      : remaining.findIndex((image) => image.base64 === sent.base64 && image.mime === sent.mime);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/** A receipt still awaiting durable delivery (a migration hold) must never be
    pruned by the pane/spawn TTLs — its text lands on the successor, whose
    transcript is a different file, so only an explicit resolve/dismiss clears it. */
function isPendingReceipt(entry: SentEntry): boolean {
  return entry.state === "held" || entry.state === "queued" || entry.state === "recovering" || entry.state === "failed";
}

function readSent(id: string): SentEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sentKey(id)) ?? "[]") as SentEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Conversations that accept a message without a live pane: root sessions
    reopen through resume; subagents relay through their root conversation. */
function canMessageWithoutPane(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "session" || file.kind === "subagent";
  return file.root === "codex-sessions";
}

const draftKey = (id: string) => "llvDraft:" + id;
const COMPOSE_EVENT = "llv-compose-draft";

/** Links a transcript path to the identity whose sessionStorage records hold
    that conversation's composer state, so an id rotation can find them. */
const composerOwnerKey = (path: string) => "llvComposerOwner:" + path;

/** Provisional-id adoption (and late identity enrichment) rotates the card's
    identity while its transcript path stays put: the draft, the unsettled
    generations, and the delivery receipts persisted under the old identity
    must ride along, or a poll that fills in the canonical id would silently
    orphan the text the user is typing. The owner pointer written per path
    makes the move bidirectional — a flap that drops the id for a poll adopts
    the records back onto the path, the next enrichment adopts them forward.
    Moves each record once; a record already filed under the new identity
    always wins. */
export function adoptComposerState(path: string, cardId: string): void {
  try {
    const previousOwner = sessionStorage.getItem(composerOwnerKey(path));
    for (const from of [previousOwner, path]) {
      if (!from || from === cardId) continue;
      for (const keyOf of [draftKey, draftImagesKey, draftFilesKey, pendingSendKey, sentKey, dismissedReceiptsKey]) {
        const legacy = sessionStorage.getItem(keyOf(from));
        if (legacy === null) continue;
        if (sessionStorage.getItem(keyOf(cardId)) === null) sessionStorage.setItem(keyOf(cardId), legacy);
        sessionStorage.removeItem(keyOf(from));
      }
    }
    if (cardId === path) sessionStorage.removeItem(composerOwnerKey(path));
    else sessionStorage.setItem(composerOwnerKey(path), cardId);
  } catch { /* quota/opaque-origin: in-memory state still carries the turn */ }
}

/** Focus continuity across composer remounts (issue #272). Board polls churn
    the hosting keys — a committed migration rewrites the transcript path, an
    adoption flap drops and re-adds the entry — which remounts the composer
    mid-typing and throws keyboard focus to `body`. The outgoing textarea
    records that it held focus (with the caret and scroll position); the next
    composer for the same conversation reclaims it, but only while nothing else
    took focus in between, so a poll-driven remount restores exactly what it
    destroyed and a user's click elsewhere is never overridden. Claims expire
    after {@link FOCUS_CLAIM_TTL_MS} so a card reopened much later — a real
    user navigation — never has focus grabbed for it. */
const FOCUS_CLAIM_TTL_MS = 10_000;
interface ComposerFocusClaim {
  start: number;
  end: number;
  scrollTop: number;
  at: number;
}
const composerFocusClaims = new Map<string, ComposerFocusClaim>();

function ComposerFocusContinuity({ claimKeys }: {
  /** Both identity axes of one conversation (stable id and transcript path):
      a migration keeps the id while the path rotates, an adoption keeps the
      path while the id rotates — either axis must find the claim. */
  claimKeys: readonly string[];
}) {
  /* The textarea is resolved through the DOM from this anchor, not through the
     composer's ref: React attaches/detaches refs in tree order, so a sibling's
     ref is not yet attached when this component mounts and already detached
     when its cleanup runs — but the form subtree is in the document on both
     sides of a deletion pass. */
  const anchorRef = useRef<HTMLElement>(null);
  const keys = [...new Set(claimKeys)];
  const keysSignature = keys.join("\u0000");
  useLayoutEffect(() => {
    const composerField = () => anchorRef.current?.closest("form")?.querySelector("textarea") ?? null;
    const el = composerField();
    const claim = keys.map((key) => composerFocusClaims.get(key)).find(Boolean);
    if (el && claim) {
      for (const key of keys) composerFocusClaims.delete(key);
      const active = document.activeElement;
      const focusIsOrphaned = !active || active === document.body || !active.isConnected;
      if (focusIsOrphaned && nowMs() - claim.at < FOCUS_CLAIM_TTL_MS) {
        el.focus({ preventScroll: true });
        const end = Math.min(claim.end, el.value.length);
        el.setSelectionRange(Math.min(claim.start, end), end);
        el.scrollTop = claim.scrollTop;
      }
    }
    /* The record runs in the deletion pass, while the textarea is still in the
       document — a plain re-render never reaches it, so polls that only update
       data cannot trigger any focus side effect. */
    return () => {
      const outgoing = composerField();
      if (!outgoing || document.activeElement !== outgoing) return;
      const at = nowMs();
      for (const [key, stale] of composerFocusClaims) {
        if (at - stale.at >= FOCUS_CLAIM_TTL_MS) composerFocusClaims.delete(key);
      }
      const claim: ComposerFocusClaim = {
        start: outgoing.selectionStart ?? outgoing.value.length,
        end: outgoing.selectionEnd ?? outgoing.value.length,
        scrollTop: outgoing.scrollTop,
        at,
      };
      for (const key of keys) composerFocusClaims.set(key, claim);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keys is re-derived per render; keysSignature is its value identity
  }, [keysSignature]);
  return <span ref={anchorRef} hidden aria-hidden />;
}

/**
 * Drops text into a conversation's composer from outside (the link-arrow
 * gesture): the stored draft grows and any mounted composer for that
 * conversation reloads it and takes focus, so the user types their ask right
 * where the context landed. With no composer on screen the draft simply waits
 * in sessionStorage for the next mount. `id` is the stable conversation identity
 * (falls back to path), so a draft survives an account-migration succession.
 */
export function appendComposerDraft(id: string, text: string) {
  const key = draftKey(id);
  const prev = sessionStorage.getItem(key) ?? "";
  sessionStorage.setItem(key, prev.trim() ? prev.replace(/\s*$/, "") + "\n\n" + text : text);
  window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { path: id } }));
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString(getLocale() === "uk" ? "uk-UA" : "en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });

/** The label + Badge tone for a delivery-receipt state chip, or `null` for a
    plainly delivered message (no chip). Held/queued/recovering read amber
    (pending), failed reads red (actionable). Text carries the state — never
    colour alone. Rendered through the shared {@link Badge} recipe (design §3.7). */
function receiptMeta(t: TFunction, state: DeliveryReceiptState | undefined): { label: string; tone: BadgeTone } | null {
  switch (state) {
    case "held":
      return { label: t("composer.receiptHeld"), tone: "warning" };
    case "queued":
      return { label: t("composer.receiptQueued"), tone: "warning" };
    case "recovering":
      return { label: t("composer.receiptRecovering"), tone: "warning" };
    case "failed":
      return { label: t("composer.receiptFailed"), tone: "danger" };
    default:
      return null;
  }
}

/** Wall-clock read hoisted out of the component so the React Compiler's purity
    check does not see a bare `Date.now()` in a render-scope closure. */
function nowMs(): number {
  return Date.now();
}

export function structuredComposerSession(runtimeSession: RuntimeSessionView | null): RuntimeSessionView | null {
  if (!runtimeSession?.structuredControlsEnabled || runtimeSession.legacy) return null;
  return runtimeSession.session.hostKind === "codex-app-server" || runtimeSession.session.hostKind === "claude-broker"
    ? runtimeSession
    : null;
}

export interface TmuxComposerProps {
  file: FileEntry;
  pollPaused?: boolean;
  deadHost?: boolean;
  /** Localized reason Send is inert on a non-dead surface (e.g. the host is
      still unresolved under the runtime plane — issue #241 finding 1). No POST
      is attempted while it is set, so no /api/tmux request can fire against an
      as-yet-unclassified host. */
  sendBlockedReason?: string | null;
  /** Optional surface-specific placeholder, such as the orchestrator dock's
      project-scoped prompt. Ordinary conversation cards keep their defaults. */
  placeholder?: string;
  /** This surface is the operator's conversation WINDOW, not an incidental card
      of the same conversation, so the one hoisted composer belongs here even
      while a board card for it is also on screen (the orchestrator dock, #977).
      Without it the two surfaces would be ordinary competing places and a board
      remount could take the form out from under the operator. */
  primaryPlace?: boolean;
}

/**
 * Chat-style composer pinned under the feed. A live pane gets the text typed
 * straight into its tmux pane; a finished resumable conversation boots a new
 * agent window in the current tmux session with the text as the first prompt.
 * Sent messages stay visible as a queue above the input until dismissed.
 *
 * OWNERSHIP (#691 hoist): for a conversation card this component is only a
 * dispatcher. The composer machinery — draft, dictation, attachments and their
 * object URLs, the outbox and the whole send path — must survive the card
 * unmounting mid-call, so `VoiceComposerHost` (Viewer level) renders the one
 * `TmuxComposerCore` and portals its form into the place this card publishes.
 * The card contributes a place and fresh props, never a second composer. Trees
 * with no host mounted (component tests, the demo renderer) keep the inline
 * card-scoped composer unchanged, as does every non-conversation surface.
 */
export function TmuxComposer(props: TmuxComposerProps) {
  const hostMounted = useSyncExternalStore(
    subscribeVoiceSlots,
    isVoiceComposerHostMounted,
    getServerVoiceComposerHostMounted,
  );
  const cardId = conversationIdentity(props.file);
  if (!hostMounted || !cardId.startsWith("conversation_")) return <TmuxComposerCore {...props} />;
  return <VoiceComposerCardSlot cardId={cardId} composerProps={props} primary={props.primaryPlace === true} />;
}

/** The card's half of the hoist: a place (a `display: contents` div the host
    portals the form into) and the props the composer needs, republished every
    render because `file` is a fresh snapshot each board poll. */
function VoiceComposerCardSlot({ cardId, composerProps, primary }: { cardId: string; composerProps: TmuxComposerProps; primary: boolean }) {
  const placeId = useId();
  const publishNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      return publishVoiceComposerCardNode(cardId, node, primary, placeId);
    },
    [cardId, placeId, primary],
  );
  useEffect(() => {
    publishVoiceComposerCardProps(cardId, placeId, {
      file: composerProps.file,
      pollPaused: composerProps.pollPaused ?? false,
      deadHost: composerProps.deadHost ?? false,
      sendBlockedReason: composerProps.sendBlockedReason ?? null,
      placeholder: composerProps.placeholder,
    });
  }, [cardId, composerProps.deadHost, composerProps.file, composerProps.placeholder, composerProps.pollPaused, composerProps.sendBlockedReason, placeId]);
  return <div ref={publishNode} data-testid="voice-composer-card-slot" className="contents" />;
}

/**
 * The canonical composer machinery. Rendered inline by ordinary cards, and by
 * `VoiceComposerHost` for conversation cards — where `dockNode` says where the
 * form goes: a card's published slot, or (null) a hidden Viewer-level container
 * that keeps everything mounted while no card is on screen. State never lives in
 * the portal target; moving containment moves DOM, not lifetimes.
 */
export function TmuxComposerCore({
  file,
  pollPaused = false,
  deadHost = false,
  sendBlockedReason = null,
  placeholder,
  dockNode,
}: TmuxComposerProps & {
  /** Absent: render the form inline (the card owns the composer, as ever).
      A node: portal the form there. Null: keep the form mounted but hidden. */
  dockNode?: HTMLElement | null;
}) {
  const { t } = useLocale();
  const runtimeDependencies = tmuxComposerRuntimeDependencies();
  const admissionTiming = composerAdmissionTiming();
  /* Draft text and delivery receipts key on the stable conversation identity,
     not the transcript path: a committed account migration gives the card a new
     path under the target account, and the draft/held receipts must ride along
     (falls back to path pre-migration). */
  const cardId = conversationIdentity(file);
  // The structured session Stop/Send route through — the conversation's own
  // structured host, or the ROOT's for a structured-root subagent (finding 1),
  // so a claude-broker root's child sends via /api/runtime/send, never /api/tmux.
  // `caps` also carries the Send capability: a *hidden* Send (a gated
  // scanner-shaped subagent, a shell task) means this surface exposes no message
  // path at all, so the whole composer stands down below (finding 2).
  const { caps, structuredSession } = runtimeDependencies.useAgentCapabilities(file);
  const voiceEnabled = cardId.startsWith("conversation_")
    && structuredSession?.session.hostKind === "codex-app-server"
    && structuredSession.session.host === "hosted";
  const voiceWorkerTurn = structuredSession?.session.liveTurn;
  const voice = useCodexRealtime(
    cardId,
    voiceEnabled,
    voiceWorkerTurn?.turnId ?? "",
    voiceWorkerTurn?.text ?? "",
    Boolean(voiceWorkerTurn?.turnId && structuredSession?.session.activeTurnId === voiceWorkerTurn.turnId),
    structuredSession?.session.voiceDeliveries ?? [],
  );
  /* #691, ownership inverted: the voice panel is rendered by `VoicePipHost`, the
     Viewer-level owner that survives this card unmounting. Docked, the panel lands
     in the slot node this card publishes; floating, the HOST publishes a composer
     slot inside the PiP window and this card portals its one `ComposerBar` there.
     Containment is the only thing that changes — same panel, same composer. */
  const pipComposerSlot = useSyncExternalStore(
    subscribeVoiceSlots,
    () => (voiceEnabled ? getVoiceComposerSlot(cardId) : null),
    getServerVoiceSlot,
  );
  const publishDockSlot = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return undefined;
      return publishVoiceDockSlot(cardId, node);
    },
    [cardId],
  );
  const structuredImageCapability = structuredSession?.session.capabilities?.imageInput;
  const structuredImageControl = caps.controls.images;
  const structuredImagesDisabled = Boolean(structuredSession && structuredImageControl.state !== "enabled");
  const structuredImagesReason = structuredImagesDisabled
    ? t(structuredImageControl.state === "disabled"
      ? structuredImageControl.reason
      : "composer.structuredImagesProtocol")
    : undefined;
  /* While a card is switching accounts its next send is held for the successor
     (Sol delivery fence): the composer shows the held affordance instead of
     pretending the text reached the live predecessor pane. Every migration
     read below goes through `activeCardMigration`, which collapses a hold
     annotation whose target the card ALREADY runs under — a completed switch's
     leftover must neither promise a hold nor keep one held. */
  const liveMigration = activeCardMigration(file.migration, accountIdFromPath(file.path));
  const holdsSends = migrationHoldsSends(cardMigrationState(liveMigration));
  const holdsDelivery = migrationHoldsDelivery(cardMigrationState(liveMigration));
  /* An off-screen or far-zoom pane skips the pane-resolution poll; the last
     known target keeps the composer usable the moment it comes back. */
  const target = useHostTarget(file.pid, canMessageWithoutPane(file) ? file.path : undefined, !pollPaused);
  /* Column reshuffles can remount the composer mid-typing; the draft lives in
     sessionStorage so the text survives the remount. */
  const composer = useComposer({
    initialText: () => {
      if (typeof window === "undefined") return "";
      /* A remount that crossed an identity adoption (provisional id →
         canonical id) must find the draft persisted under the old key. */
      adoptComposerState(file.path, cardId);
      adoptOutbox(file.path, cardId);
      return sessionStorage.getItem(draftKey(cardId)) ?? "";
    },
    persistText: (value) => {
      if (value) sessionStorage.setItem(draftKey(cardId), value);
      else sessionStorage.removeItem(draftKey(cardId));
    },
    submit: (overrideText) => queueSubmit(overrideText),
    imageCapability: structuredSession ? structuredImageCapability ?? null : null,
    /* #1224: this composer delivers a general file by writing it to the
       conversation's inbox and naming its path, so it takes any file. */
    acceptFiles: true,
    /* Queue-first (issue #561): a submitted message lives in the durable
       outbox, so the field never locks behind an in-flight delivery. */
    holdInputWhileBusy: false,
  });
  /* Pulls the bridge inbox once, at the start of a turn, and only for the voice
     conversation. Returns "" for every other card and whenever nothing is pending. */
  const drainBridgeTurnStart = useBridgeTurnStartDrain(voiceEnabled, { conversationId: cardId });
  const { text, textRef, setText, setTextState, inputRef, setStatus, busy, setBusy, voiceSending, attachments } = composer;
  const attachmentDraftHydrated = useRef(false);
  const isMobile = useIsMobile();
  /* The runtime's own connection, for the phone's Queue slot (§4.2): while the
     bus is off this reads inert, so nothing changes on the landing-disabled
     path. */
  const runtimeBus = useRuntimeBusState();
  const runtimeOffline = runtimeBus.enabled && runtimeBus.connection === "offline";
  /* One in-flight slot action at a time — Stop or Respawn. */
  const [slotBusy, setSlotBusy] = useState(false);
  /* Interrupt / compact / attach-terminal / mode chip moved into the unified
     control strip (issue #241) — the composer keeps only the message surface
     (text, images, mic, send) and its delivery receipts. */
  const [sent, setSent] = useState<SentEntry[]>([]);
  /* The queue-first outbox (issue #561): submitted drafts live here from the
     moment they are submitted, so the feed can render them as optimistic user
     bubbles while the composer clears and stays typable. */
  const outbox = useOutbox(cardId);
  /* Exact transcript user echoes are the authoritative retirement signal for
     temporary delivered rows. The feed publishes them reactively because the
     transcript write commonly precedes the final delivered receipt. */
  const transcriptEchoCounts = useTranscriptEchoes(cardId);
  /* Attachment bytes for queued submissions. Memory-only: a refresh restores
     the queue's text but not its images, and the restore path marks any
     image-bearing entry as needing re-attachment rather than silently sending
     a text-only message. */
  const outboxImages = useRef<Map<string, PendingImage[]>>(new Map());
  /* The same, for non-image attachments (#1224). Memory-only for the same
     reason, and cleared with the entry the moment it delivers. */
  const outboxFiles = useRef<Map<string, PendingFile[]>>(new Map());
  /* Idempotency keys the outbox owns. Their settlement clears the QUEUE, never
     the editable draft — that draft was already cleared at submit time and
     anything in it now belongs to the next message. */
  const outboxKeys = useRef<Set<string>>(new Set());
  const [immediateRuntimeReceipts, setImmediateRuntimeReceipts] = useState<RuntimeReceipt[]>([]);
  const [reconcilingSend, setReconcilingSend] = useState(() =>
    typeof window !== "undefined" && readPendingDeliveries(cardId).some((entry) => entry.reconciling));
  const [replayGenerationAvailable, setReplayGenerationAvailable] = useState(() =>
    typeof window !== "undefined" && readPendingDeliveries(cardId).some((entry) => entry.payloadComplete !== false));
  /* Operation ids whose settled problem rows the user dismissed (issue #264
     rule 3). Persisted per conversation identity and adopted across id
     rotations alongside the draft. */
  const [dismissedReceiptIds, setDismissedReceiptIds] = useState<string[]>([]);
  /* One idempotency key per message draft: reused verbatim on a retry (never a
     second send) and re-minted after a successful delivery. Passed to the send
     so the runtime host can round-trip it once the structured plane is on; the
     legacy /api/tmux route ignores the extra field. */
  const idempotencyKey = useRef<string>(mintIdempotencyKey());
  /* Unsettled submitted generations: recorded when an attempt leaves for the
     wire, settled by the first durable admission receipt for the key on any
     plane (immediate response, receipt stream, refresh snapshot). Persisted
     text-only per conversation so a remount or refresh cannot orphan an
     accepted message inside the composer. */
  const pendingDeliveries = useRef<PendingDelivery[]>([]);
  /* Generations that already settled (draft cleared exactly once). A stale
     timeout settling after a faster durable admission, or a replayed receipt
     for a consumed key, must neither report a false failure, re-arm a pending
     entry, nor clear text the user typed afterwards. Bounded, newest last. */
  const settledSendKeys = useRef<Set<string>>(new Set());
  /* #691 §4 — a drained bridge batch whose turn has not been durably admitted yet.
     Keyed by the delivery key rather than captured in a closure, because a structured
     send's admission can arrive later on the receipt stream, when that closure is
     gone: the token is a value, so it survives the wait. Committed exactly once —
     the entry is deleted before the request goes out, so a receipt arriving twice
     acknowledges once. */
  /* Parked in a module store rather than a ref: a component ref dies with the card,
     and the admission that settles a batch can arrive after the operator has scrolled
     it away. Removed only once the server accepts, so a failed POST retries. */
  const commitBridgeFor = (deliveryKey: string) => {
    const ackToken = bridgeAcknowledgementFor(deliveryKey);
    if (!ackToken) return;
    void commitBridgeTurn(ackToken)
      .then(() => forgetBridgeAcknowledgement(deliveryKey))
      .catch(() => {
        /* The cursor did not move; the token stays parked for the next receipt. */
      });
  };
  const commitBridgeForRef = useRef(commitBridgeFor);
  useEffect(() => { commitBridgeForRef.current = commitBridgeFor; });
  /* Per-idempotency-key snapshot of the runtime settings a structured send
     carries (issue #390 §10): a same-key replay must re-send *identical*
     settings — a pill selection made between attempts changes only the NEXT
     message, and a drifted payload would 409 the idempotent replay. Bounded,
     newest last. */
  const runtimeSendSnapshots = useRef<Map<string, RuntimeProfile | undefined>>(new Map());
  /* Durable receipts for this session from the runtime bus (empty while the bus
     is disabled or the session is legacy/unhosted). */
  const runtimeReceipts = runtimeDependencies.useRuntimeReceiptsForArtifact(file.path, cardId);
  const displayedRuntimeReceipts = mergeRuntimeReceipts(runtimeReceipts, immediateRuntimeReceipts);
  /* #691 §4 — THE RECEIPT-STREAM CONSUMER for parked bridge batches.
     A structured send can answer `pending` and settle minutes later on this stream,
     by which time the closure that drained the batch is gone. Watching the receipts
     is the only way that admission ever reaches the cursor; without it a batch stays
     parked and its reports repeat on the next turn. */
  useEffect(() => {
    for (const receipt of displayedRuntimeReceipts) {
      if (receiptIsAdmitted(receipt.status)) commitBridgeForRef.current(receipt.idempotencyKey);
    }
  }, [displayedRuntimeReceipts]);
  const assistantTurnReceipt = messageReceiptForAssistantTurn(
    displayedRuntimeReceipts,
    structuredSession?.session.liveTurn?.turnId,
  );
  const assistantTurnMessageKey = assistantTurnReceipt?.idempotencyKey;
  /* A live assistant delta proves the matching message reached its turn even
     while the receipt stream still projects `delivering`. Persist that causal
     settlement so the optimistic bubble stays retired after the delta folds
     into the transcript. */
  useEffect(() => {
    if (!assistantTurnMessageKey) return;
    markOutboxResponded(cardId, assistantTurnMessageKey, nowMs());
  }, [cardId, assistantTurnMessageKey]);
  const displayedRuntimeReceiptsRef = useRef(displayedRuntimeReceipts);
  useLayoutEffect(() => {
    displayedRuntimeReceiptsRef.current = displayedRuntimeReceipts;
  }, [displayedRuntimeReceipts]);
  const receiptReconciliations = useRef<Map<string, AbortController>>(new Map());
  const legacyResponseEpoch = useRef<{ cardId: string; active: boolean }>({ cardId, active: true });
  useLayoutEffect(() => {
    const epoch = { cardId, active: true };
    legacyResponseEpoch.current = epoch;
    return () => {
      epoch.active = false;
    };
  }, [cardId]);
  const dismissedReceipts = new Set(dismissedReceiptIds);
  const dismissReceipts = (operationIds: string[]) => {
    if (!operationIds.length) return;
    const next = withDismissedReceipts(dismissedReceiptIds, operationIds);
    setDismissedReceiptIds(next);
    writeDismissedReceipts(cardId, next);
  };
  const respondedMessageKeys = new Set(
    outbox
      .filter((entry) => entry.responseStartedAt !== undefined)
      .map((entry) => entry.id),
  );
  if (assistantTurnMessageKey) respondedMessageKeys.add(assistantTurnMessageKey);
  /* Successful sends whose bubble has not landed in the visible feed yet:
     quiet one-line echoes derived from the receipt stream (issue #264 rule 2).
     They self-clear the moment the transcript grows — the bubble in the feed
     is the real confirmation — so success never accumulates chrome. */
  const echoedReceipts = deliveryEchoes(
    displayedRuntimeReceipts,
    file.mtime * 1000,
    dismissedReceipts,
    nowMs(),
    transcriptEchoCounts,
    respondedMessageKeys,
  );

  const persistPendingDeliveries = (next: PendingDelivery[]) => {
    pendingDeliveries.current = next;
    setReplayGenerationAvailable(next.some((entry) => entry.payloadComplete !== false));
    writePendingDeliveries(cardId, next);
  };

  const markSettled = (key: string) => {
    const keys = settledSendKeys.current;
    keys.delete(key);
    keys.add(key);
    while (keys.size > SETTLED_SEND_KEY_LIMIT) {
      const oldest = keys.values().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
    }
  };

  const finishReceiptReconciliation = (clientMessageId: string, receipt: RuntimeReceipt) => {
    const controller = receiptReconciliations.current.get(clientMessageId);
    if (!controller) return;
    controller.abort();
    receiptReconciliations.current.delete(clientMessageId);
    setStatus(null);
    if (receiptIsTerminal(receipt.status) && !receiptIsAdmitted(receipt.status)) {
      persistPendingDeliveries(pendingDeliveries.current.map((entry) =>
        entry.key === clientMessageId
          ? releasePendingReconciliation(entry)
          : entry));
      if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
    }
    setReconcilingSend(receiptReconciliations.current.size > 0);
  };

  /* The local reconciliation window closed without a durable admission or
     terminal receipt. Release the composer for an explicit same-key retry.
     Preserve the generation, its idempotency key, and its attachments. The
     durable receipt stream continues observing: a late admission clears the
     draft through settlePendingDeliveries, and a terminal failure surfaces
     Retry. This path performs no automatic actuation. */
  const releaseReconciliationToRetry = (clientMessageId: string) => {
    receiptReconciliations.current.delete(clientMessageId);
    /* Drop the reconciling marker so a remount exposes a recoverable retry.
       Keep the generation so a late receipt can settle it and the key remains
       replayable. */
    persistPendingDeliveries(pendingDeliveries.current.map((entry) =>
      entry.key === clientMessageId
        ? releasePendingReconciliation(entry)
        : entry));
    const entry = pendingDeliveries.current.find((candidate) => candidate.key === clientMessageId);
    if (!entry) return;
    /* A quota-limited remount lacks bytes for a safe replay. Keep the composer
       fenced while the durable receipt stream determines the original fate. */
    setReconcilingSend(receiptReconciliations.current.size > 0 || entry.payloadComplete === false);
    setStatus({ kind: "err", text: t("composer.deliveryUnconfirmed") });
    if (outboxKeys.current.has(clientMessageId)) {
      updateOutbox(cardId, clientMessageId, { state: "failed", settledAt: nowMs(), error: t("composer.deliveryUnconfirmed") });
    }
    setImmediateRuntimeReceipts((current) => [
      unconfirmedReceipt(clientMessageId, cardId, entry.text),
      ...current.filter((candidate) =>
        candidate.idempotencyKey !== clientMessageId
        && candidate.operationId !== unconfirmedReceiptOperationId(clientMessageId)),
    ].slice(0, 8));
  };

  const startReceiptReconciliation = (
    clientMessageId: string,
    lateReceipt?: Promise<RuntimeReceipt | null>,
  ) => {
    if (receiptReconciliations.current.has(clientMessageId)) return;
    const controller = new AbortController();
    receiptReconciliations.current.set(clientMessageId, controller);
    setReconcilingSend(true);
    void reconcileComposerReceipt({
      read: () => displayedRuntimeReceiptsRef.current.find((receipt) =>
        receipt.idempotencyKey === clientMessageId
        && (receiptIsAdmitted(receipt.status) || receiptIsTerminal(receipt.status))) ?? null,
      refresh: runtimeDependencies.refreshRuntime,
      late: lateReceipt,
      timeoutMs: admissionTiming.receiptReconciliationMs,
      pollIntervalMs: admissionTiming.receiptPollIntervalMs,
      signal: controller.signal,
    }).then((receipt) => {
      /* An admitted or terminal receipt aborts through
         finishReceiptReconciliation. A remount also aborts this owner. Both
         paths already own settlement, so this resolution stays silent. */
      if (controller.signal.aborted) return;
      if (receipt === null) {
        releaseReconciliationToRetry(clientMessageId);
        return;
      }
      setImmediateRuntimeReceipts((current) => [
        receipt,
        ...current.filter((candidate) => candidate.operationId !== receipt.operationId),
      ].slice(0, 8));
    });
  };

  useEffect(() => () => {
    for (const controller of receiptReconciliations.current.values()) controller.abort();
    receiptReconciliations.current.clear();
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    /* Identity enrichment without a remount (a poll fills in the conversation
       id while this instance stays mounted): move the persisted records onto
       the new key before re-reading them. */
    adoptComposerState(file.path, cardId);
    adoptOutbox(file.path, cardId);
    setSent(readSent(cardId));
    setImmediateRuntimeReceipts([]);
    setDismissedReceiptIds(readDismissedReceipts(cardId));
    for (const controller of receiptReconciliations.current.values()) controller.abort();
    receiptReconciliations.current.clear();
    const restoredPending = readPendingDeliveries(cardId);
    pendingDeliveries.current = restoredPending;
    setReplayGenerationAvailable(restoredPending.some((entry) => entry.payloadComplete !== false));
    runtimeSendSnapshots.current = new Map();
    /* Replay ownership survives independently from the editable draft: an
       unresolved generation replays through its durable OUTBOX entry, whose id
       is its idempotency key. The restored key is NEVER lent to the composer's
       next submission — a genuinely new message must mint its own key, or a
       stale unresolved generation (e.g. one stranded by a dead host) would
       hijack the new message into a replay of its old bytes and, once its
       durable record went terminal, poison the conversation with reservation
       conflicts (P1: a dead conversation could not be continued). */
    const draftNow = typeof window !== "undefined" ? sessionStorage.getItem(draftKey(cardId)) ?? "" : "";
    const resumable = restoredPending.find((entry) => entry.payloadComplete !== false);
    const draftImages = readDraftImages(cardId);
    attachmentDraftHydrated.current = false;
    const trayImages = draftImages ?? (resumable?.text === draftNow ? resumable.images : []);
    const draftFiles = readDraftFiles(cardId);
    const restoredImages = attachments.replace(trayImages.map((image) => ({ ...image })), draftFiles);
    queueMicrotask(() => { attachmentDraftHydrated.current = true; });
    if (resumable && restoredImages && resumable.runtimeCaptured) {
      runtimeSendSnapshots.current.set(resumable.key, resumable.runtime);
    }
    const reconcilingKeys = restoredPending.filter((entry) => entry.reconciling).map((entry) => entry.key);
    const hasIncompletePayload = restoredPending.some((entry) => entry.payloadComplete === false);
    setReconcilingSend(reconcilingKeys.length > 0 || hasIncompletePayload);
    if (reconcilingKeys.length || hasIncompletePayload) setStatus({ kind: "err", text: t("composer.admissionTimedOut") });
    /* A staged document cannot be persisted, only named (#1224): the restored
       slots block Send, and the status says which files have to be attached
       again — a card switch or a phone tab restore never empties them out in
       silence. Yields to the admission message, which is about a send already
       in flight. */
    else if (draftFiles.length) {
      setStatus({
        kind: "err",
        text: t("attach.refused", { names: draftFiles.map((entry) => entry.name).join(", "), reason: t("attach.notRestored") }),
      });
    }
    for (const key of reconcilingKeys) startReceiptReconciliation(key);
    settledSendKeys.current = new Set();
    /* Keyed by identity alone: a path migration under a stable id must not
       wipe the immediate receipts or the settled-key memory (`file.path` is
       only read to adopt records the old identity left behind). */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!attachmentDraftHydrated.current) return;
    writeDraftImages(cardId, attachments.images, pendingDeliveries.current.length > 0);
  }, [attachments.images, cardId]);

  /* The marker for every staged document, written from the full intake list so
     an un-restored slot keeps its name across the next switch too (#1224). */
  useEffect(() => {
    if (!attachmentDraftHydrated.current) return;
    writeDraftFiles(cardId, attachments.attachments);
  }, [attachments.attachments, cardId]);

  /* Settle submitted generations against the receipt stream: a durably
     admitted receipt (queued or beyond) for a remembered key means the server
     holds that attempt, so its exact text leaves the draft (later typing
     survives; a rewritten draft for the next turn stays untouched). Runs on
     mount too, so a refresh snapshot reconciles a persisted generation. */
  useEffect(() => {
    for (const [key] of receiptReconciliations.current) {
      const receipt = displayedRuntimeReceipts.find((candidate) =>
        candidate.idempotencyKey === key
        && (receiptIsAdmitted(candidate.status) || receiptIsTerminal(candidate.status)));
      if (receipt) finishReceiptReconciliation(key, receipt);
    }
    /* A terminal non-admitted receipt (failed/rejected) for a preserved
       generation the local window already released: mint a fresh key so the
       next message is never replay-deduped into silence. The failure itself
       surfaces Retry through the durable receipt stack. */
    for (const entry of pendingDeliveries.current) {
      if (receiptReconciliations.current.has(entry.key)) continue;
      if (idempotencyKey.current !== entry.key) continue;
      const failure = displayedRuntimeReceipts.find((candidate) =>
        candidate.idempotencyKey === entry.key
        && receiptIsTerminal(candidate.status) && !receiptIsAdmitted(candidate.status));
      if (failure) idempotencyKey.current = mintIdempotencyKey();
    }
    if (!pendingDeliveries.current.length) return;
    /* A retry leaf receives a fresh idempotency key and points at its parent
       operation. Move logical-generation ownership to that leaf before
       settlement so queued/delivered retry receipts consume the original once. */
    const rebound = rebindPendingOperations(pendingDeliveries.current, displayedRuntimeReceipts);
    const operationChanged = rebound.some((entry, index) => entry !== pendingDeliveries.current[index]);
    if (operationChanged) persistPendingDeliveries(rebound);
    const { settled, remaining } = settlePendingDeliveries(pendingDeliveries.current, displayedRuntimeReceipts);
    const incompleteStillUncertain = remaining.some((entry) => {
      if (entry.payloadComplete !== false) return false;
      return !displayedRuntimeReceipts.some((receipt) =>
        (receipt.idempotencyKey === entry.key || receipt.operationId === entry.operationId)
        && receiptIsTerminal(receipt.status));
    });
    setReconcilingSend(receiptReconciliations.current.size > 0 || incompleteStillUncertain);
    if (!settled.length) return;
    persistPendingDeliveries(remaining);
    for (const settlement of settled) {
      markSettled(settlement.entry.key);
      /* A queued submission already left the composer at submit time: clearing
         the draft again here would eat text typed for the NEXT message. Its
         bubble takes the state the receipt actually PROVES (round-1 P1#4): a
         `queued`/`delivering` admission keeps the bubble `delivering`, only a
         truly delivered receipt marks it `delivered`. */
      if (outboxKeys.current.has(settlement.entry.key)) {
        const receipt = displayedRuntimeReceipts.find((candidate) =>
          candidate.idempotencyKey === settlement.entry.key && receiptIsAdmitted(candidate.status));
        const state = receipt ? outboxStateForReceiptStatus(receipt.status) : "delivered";
        updateOutbox(cardId, settlement.entry.key, {
          state,
          settledAt: nowMs(),
          /* #1213: parked at a turn boundary is not "on the wire". */
          awaitingTurn: receipt ? outboxAwaitsTurnBoundary(receipt.status) : undefined,
        });
      } else {
        const next = draftAfterDelivery(textRef.current, settlement.text);
        if (next !== textRef.current) setText(next);
      }
      attachments.settleDelivered(settlement.entry.images, settlement.entry.files ?? []);
      /* The admitted attempt consumed its key: minting a fresh one keeps the
         next message from being replay-deduped into silence server-side. */
      if (settlement.entry.key === idempotencyKey.current) idempotencyKey.current = mintIdempotencyKey();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setText/textRef/attachments/persistPendingDeliveries/finishReceiptReconciliation are hook-stable
  }, [displayedRuntimeReceipts, cardId]);

  /* Receipt-state progression for the outbox bubble (round-1 P1#4). The durable
     receipt stream is authoritative for a bubble's state: a `delivering` bubble
     advances to `delivered` when its delivery receipt lands (so it never sits
     "delivering" forever and blocks the serial dispatcher), and a bubble
     prematurely marked `failed` by a possibly-accepted 5xx recovers to
     `delivering` once a receipt PROVES admission (queued/delivering) — the
     message was admitted after all. A `delivered` bubble is terminal-good and is
     never downgraded; a repeat failure never re-churns an already-failed
     bubble. Launch-owned bubbles retire on their echo, not on a receipt. */
  useEffect(() => {
    for (const entry of outbox) {
      if (entry.launchOwned || entry.state === "delivered") continue;
      const receipt = displayedRuntimeReceipts.find((candidate) =>
        candidate.idempotencyKey === entry.id
        && (receiptIsAdmitted(candidate.status) || receiptIsTerminal(candidate.status)));
      if (!receipt) continue;
      const patch = outboxReceiptPatch(entry, receipt.status);
      if (!patch) continue;
      updateOutbox(cardId, entry.id, { ...patch, settledAt: nowMs() });
    }
  }, [displayedRuntimeReceipts, outbox, cardId]);

  /* Level-triggered release of switch-held submissions (P1: messages held for
     an account switch were never released after the switch completed). A held
     entry's event-shaped release signals — the successor's receipt, the
     delivered text's transcript echo — can simply never arrive once the
     server-side hold record is gone, so the release is re-derived from the
     LEVEL on every snapshot: whenever this card no longer holds deliveries,
     every parked entry returns to the queue and the serial dispatcher replays
     it under its original idempotency key. The per-hold-cycle set damps the
     level to one replay per transition, so a fence that momentarily outlives
     the annotation re-parks the entry as held instead of looping the wire. */
  const releasedHolds = useRef<{ card: string; ids: Set<string> }>({ card: cardId, ids: new Set() });
  useEffect(() => {
    if (releasedHolds.current.card !== cardId) releasedHolds.current = { card: cardId, ids: new Set() };
    if (holdsDelivery) {
      releasedHolds.current.ids.clear();
      return;
    }
    for (const id of releaseHeldOutbox(cardId, releasedHolds.current.ids)) {
      releasedHolds.current.ids.add(id);
      /* The held attempt already settled this generation once (that is what
         parked it). The replay is a NEW attempt under the same key: its
         settlement record resets so the redelivery can settle the bubble. */
      settledSendKeys.current.delete(id);
    }
  }, [holdsDelivery, cardId, outbox]);

  /* A link-arrow drop appended to the stored draft; reload it and put the
     caret at the end so the ask can be typed straight away. Goes through the
     stable ref/setter pair rather than setText — the draft is already
     persisted, and the closure must not go stale between events. */
  useEffect(() => {
    const onCompose = (event: Event) => {
      if ((event as CustomEvent<{ path?: string }>).detail?.path !== cardId) return;
      const next = sessionStorage.getItem(draftKey(cardId)) ?? "";
      textRef.current = next;
      setTextState(next);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, [cardId, inputRef, setTextState, textRef]);

  /* The queue drains itself: a pane message is delivered once the transcript
     grew after the send moment; a spawn prompt lands in a fresh window whose
     transcript is a different file, so it expires by time instead. A pane
     relay into a subagent that has since finished never grows its transcript
     again, so pane entries also fall back to a TTL, just a longer one than
     spawn entries since a live pane can legitimately go quiet for a while.
     Pending migration receipts (held/queued/recovering/failed) are exempt: they
     resolve on the successor, not this predecessor, so only an explicit
     resolve/dismiss removes them. */
  useEffect(() => {
    const prune = () =>
      setSent((prev) => {
        const next = prev.filter((entry) => {
          if (isPendingReceipt(entry)) return true;
          if (entry.via === "pane") return file.mtime * 1000 < entry.at + 2_000 && Date.now() - entry.at < PANE_TTL_MS;
          return Date.now() - entry.at < SPAWN_TTL_MS;
        });
        if (next.length !== prev.length) sessionStorage.setItem(sentKey(cardId), JSON.stringify(next));
        return next.length !== prev.length ? next : prev;
      });
    prune();
    const timer = setInterval(prune, 5_000);
    return () => clearInterval(timer);
  }, [file.mtime, cardId]);

  /* #844: the PREVIEW read — it follows the selection as the operator moves it.
     Above the capability early-returns below, because a hook may not be called
     conditionally; the badge it feeds is rendered only when there is a card to
     name. The submission itself re-reads the bus synchronously inside `send`, so
     what rides the wire is decided at the submission instant rather than by
     whatever this render closed over. */
  const liveSelectedContext = useViewerSelectedContext();

  // A surface whose Send capability is hidden exposes NO message surface — no
  // Send, quick-ack, mic, or image path, and fires zero requests. This gates the
  // gated scanner-shaped subagent (inert row) that `canMessageWithoutPane` would
  // otherwise treat as resumable and let POST /api/tmux (finding 2). Unresolved
  // hosts keep a disabled Send. Durable structured ownership keeps text-only
  // dead-host drafts usable through recovery admission.
  if (caps.controls.send.state === "hidden") return null;
  const resumable = canMessageWithoutPane(file);
  if (target === null && !resumable) return null;
  /* An EXISTING conversation whose runtime ownership is not yet resolved (the
     fail-safe `unresolved` surface: plane on, no host evidence yet) is never a
     spawn draft — its next message reaches the existing agent through
     /api/runtime/send once the host resolves. The composer describes
     messaging/recovering that agent, derives its own send block with the
     resolving reason (so no /api/tmux POST can fire even without the pane's
     prop), and keeps the Re-check recovery route (issue #499 round 2). */
  const unresolvedOwnership = caps.surface === "unresolved";
  const effectiveSendBlockedReason = sendBlockedReason ?? (unresolvedOwnership ? t("strip.resolving") : null);
  const spawnMode = target === null && !structuredSession && !unresolvedOwnership;
  const relayMode = spawnMode && file.root === "claude-projects" && file.kind === "subagent";

  const persistSent = (next: SentEntry[]) => {
    setSent(next);
    sessionStorage.setItem(sentKey(cardId), JSON.stringify(next));
  };

  /**
   * Queue-first submit (issue #561). The draft becomes a durable queue entry
   * and leaves the composer immediately: the feed renders it as an optimistic
   * user bubble, the field clears and stays typable, and the operator can
   * inspect or cancel it before the serial dispatcher takes it to the wire.
   * Every pre-flight refusal happens HERE, so nothing is ever queued into a
   * wall — the queue only ever holds messages that may still be delivered.
   */
  /* `preserveDraft` queues a message that stands apart from the operator's
     current draft — the quick-ack (finding 5). It carries no attachments and
     leaves the composer's typed text and staged tiles exactly where they were. */
  const queueSubmit = (overrideText?: string, options?: { preserveDraft?: boolean }) => {
    const preserveDraft = options?.preserveDraft ?? false;
    const requestedText = overrideText ?? textRef.current;
    const requestedImages: PendingImage[] = preserveDraft ? [] : attachments.imagesRef.current.map((image) => ({ ...image }));
    const requestedFiles: PendingFile[] = preserveDraft ? [] : attachments.filesRef.current.map((file) => ({ ...file }));
    if (voiceSending || reconcilingSend) return;
    if (!requestedText.trim() && !requestedImages.length && !requestedFiles.length) return;
    if (deadHost && !structuredSession) {
      setStatus({ kind: "err", text: t("deadHost.sendBlocked") });
      return;
    }
    if (structuredSession && structuredImagesDisabled && requestedImages.length) {
      setStatus({ kind: "err", text: structuredImagesReason! });
      return;
    }
    if (effectiveSendBlockedReason) {
      setStatus({ kind: "err", text: effectiveSendBlockedReason });
      return;
    }
    if (structuredSession && requestedImages.length && !attachments.validate()) return;
    /* Every queued submission is its own logical generation and mints its own
       fresh key at the moment it enters the queue. Replay identity lives on
       the durable outbox entry (its id IS the key), never on composer state a
       remount may have restored from an older unresolved generation — reusing
       such a key would stamp a NEW message as a replay of stale bytes. */
    const clientMessageId = mintIdempotencyKey();
    outboxImages.current.set(clientMessageId, requestedImages);
    if (requestedFiles.length) outboxFiles.current.set(clientMessageId, requestedFiles);
    outboxKeys.current.add(clientMessageId);
    enqueueOutbox(cardId, {
      id: clientMessageId,
      text: requestedText,
      images: requestedImages.length,
      /* #1224: recorded on the durable entry so the refresh fence holds a
         document-bearing submission back exactly as it holds an image-bearing
         one — `outboxFiles` is memory-only, so a replay after a reload would
         deliver the text without the file and say nothing. */
      ...(requestedFiles.length ? { files: requestedFiles.length } : {}),
      at: nowMs(),
      /* Submission watermark (finding 2): the echoes of this exact text that
         already exist, so a pre-existing identical message never retires this
         fresh bubble — only its own later echo does. */
      echoBaseline: transcriptEchoCount(cardId, requestedText),
    });
    if (!preserveDraft) {
      setText("");
      attachments.clearAll();
    }
    setStatus(null);
    inputRef.current?.focus();
  };

  const send = async (overrideText?: string, retry?: { receiptId?: number; clientMessageId?: string }, outboxId?: string) => {
    const requestedText = overrideText ?? text;
    /* The generation snapshot: exactly the text and attachments this attempt
       carries onto the wire. Read through the ref so a submit racing a paste
       still sends and later clears the same set. A queued submission carries
       the attachments frozen at submit time instead — the tray has moved on. */
    const requestedImages: PendingImage[] = (outboxId ? outboxImages.current.get(outboxId) ?? [] : attachments.imagesRef.current)
      .map((image) => ({ ...image }));
    const requestedFiles: PendingFile[] = (outboxId ? outboxFiles.current.get(outboxId) ?? [] : attachments.filesRef.current)
      .map((file) => ({ ...file }));
    /** Records a queued submission's fate on the queue itself. A no-op for a
        direct (non-queued) send, which reports through the status line. The
        bubble takes the state the receipt PROVES: a bare admission stays
        `delivering`, only a delivered receipt reads `delivered` (round-1 P1#4). */
    const settleOutbox = (state: OutboxState, error?: string, held?: boolean, awaitingTurn?: true) => {
      if (!outboxId) return;
      /* A held settlement stamps the entry so `releaseHeldOutbox` can requeue
         it level-wise once the switch is over — a parked hold looks exactly
         like an in-flight delivery otherwise. */
      updateOutbox(cardId, outboxId, {
        state,
        settledAt: nowMs(),
        awaitingTurn,
        ...(error ? { error } : {}),
        ...(held ? { heldForSwitch: true as const } : {}),
      });
      if (state === "delivered") {
        outboxImages.current.delete(outboxId);
        outboxFiles.current.delete(outboxId);
      }
    };
    const settleOutboxFromReceipt = (receipt: RuntimeReceipt) => {
      /* The late admission: a send that answered `pending` and settled on the receipt
         stream. This is the moment its bridge batch became durable. */
      if (receiptIsAdmitted(receipt.status)) commitBridgeFor(clientMessageId);
      /* `queued` is durable admission at a turn boundary. It is a switch hold
         only while the card's migration evidence says this delivery belongs to
         a successor; an ordinary queued receipt must never requeue itself. */
      return settleOutbox(
        outboxStateForReceiptStatus(receipt.status),
        undefined,
        holdsDelivery && receipt.status === "queued",
        outboxAwaitsTurnBoundary(receipt.status),
      );
    };
    /* Resolve the key before selecting the payload. A generation retained after
       uncertain admission owns an immutable text/image snapshot; later edits
       stay in the composer for the following generation while an explicit
       submit replays the original bytes under the original key. */
    const clientMessageId = deliveryAttemptKey(idempotencyKey.current, retry?.clientMessageId);
    const replayGeneration = pendingDeliveries.current.find((entry) => entry.key === clientMessageId);
    /* #844: READ HERE, before the first await. This is the submission instant as
       far as the reference is concerned — everything it will ever say is decided
       now, so the operator moving the board a moment later cannot rewrite the
       admitted turn. A replay reuses the generation's original reference for
       the same reason it replays the original bytes. */
    const selectedContext = replayGeneration?.selectedContext ?? viewerSelectedContext();
    /* #691 §4, the no-call path: a turn is opening, so whatever the manager
       reported while nothing was live rides in with it. Never on a replay — a
       retained generation replays its original bytes under its original key, and
       changing them would defeat the idempotency the retry exists for. */
    const bridgeTurn = replayGeneration ? null : await drainBridgeTurnStart();
    /* The Viewer-global orchestrator travels with the operator: what they are
       looking at right now — current project, focused conversation, explicit
       selection, read from the same view bus presence publishes from — rides
       into the turn, so "do this in the project I'm viewing" resolves without
       re-docking the floating window. Composed at dispatch and never on a
       replay, exactly like the bridge prelude above; empty whenever the operator
       is simply looking at this conversation itself.

       SCOPED TO THE MANAGER'S IDENTITY. `voiceEnabled` is
       true of every hosted codex-app-server conversation, so gating on it
       prepended the operator's view to unrelated workers' turns. The one thing
       that names the manager is the project's active seat (`managerIdentity`),
       queried per dispatch and cached. */
    const viewerPrelude = replayGeneration || !(await isDesignatedManagerConversation(cardId, file.project))
      ? ""
      : viewerContextPrelude({ path: file.path, project: file.project });
    const composedText = viewerPrelude ? `${viewerPrelude}\n${requestedText}` : requestedText;
    const payloadText = replayGeneration?.text
      ?? (bridgeTurn?.text ? `${bridgeTurn.text}\n\n${composedText}` : composedText);
    const sentImages: PendingImage[] = replayGeneration
      ? replayGeneration.images.map((image) => ({ ...image }))
      : requestedImages;
    const sentFiles: PendingFile[] = replayGeneration
      ? (replayGeneration.files ?? []).map((file) => ({ ...file }))
      : requestedFiles;
    if (!payloadText.trim() && !sentImages.length && !sentFiles.length) {
      /* Nothing to deliver — a queued entry that lost its payload must leave
         the queue rather than block the drain forever. */
      if (outboxId) cancelOutbox(cardId, outboxId);
      return;
    }
    if (busy || voiceSending || reconcilingSend) {
      /* The composer became unavailable between dispatch and here; the entry
         returns to the queue and the dispatcher retries when it clears. */
      if (outboxId) updateOutbox(cardId, outboxId, { state: "queued" });
      return;
    }
    /* The wire payload was scaffolded past the raw draft (viewer prelude,
       drained bridge turn): the transcript will echo the SCAFFOLDED text, so
       the queued bubble's echo identity re-binds to it before delivery —
       otherwise its echo never matches and the delivered bubble lingers in the
       tail below the agent's newer output. */
    if (outboxId && payloadText !== requestedText) {
      rebindOutboxEchoText(cardId, outboxId, payloadText);
    }
    /* A legacy dead host keeps its draft local. Structured ownership admits a
       text-only message durably and uses that request to recover its engine host.
       A conversation whose delivery route disappeared AFTER a message was queued
       marks that message undelivered with the reason instead of retrying into a
       wall — the operator keeps the text and the explanation. */
    if (deadHost && !structuredSession) {
      setStatus({ kind: "err", text: t("deadHost.sendBlocked") });
      settleOutbox("failed", t("deadHost.sendBlocked"));
      return;
    }
    if (structuredSession && structuredImagesDisabled && sentImages.length) {
      setStatus({ kind: "err", text: structuredImagesReason! });
      settleOutbox("failed", structuredImagesReason!);
      return;
    }
    /* Host not yet resolved under the runtime plane: block the POST so a
       structured/dead conversation is never sent to via the legacy /api/tmux
       path before its real host capability arrives (finding 1). */
    if (effectiveSendBlockedReason) {
      setStatus({ kind: "err", text: effectiveSendBlockedReason });
      settleOutbox("failed", effectiveSendBlockedReason);
      return;
    }
    if (structuredSession && sentImages.length && !attachments.validate()) return;
    setBusy(true);
    setStatus(deadHost
      ? { kind: "info", text: t("composer.receiptRecovering") }
      : null);
    /* The runtime settings this key rides with, frozen at its first attempt so
       structured sends and legacy resume spawns replay byte-identically. */
    const legacyResumeRuntime = spawnMode && !relayMode;
    const capturesRuntime = Boolean(structuredSession) || legacyResumeRuntime;
    if (capturesRuntime && !runtimeSendSnapshots.current.has(clientMessageId)) {
      runtimeSendSnapshots.current.set(
        clientMessageId,
        replayGeneration?.runtimeCaptured
          ? replayGeneration.runtime
          : structuredSession
            ? sendRuntimeFrom(file)
            : resumeProfileBody(file),
      );
      while (runtimeSendSnapshots.current.size > SETTLED_SEND_KEY_LIMIT) {
        const oldest = runtimeSendSnapshots.current.keys().next().value;
        if (oldest === undefined) break;
        runtimeSendSnapshots.current.delete(oldest);
      }
    }
    const runtimeOverride = runtimeSendSnapshots.current.get(clientMessageId);
    /* A local pre-flight rejection (image protocol gate) never reaches the
       wire, so it must not arm a pending generation either. */
    const reachesWire = !(structuredSession && structuredImagesDisabled && sentImages.length > 0);
    /* Record the generation BEFORE the request: a durable admission receipt can
       land on the receipt stream while this response is still in flight, and
       it must find the generation to clear. The earliest attempt per key stays
       the immutable record — a replay never overwrites it — and a key whose
       generation already settled is never re-armed. */
    const recordedThisAttempt = reachesWire
      && !settledSendKeys.current.has(clientMessageId)
      && !pendingDeliveries.current.some((entry) => entry.key === clientMessageId);
    if (recordedThisAttempt) {
      persistPendingDeliveries([
        {
          key: clientMessageId,
          text: payloadText,
          images: sentImages,
          ...(sentFiles.length ? { files: sentFiles } : {}),
          ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
          selectedContext,
          ...(capturesRuntime ? { runtimeCaptured: true as const } : {}),
        },
        ...pendingDeliveries.current,
      ].slice(0, PENDING_DELIVERY_LIMIT));
    }
    /* Clear exactly this settled generation: its text prefix leaves the draft
       (later typing survives) and its attachment snapshot leaves the tray
       (later images survive). At most once per key — a replayed receipt for an
       already-settled generation must not touch what the user typed since. */
    const settleGeneration = (clearedText: string, snapshot: readonly PendingImage[], fileSnapshot: readonly PendingFile[] = []) => {
      if (settledSendKeys.current.has(clientMessageId)) return;
      markSettled(clientMessageId);
      /* A queued generation left the composer when it was submitted; clearing
         the draft here would eat text prepared for the next message. */
      if (!outboxId) setText(draftAfterDelivery(textRef.current, clearedText));
      attachments.settleDelivered(snapshot, fileSnapshot);
    };
    const settleLegacySuccess = (result: ComposerSendResult) => {
      if (settledSendKeys.current.has(clientMessageId)) return;
      const imgCount = sentImages.length;
      const held = result.outcome === "held" || result.outcome === "queued" || result.outcome === "recovering";
      const at = nowMs();
      const entry: SentEntry = {
        id: at,
        text: payloadText.trim()
          || (sentFiles.length ? t("composer.attachmentsCount", { count: sentFiles.length + imgCount }) : "")
          || (imgCount ? t("composer.imagesCount", { count: imgCount }) : ""),
        at,
        via: result.outcome === "resumed" || result.spawned ? "spawn" : "pane",
        state: held ? (result.outcome as DeliveryReceiptState) : "sent",
        clientMessageId,
      };
      /* ONE delivery state per message. A queued submission's own bubble in the
         feed is its delivery record, so the composer's receipt row and status
         line belong to a DIRECT send, which has no bubble. Painting both put a
         held message on the card three times at once — «queued» receipt,
         «Delivering» bubble, and a «Held for …» line — and left the operator to
         reconcile them. A direct send keeps both; they are all it has. */
      const ownsDeliveryState = !outboxId || !held;
      if (ownsDeliveryState) {
        const prior = retry ? sent.filter((item) => item.id !== retry.receiptId) : sent;
        persistSent([...prior, entry].slice(-SENT_LIMIT));
      }
      const attempt = pendingDeliveries.current.find((candidate) => candidate.key === clientMessageId);
      persistPendingDeliveries(pendingDeliveries.current.filter((candidate) => candidate.key !== clientMessageId));
      setImmediateRuntimeReceipts((current) => current.filter((candidate) =>
        candidate.idempotencyKey !== clientMessageId
        && candidate.operationId !== unconfirmedReceiptOperationId(clientMessageId)));
      if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
      settleGeneration(payloadText, attempt?.images ?? sentImages, attempt?.files ?? sentFiles);
      /* A legacy pane send that reached the pane is delivered; a migration
         hold/queue is still in flight to the successor (round-1 P1#4). */
      settleOutbox(held ? "delivering" : "delivered", undefined, held);
      if (ownsDeliveryState) {
        /* A `held` outcome does NOT imply an account switch: the registry fence
           also holds a delivery whose generation claim did not land. Only a card
           that is actually switching may promise the message "delivers after the
           account switch"; otherwise the hold is said plainly.
           The target can be nameless for the whole pending window — the
           annotation is published before the target identity reaches the card.
           The hold is still true, so it is said without a name rather than held
           for «» (an account the operator cannot recognize). */
        const heldForSwitch = migrationHoldsDelivery(cardMigrationState(liveMigration));
        const heldFor = migrationTargetName(liveMigration);
        setStatus({
          kind: held ? "info" : "ok",
          text: held
            ? !heldForSwitch
              ? t("composer.deliveryHeldWaiting")
              : heldFor
                ? t("composer.deliveryHeld", { label: heldFor })
                : t("composer.deliveryHeldUnnamed")
            : result.outcome === "resumed" || result.spawned
              /* A structured respawn answers with no target at all, so the
                 named form would render a dangling dash (#1301). */
              ? result.target
                ? t("composer.spawned", { target: result.target })
                : t("composer.spawnedUnnamed")
              : (result.imagePaths?.length ?? 0) + (result.filePaths?.length ?? 0)
                ? t("composer.sentPaths", { count: (result.imagePaths?.length ?? 0) + (result.filePaths?.length ?? 0) })
                : t("common.sent"),
        });
      }
      /* A queued delivery must never steal focus back: the operator may
         already be typing the next message. */
      if (!outboxId) inputRef.current?.focus();
    };
    const responseEpoch = legacyResponseEpoch.current;
    let admissionRequest: Promise<ComposerSendResult> | null = null;
    try {
      admissionRequest = Promise.resolve(structuredSession
        ? !reachesWire
          ? { ok: false, structured: true, error: structuredImagesReason }
          : runtimeDependencies.sendRuntimeMessage({
              conversationId: structuredSession.session.conversationId,
              text: payloadText.trim(),
              images: sentImages.map((image) => ({ base64: image.base64, mime: image.mime })),
              /* #1224: the bytes ride the request and the SERVER writes them to
                 the conversation's inbox, then names the path in the delivered
                 message — nothing has to reach the agent's machine separately,
                 because it is the same machine. */
              ...(sentFiles.length ? { files: sentFiles.map((file) => ({ name: file.name, base64: file.base64 })) } : {}),
              idempotencyKey: clientMessageId,
              policy: "interrupt-active",
              ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
              selectedContext,
            }).then((result) => ({
              ok: result.ok,
              structured: true,
              error: result.error,
              status: result.status,
              receipt: result.receipt,
              outcome: (result.receipt?.status === "delivering" || result.receipt?.status === "delivered"
                ? result.receipt.status
                : "queued") as "delivering" | "delivered" | "queued",
            }))
        : fetch("/api/tmux", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pid: file.pid ?? undefined,
              path: file.path,
              text: payloadText,
              idempotencyKey: clientMessageId,
              clientMessageId,
              images: sentImages.map((image) => ({ base64: image.base64, mime: image.mime })),
              ...(sentFiles.length ? { files: sentFiles.map((file) => ({ name: file.name, base64: file.base64 })) } : {}),
              /* #1117: the composer is the operator's own surface; the
                 structured branch above is stamped server-side by /api/runtime/send. */
              origin: { kind: "operator" },
              /* The "on resume" profile (issue #241 §4): when this send reopens a
                 finished root conversation, boot it with the model/effort the
                 strip's picker saved. Ignored for a live pane or a subagent relay. */
              ...(legacyResumeRuntime ? runtimeOverride ?? {} : {}),
            }),
          }).then(async (response) => {
            const body = await response.json() as ComposerSendResult;
            return { ...body, status: response.status, ok: response.ok && body.ok === true };
          }));
      const json = await withComposerAdmissionDeadline(admissionRequest, admissionTiming.admissionDeadlineMs);
      /* #691 §4 — the bridge cursor moves only on DURABLE admission.
         `json.ok` is not that: a structured send answers ok with a receipt that may
         still be `pending`, which the server has not committed to holding. So the
         cursor waits for a receipt the outbox itself calls admitted; the legacy path
         has no queue to be pending in, so there an ok response IS the admission.
         Anything still in flight parks its token under the delivery key and is
         settled by whichever receipt admits it later. */
      if (bridgeTurn?.ackToken) rememberBridgeAcknowledgement(clientMessageId, bridgeTurn.ackToken);
      const admittedNow = json.ok
        && (json.structured ? Boolean(json.receipt && receiptIsAdmitted(json.receipt.status)) : true);
      if (admittedNow) commitBridgeFor(clientMessageId);
      else if (!json.ok) forgetBridgeAcknowledgement(clientMessageId);
      if (!json.ok) {
        if (json.structured && json.receipt) {
          /* Keep the payload readable in the compact receipt for retry and
             audit even when the server's echo omits it. */
          const receipt: RuntimeReceipt = (json.receipt.kind === "send" || json.receipt.kind === "steer")
            && !json.receipt.text && payloadText.trim()
            ? { ...json.receipt, text: payloadText.trim() }
            : json.receipt;
          setImmediateRuntimeReceipts((current) => [
            receipt,
            ...current.filter((candidate) => candidate.operationId !== receipt.operationId),
          ].slice(0, 8));
          if (receiptIsAdmitted(receipt.status)) {
            /* An idempotent replay: this key's FIRST attempt was durably
               admitted (queued or beyond) — the server holds the message.
               Clear exactly that generation: for a delivered replay the
               receipt's record of what reached the agent wins; for a queued
               admission the attempt's own text does (the echo may be a bounded
               summary). Attachments clear by the FIRST attempt's snapshot —
               images attached after that attempt stay put. */
            const attempt = pendingDeliveries.current.find((entry) => entry.key === clientMessageId);
            persistPendingDeliveries(pendingDeliveries.current.filter((entry) => entry.key !== clientMessageId));
            const admitted = receipt.status === "delivered" && typeof json.receipt.text === "string" && json.receipt.text
              ? json.receipt.text
              : attempt?.text ?? payloadText;
            settleGeneration(admitted, attempt?.images ?? sentImages, attempt?.files ?? sentFiles);
            settleOutboxFromReceipt(receipt);
            if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
            if (receipt.status === "delivered") setStatus({ kind: "ok", text: t("common.sent") });
            if (!outboxId) inputRef.current?.focus();
            return;
          }
          /* A definitive rejection consumed the key — the next submit is a new
             message. An `uncertain`/`pending` receipt keeps the key so the
             user's retry replays idempotently instead of double-sending. */
          if (receiptIsTerminal(receipt.status) && idempotencyKey.current === clientMessageId) {
            idempotencyKey.current = mintIdempotencyKey();
          }
        }
        if (settledSendKeys.current.has(clientMessageId)) {
          /* A stale settlement: a durable admission already cleared this
             generation while the response was in flight. The receipt stack
             tells the truth — no false failure, no re-armed pending entry. */
          return;
        }
        /* The earliest attempt per key is the immutable record of what the
           server may have accepted: a retry never overwrites it, and a
           definitive 4xx rejection (e.g. a changed-payload 409) keeps no
           entry — only a lost response (network/5xx) or an explicitly
           still-moving receipt does. */
        const possiblyAccepted = !receiptIsTerminal(json.receipt?.status ?? "pending")
          && (json.status === undefined || json.status >= 500);
        if (!possiblyAccepted && recordedThisAttempt) {
          persistPendingDeliveries(pendingDeliveries.current.filter((entry) => entry.key !== clientMessageId));
        }
        // A hard failure keeps the draft text (never cleared) so the message is
        // not lost; the error is announced by the composer's live status region.
        // A queued submission keeps its own bubble instead, marked undelivered
        // with a cancel — the text is never silently dropped either way.
        settleOutbox("failed", json.error ?? t("common.failedSend"));
        setStatus({ kind: "err", text: json.error ?? t("common.failedSend") });
        return;
      }
      if (json.structured && json.receipt) {
        setImmediateRuntimeReceipts((current) => [
          json.receipt!,
          ...current.filter((receipt) => receipt.operationId !== json.receipt!.operationId),
        ].slice(0, 8));
        const attempt = pendingDeliveries.current.find((entry) => entry.key === clientMessageId);
        persistPendingDeliveries(pendingDeliveries.current.filter((entry) => entry.key !== clientMessageId));
        if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
        settleGeneration(payloadText, attempt?.images ?? sentImages, attempt?.files ?? sentFiles);
        settleOutboxFromReceipt(json.receipt);
        if (!outboxId) inputRef.current?.focus();
        return;
      }
      settleLegacySuccess(json);
    } catch (error) {
      /* The request died on the wire AFTER the server may have accepted it.
         The pre-flight record (text AND attachment snapshot) stays armed so a
         late admission receipt still clears exactly what was sent. A stale
         death racing a faster durable admission reports nothing — the receipt
         stack already tells the truth. */
      if (!settledSendKeys.current.has(clientMessageId)) {
        setStatus({
          kind: "err",
          text: error instanceof ComposerAdmissionTimeoutError
            ? t("composer.admissionTimedOut")
            : t("common.serverUnavailable"),
        });
        if (!(error instanceof ComposerAdmissionTimeoutError)) settleOutbox("failed", t("common.serverUnavailable"));
        if (error instanceof ComposerAdmissionTimeoutError) {
          persistPendingDeliveries(pendingDeliveries.current.map((entry) =>
            entry.key === clientMessageId ? { ...entry, reconciling: true } : entry));
          const lateReceipt = admissionRequest?.then((result) => {
            const receipt = result.receipt;
            if (receipt && (receiptIsAdmitted(receipt.status) || receiptIsTerminal(receipt.status))) {
              return (receipt.kind === "send" || receipt.kind === "steer")
                && !receipt.text && payloadText.trim()
                ? { ...receipt, text: payloadText.trim() }
                : receipt;
            }
            if (!result.ok || result.structured) return null;
            if (!responseEpoch.active || legacyResponseEpoch.current !== responseEpoch) return null;
            const controller = receiptReconciliations.current.get(clientMessageId);
            settleLegacySuccess(result);
            controller?.abort();
            receiptReconciliations.current.delete(clientMessageId);
            setReconcilingSend(receiptReconciliations.current.size > 0);
            return null;
          });
          startReceiptReconciliation(clientMessageId, lateReceipt);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  /** Takes the oldest queued submission to the wire. Serial: the dispatcher
      never yields a second entry while this one is in flight. */
  const dispatchQueued = (entry: OutboxEntry) => {
    const claimed = claimOutboxDispatch(cardId, entry.id);
    if (!claimed) return;
    outboxKeys.current.add(claimed.id);
    void send(claimed.text, { clientMessageId: claimed.id }, claimed.id);
  };

  const rememberRuntimeReceipt = (receipt: RuntimeReceipt) => {
    setImmediateRuntimeReceipts((current) => [
      receipt,
      ...current.filter((candidate) => candidate.operationId !== receipt.operationId),
    ].slice(0, 8));
  };

  const retryRuntimeReceipt = async (receipt: RuntimeReceipt, mode?: "uncertain") => {
    if (busy || voiceSending) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/runtime/operations/${encodeURIComponent(receipt.operationId)}`, mode === "uncertain"
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "retry-uncertain" }),
          }
        : { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { receipt?: RuntimeReceipt; error?: string };
      if (body.receipt) rememberRuntimeReceipt(body.receipt);
      if (!response.ok || !body.receipt) {
        setStatus({ kind: "err", text: body.error ?? t("common.failedSend") });
        return;
      }
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setBusy(false);
    }
  };

  const discardRuntimeReceipt = async (receipt: RuntimeReceipt) => {
    if (busy || voiceSending) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/runtime/operations/${encodeURIComponent(receipt.operationId)}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { receipt?: RuntimeReceipt; error?: string };
      if (body.receipt) rememberRuntimeReceipt(body.receipt);
      if (!response.ok || !body.receipt) {
        setStatus({ kind: "err", text: body.error ?? t("common.failedSend") });
        return;
      }
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setBusy(false);
    }
  };

  const editRuntimeReceipt = (receipt: RuntimeReceipt) => {
    if (busy || voiceSending || !receipt.text) return;
    idempotencyKey.current = mintIdempotencyKey();
    setText(receipt.text);
    setStatus(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(receipt.text!.length, receipt.text!.length);
    });
  };

  /* Every submission method funnels through the queue-first path (round-1 P1#1):
     the Send button (this form submit), the Enter key (ComposerBar → the
     composer's `submit`), and one-tap dictation (`stopAndSend` → the same
     `submit`) all call `queueSubmit`. Clicking Send therefore gets the identical
     optimistic bubble, composer clear, and queue inspection/cancellation as
     Enter — never a bypassed direct `send()`. */
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    queueSubmit();
  };

  /* Mode chip, interrupt, compact, and attach-terminal now live in the unified
     control strip (issue #241); the composer no longer renders them. */

  /* The main send surface stays inert for legacy dead hosts and unresolved
     ownership. Structured dead hosts use durable text-only recovery admission.
     Quick-ack calls the same `send()`, so it obeys the same block and leaves the
     menu when blocked (round-3 finding). */
  const deadHostBlocksSend = deadHost && !structuredSession;
  const sendBlocked = deadHostBlocksSend || reconcilingSend || Boolean(effectiveSendBlockedReason);
  const canQuickAck = (!spawnMode || relayMode) && !sendBlocked;
  const composerHistory = outboxHistory(outbox);
  const quickAckDisabled = busy || voiceSending || attachments.images.length > 0;

  const composerAriaLabel = structuredSession
    ? t("composer.sendStructuredAria")
    : unresolvedOwnership
      ? t("composer.resolvingAria")
      : spawnMode
        ? t("composer.spawnAria")
        : t("composer.sendAria", { target: target ?? "" });

  /* ── The phone's send slot (mobile v2 §2 rule 8, §4.2) ──────────────────────
     The one inline control under the field. It replaced two rows the operator
     photographed above the keyboard: the live-tail pill and the «working …»
     status bar. Its kind is decided from the SAME state authority every other
     phone surface reads (`chatState`), so the slot and the bar's meta line can
     never disagree about what the conversation is doing. Desktop passes no slot
     and keeps its plain send. */
  const phoneState = chatState(file);
  const composerHasDraft = text.trim().length > 0 || attachments.images.length > 0 || attachments.files.length > 0;
  const slotKind = composerSlotKind({
    killed: phoneState === "killed",
    offline: runtimeOffline,
    working: phoneState === "working",
    hasDraft: composerHasDraft,
  });

  /* Stop, from the composer instead of a strip the phone no longer shows. It
     routes exactly where this composer's own send does — the structured host
     it already resolved, or the legacy conversation-host action. */
  const stopTurn = async () => {
    if (slotBusy) return;
    setSlotBusy(true);
    setStatus(null);
    try {
      const result = structuredSession
        ? await interruptRuntime(structuredSession.session.conversationId, mintIdempotencyKey())
        : await fetch("/api/tmux", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "interrupt", path: file.path }),
          }).then(async (response) => {
            const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            return { ok: response.ok && body.ok === true, error: body.error };
          });
      if (!result.ok) setStatus({ kind: "err", text: result.error ?? t("composer.failedInterrupt") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setSlotBusy(false);
    }
  };

  /* Respawn, the killed conversation's way back (§4.2). The conversation menu
     leaves it here deliberately: with no agent there is nothing to send to, so
     the send slot IS the recovery. Same durable `resume` the dead-host banner
     uses, followed by the snapshot refresh that clears the killed state. */
  const respawnAgent = async () => {
    if (slotBusy) return;
    setSlotBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", path: file.path }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setStatus({ kind: "err", text: body.error ?? t("deadHost.respawnFailed") });
      } else {
        await runtimeDependencies.refreshRuntime();
      }
    } catch {
      setStatus({ kind: "err", text: t("deadHost.respawnFailed") });
    } finally {
      setSlotBusy(false);
    }
  };

  const SLOT: Record<ComposerSlotKind, { label: string; text?: string; onAct?: () => void }> = {
    /* `send` keeps the bar's own idle label — the surface decides whether this
       composer sends to an agent or launches one. */
    send: { label: spawnMode ? t("composer.launchAgent") : t("composer.sendToAgent") },
    stop: { label: t("mobile2.composer.stop"), onAct: () => void stopTurn() },
    queue: { label: t("mobile2.composer.queueAria"), text: t("mobile2.composer.queue") },
    respawn: { label: t("mobile2.composer.respawnAria"), text: t("mobile2.composer.respawn"), onAct: () => void respawnAgent() },
  };

  /* The placeholder says what happens to what is typed, in the same words the
     bar's meta line uses (§4.2's state table). */
  const phonePlaceholder = phoneState === "killed"
    ? t("mobile2.composer.placeholderKilled")
    : runtimeOffline
      ? t("mobile2.composer.placeholderOffline")
      : phoneState === "held"
        ? t("mobile2.composer.placeholderHeld")
        : null;

  const composerBar = (
    <ComposerBar
      composer={composer}
      placeholder={placeholder ?? (isMobile && phonePlaceholder
        ? phonePlaceholder
        : unresolvedOwnership
          ? t("composer.placeholderResolving")
          : relayMode
            ? t("composer.placeholderRelay")
            : spawnMode
              ? t("composer.placeholderSpawn")
              : t("composer.placeholderSend"))}
      sendSlot={isMobile ? { kind: slotKind, busy: slotBusy, ...SLOT[slotKind] } : null}
      textareaAriaLabel={t("composer.textAria")}
      imageAriaLabel={t("composer.addAttachments")}
      sendLabelIdle={spawnMode ? t("composer.launchAgent") : t("composer.sendToAgent")}
      sendLabelRecording={t("composer.stopAndSend")}
      sendTitleRecording={t("composer.stopAndSendTitle")}
      sendIdleClassName="border-accent bg-accent hover:opacity-90"
      sendMenuLabel={t("composer.sendMenuTitle")}
      /* ArrowUp/ArrowDown in an empty composer walk what is queued and what
         was already sent, newest first (issue #561). */
      history={composerHistory}
      voiceControl={voiceEnabled ? (
        <>
          <VoiceConversationButton
            phase={voice.phase}
            start={voice.start}
            stop={voice.stop}
            t={t}
          />
          {/* #691 §5: re-float a call whose window the operator closed. Only while a
              call is up, and only where Document PiP exists — the floater opens
              itself on voice start, so this is the way back, not the way in. It has
              to be a real click: `requestWindow` needs transient user activation. */}
          <VoiceFloatButton phase={voice.phase} t={t} />
        </>
      ) : undefined}
      voicePanel={voiceEnabled && !pipComposerSlot ? (
        /* An empty slot, not a panel: `VoicePipHost` owns the ONE panel rendering
           and portals it here while no floating window is open. While one is,
           the panel lives in the PiP window and this slot stands down. */
        <div ref={publishDockSlot} data-testid="voice-dock-slot" className="flex flex-col" />
      ) : undefined}
      sendMenuActions={
        canQuickAck
          ? [
              {
                id: "quick-ack",
                label: t("composer.quickAckLabel"),
                description: t("composer.quickAck"),
                disabled: quickAckDisabled,
                tone: "ok",
                /* Queue-first like every other submission (finding 5): the ack
                   enqueues behind any active delivery, renders immediately, is
                   cancellable, joins history, and dispatches once — while the
                   operator's typed draft and staged tiles stay put. */
                onSelect: () => queueSubmit(t("composer.quickAck"), { preserveDraft: true }),
              },
            ]
          : []
      }
      showImage={!deadHostBlocksSend}
      /* A dead structured surface can still recover TEXT while its image
         pipeline waits for the host to recover (finding 4): the picker stays
         visible so staged tiles remain removable, and disables with the
         localized recovery reason so an image submission holds until recovery. */
      imageDisabled={structuredImagesDisabled}
      imageDisabledReason={structuredImagesReason}
      sendPayloadAvailable={replayGenerationAvailable}
      sendDisabledReason={deadHostBlocksSend
        ? t("deadHost.sendBlocked")
        : reconcilingSend
          ? t("composer.admissionTimedOut")
          : effectiveSendBlockedReason ?? undefined}
      /* Every blocked state keeps one recovery route (issue #499): Re-check
         forces a fresh runtime snapshot, which resolves an unresolved host,
         surfaces a recovered one, and reconciles a timed-out admission. */
      onSendBlockedRecover={() => void runtimeDependencies.refreshRuntime()}
      receipts={
        displayedRuntimeReceipts.length
          ? <RuntimeComposerReceipts
              receipts={displayedRuntimeReceipts}
              actionsDisabled={busy || voiceSending || deadHostBlocksSend}
              dismissed={dismissedReceipts}
              session={structuredSession
                ? { host: structuredSession.session.host, turn: structuredSession.session.turn }
                : null}
              onRetry={(receipt, mode) => void retryRuntimeReceipt(receipt, mode)}
              onEdit={editRuntimeReceipt}
              onDismiss={dismissReceipts}
              onDiscard={(receipt) => void discardRuntimeReceipt(receipt)}
            />
          : undefined
      }
      leftSlot={
        /* The compact model/reasoning pill (issue #390): lives in the quiet
           bottom row, left of the image picker, on exactly the surfaces the
           capability matrix keeps the runtime control visible. */
        caps.controls.runtime.state !== "hidden" ? (
          <RuntimePill
            file={file}
            surface={caps.surface}
            runtimeSettings={structuredSession?.session.capabilities?.runtimeSettings ?? null}
            runtimeSession={structuredSession?.session ?? null}
          />
        ) : null
      }
    />
  );

  const body = (
    <form
      onSubmit={handleSubmit}
      data-testid={isMobile ? "bounded-mobile-composer" : undefined}
      /* Chat-first mobile budget (issue #419): the phone composer is a single
         input row with its secondary controls folded, so it takes the tighter
         vertical padding — every reclaimed row keeps the transcript above its
         ≥60% viewport share. Desktop keeps the roomier py-2. */
      className={`flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 ${
        isMobile
          ? "max-h-[min(38dvh,20rem)] overflow-x-clip overflow-y-auto overscroll-y-contain py-1.5"
          : "py-2"
      }`}
      aria-label={composerAriaLabel}
    >
      {/* Unmounts exactly when the textarea does (a key-churn remount, an
          adoption flap, a pane-target flap hiding the composer), so its
          deletion pass can still see who held focus. */}
      <ComposerFocusContinuity claimKeys={[cardId, file.path]} />
      {/* Drains the outbox one message at a time (issue #561). Renders nothing;
          the queued bubbles themselves live in the feed above. */}
      <OutboxDispatcher
        entries={outbox}
        ready={!busy && !voiceSending && !reconcilingSend}
        onDispatch={dispatchQueued}
      />
      {/* #844: what the NEXT turn will point at, shown before the operator
          commits to it. Only when a card is actually selected — an explicit
          empty selection is an answer worth persisting on the sent record, but a
          permanent "nothing selected" chip over every composer in the app is
          noise. The transcript row renders the same badge from the same
          component afterwards, so the before and after can be compared. */}
      {liveSelectedContext.state === "selected" ? (
        <div className="flex justify-end">
          <SelectedContextBadge reference={liveSelectedContext} />
        </div>
      ) : null}
      {/* Proactive hold hint: while the card is switching accounts, the next
          send is queued for the successor rather than delivered live. Shown
          identically under the desktop and mobile composers. */}
      {holdsSends ? (
        <div role="status" aria-live="polite" className="flex items-center gap-1.5 rounded-control border border-warning/45 bg-warning-soft px-2 py-1 text-label font-semibold text-warning">
          <ArrowUpToLine className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{t("migrate.heldSend")}</span>
        </div>
      ) : null}
      {sent.length || echoedReceipts.length ? (
        <div className="flex flex-col gap-0.5" aria-label={t("composer.queueAria")}>
          {echoedReceipts.map((receipt) => (
            <div key={receipt.operationId} data-delivery-echo className="flex items-center justify-end gap-1.5">
              <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />
              <span className="sr-only">{t("composer.deliveredEcho")}</span>
              <span
                className="min-w-0 max-w-[85%] truncate text-label text-secondary"
                title={receipt.text ?? undefined}
              >
                {receipt.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-muted">
                {hhmm(Date.parse(receipt.at))}
              </span>
              <button
                type="button"
                aria-label={t("runtime.receipt.dismiss")}
                className={`inline-flex shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "h-11 w-11" : "px-0.5"
                }`}
                onClick={() => dismissReceipts([receipt.operationId])}
              >
                <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
              </button>
            </div>
          ))}
          {sent.map((entry) => {
            const receipt = receiptMeta(t, entry.state);
            return (
            <div key={entry.id} className="flex items-center justify-end gap-1.5">
              {receipt ? (
                <Badge tone={receipt.tone} role="status" aria-live="polite">
                  {receipt.label}
                </Badge>
              ) : null}
              {entry.state === "failed" ? (
                <button
                  type="button"
                  aria-label={t("composer.retrySend")}
                  title={t("composer.retrySend")}
                  disabled={busy || voiceSending}
                  className={`inline-flex shrink-0 items-center justify-center rounded text-muted hover:text-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    isMobile ? "h-11 w-11" : "px-0.5"
                  }`}
                  onClick={() => {
                    void send(entry.text, { receiptId: entry.id, clientMessageId: entry.clientMessageId });
                  }}
                >
                  <RotateCcw className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
                </button>
              ) : null}
              <span
                className="min-w-0 max-w-[85%] truncate text-label text-secondary"
                title={entry.text}
              >
                {entry.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-caption tabular-nums text-muted">
                {entry.via === "spawn" ? <Play className="h-2.5 w-2.5" aria-hidden /> : <ArrowRight className="h-2.5 w-2.5" aria-hidden />}
                {hhmm(entry.at)}
              </span>
              <button
                type="button"
                aria-label={t("composer.removeFromQueue")}
                className={`inline-flex shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  isMobile ? "h-11 w-11" : "px-0.5"
                }`}
                onClick={() => persistSent(sent.filter((item) => item.id !== entry.id))}
              >
                <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
              </button>
            </div>
            );
          })}
        </div>
      ) : null}
      {pipComposerSlot
        ? /* Floating (#691): the SAME ComposerBar, moved into the PiP window
             through the slot the host published. The wrapper form re-creates the
             submit surface the card's form provides here — the handler is the
             identical `handleSubmit`, so there is still exactly one send path. */
          createPortal(
            <form
              onSubmit={handleSubmit}
              aria-label={composerAriaLabel}
              className="flex flex-col gap-1.5"
            >
              {composerBar}
            </form>,
            pipComposerSlot,
          )
        : composerBar}
    </form>
  );

  /* Inline for a card that owns its composer; portalled into the card's slot for
     a hoisted one; parked hidden — mounted, draining, recording — when the card
     is gone mid-call. The `hidden` container is what keeps a dictation, a staged
     image's object URL and the outbox dispatcher alive across board navigation. */
  if (dockNode === undefined) return body;
  return dockNode
    ? createPortal(body, dockNode)
    : <div hidden data-testid="voice-composer-parked">{body}</div>;
}
