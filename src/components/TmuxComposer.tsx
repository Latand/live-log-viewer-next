"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, Check, ChevronRight, Loader2, Play, X } from "@/components/icons";
import { RotateCcw } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useCodexRealtime } from "@/hooks/useCodexRealtime";
import { refreshRuntime, sendRuntimeMessage, useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import { conversationIdentity } from "@/lib/accounts/identity";
import { cardMigrationState, migrationHoldsSends } from "@/lib/accounts/migration";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

import { ComposerBar } from "./ComposerBar";
import { OutboxDispatcher } from "./conversation/OutboxDispatcher";
import {
  adoptOutbox,
  cancelOutbox,
  enqueueOutbox,
  outboxHistory,
  outboxStateForReceiptStatus,
  transcriptEchoCount,
  updateOutbox,
  useOutbox,
  useTranscriptEchoes,
  type OutboxEntry,
  type OutboxState,
} from "./conversation/outbox";
import {
  COMPOSER_ADMISSION_DEADLINE_MS,
  COMPOSER_RECEIPT_POLL_INTERVAL_MS,
  COMPOSER_RECEIPT_RECONCILIATION_MS,
  ComposerAdmissionTimeoutError,
  reconcileComposerReceipt,
  withComposerAdmissionDeadline,
} from "./composerAdmissionDeadline";
import { RuntimePill } from "./RuntimePill";
import { savedResumeProfile, sendRuntimeFrom, type RuntimeProfile } from "./runtimeProfile";
import { type PendingImage } from "./imageAttachments";
import { ReceiptChip, runtimeReceiptStatusText } from "./runtime/ReceiptChip";
import {
  deliveryAttemptGroups,
  deliveryEchoes,
  deliveryProblem,
  dismissedReceiptsKey,
  readDismissedReceipts,
  visibleStandaloneReceipts,
  withDismissedReceipts,
  writeDismissedReceipts,
} from "./runtime/deliveryState";
import { mintIdempotencyKey, receiptIsAdmitted, receiptIsTerminal } from "./runtime/runtimeModel";
import { useAgentCapabilities } from "./useAgentCapabilities";
import { VoiceConversationButton, VoiceConversationPanel } from "./VoiceConversation";

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
  onRetry,
  onEdit,
  onDismiss,
}: {
  receipts: RuntimeReceipt[];
  actionsDisabled?: boolean;
  /** Operation ids the user dismissed (issue #264 rule 3): settled problems in
      this set stay hidden; a still-moving attempt always renders. */
  dismissed?: ReadonlySet<string>;
  onRetry: (receipt: RuntimeReceipt) => void;
  onEdit: (receipt: RuntimeReceipt) => void;
  /** Persists a dismissal — receives every settled operation id of the row. */
  onDismiss?: (operationIds: string[]) => void;
}) {
  const { t } = useLocale();
  const statusId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isMessage = (receipt: RuntimeReceipt) => receipt.kind === "send" || receipt.kind === "steer";
  const editable = (receipt: RuntimeReceipt) => isMessage(receipt)
    && (receipt.status === "failed" || receipt.status === "rejected")
    && typeof receipt.text === "string"
    && receipt.text.length > 0
    && receipt.text.length < 240;
  /* Visibility and grouping live in the delivery-state model (issue #264):
     resolved successes render nothing (the feed bubble is the receipt), a
     group superseded by a successful resend of the same text goes quiet, and
     dismissed settled problems stay dismissed. */
  const attemptGroups = deliveryAttemptGroups(receipts, dismissed);
  const visibleAttempts = attemptGroups.flatMap((group) => group.attempts);
  const supersededStatusLabels = (attempts: RuntimeReceipt[]): string[] => {
    const counts = new Map<string, number>();
    for (const attempt of attempts.slice(1)) {
      const label = runtimeReceiptStatusText(t, attempt);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  };
  const standaloneReceipts = visibleStandaloneReceipts(receipts, dismissed);
  const pendingReceipts = visibleAttempts.filter((receipt) => !receiptIsTerminal(receipt.status));
  const problemReceipts = visibleAttempts.filter((receipt) => deliveryProblem(receipt.status));
  const busyRetry = pendingReceipts.some((receipt) => typeof receipt.reason === "string" && RECOVERABLE_BUSY_RETRY_REASONS.has(receipt.reason));
  const receiptSummaryLabel = t("runtime.receipt.summary", { count: visibleAttempts.length });
  const disclosureLabel = t(detailsOpen ? "runtime.receipt.hideDetails" : "runtime.receipt.showDetails");

  return (
    <>
      {visibleAttempts.length ? (
        <>
          {/* `open` is controlled: the details element can unmount while all
              message receipts are resolved and remount for the next attempt,
              and the disclosure label must keep matching the real element. */}
          <details
            className="group w-full min-w-0 rounded-control border border-border bg-sunken/55 text-caption text-secondary"
            data-runtime-receipt-stack
            open={detailsOpen}
            onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          >
            <summary
              aria-describedby={statusId}
              aria-label={`${disclosureLabel}. ${receiptSummaryLabel}`}
              className="flex min-h-11 max-h-11 cursor-pointer list-none items-center gap-1 overflow-hidden rounded-control px-1.5 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight className="h-3 w-3 shrink-0 text-muted transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
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
                {problemReceipts.length ? (
                  <Badge
                    tone="danger"
                    data-receipt-problem-count
                    aria-label={t("runtime.receipt.problemCount", { count: problemReceipts.length })}
                    title={t("runtime.receipt.problemCount", { count: problemReceipts.length })}
                  >
                    <span aria-hidden>!</span>
                    <span className="sr-only">{t("runtime.receipt.problemCount", { count: problemReceipts.length })}</span>
                    <span aria-hidden data-receipt-count-value>{problemReceipts.length}</span>
                  </Badge>
                ) : null}
              </span>
            </summary>
            <div
              className="max-h-36 space-y-1 overflow-y-auto border-t border-border/70 p-1.5"
              data-runtime-receipt-details
            >
              {attemptGroups.map((group) => {
                const receipt = group.current;
                const history = supersededStatusLabels(group.attempts);
                const failed = receipt.status === "failed";
                const pending = !receiptIsTerminal(receipt.status);
                const retryingBusy = pending
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
                        actionsDisabled={actionsDisabled}
                        onRetry={failed ? () => onRetry(receipt) : undefined}
                        onEdit={editable(receipt) ? () => onEdit(receipt) : undefined}
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
                      {receipt.status === "pending" ? (
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
            {` ${attemptGroups
              .map((group) => [runtimeReceiptStatusText(t, group.current), ...supersededStatusLabels(group.attempts)].join(" · "))
              .join(". ")}.`}
            {busyRetry ? ` ${t("runtime.receipt.busyRetry")}` : null}
          </span>
        </>
      ) : null}
      {standaloneReceipts.map((receipt) => {
        const failed = receipt.status === "failed";
        return (
          <span key={receipt.operationId} className="inline-flex items-center gap-1">
            <ReceiptChip
              receipt={receipt}
              actionsDisabled={actionsDisabled}
              onRetry={isMessage(receipt) && failed ? () => onRetry(receipt) : undefined}
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
  /** Runtime selection frozen with the first request under this key. */
  runtime?: RuntimeProfile;
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
      sessionStorage.setItem(pendingSendKey(id), JSON.stringify(pending.map(({ key, text, images, runtime, runtimeCaptured, reconciling, payloadComplete, operationId }) => ({
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
        ...(payloadComplete === false ? { payloadComplete: false } : {}),
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
      for (const keyOf of [draftKey, draftImagesKey, pendingSendKey, sentKey, dismissedReceiptsKey]) {
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

/**
 * Chat-style composer pinned under the feed. A live pane gets the text typed
 * straight into its tmux pane; a finished resumable conversation boots a new
 * agent window in the current tmux session with the text as the first prompt.
 * Sent messages stay visible as a queue above the input until dismissed.
 */
export function TmuxComposer({
  file,
  pollPaused = false,
  deadHost = false,
  sendBlockedReason = null,
}: {
  file: FileEntry;
  pollPaused?: boolean;
  deadHost?: boolean;
  /** Localized reason Send is inert on a non-dead surface (e.g. the host is
      still unresolved under the runtime plane — issue #241 finding 1). No POST
      is attempted while it is set, so no /api/tmux request can fire against an
      as-yet-unclassified host. */
  sendBlockedReason?: string | null;
}) {
  const { t } = useLocale();
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
  const { caps, structuredSession } = useAgentCapabilities(file);
  const voiceEnabled = cardId.startsWith("conversation_")
    && structuredSession?.session.hostKind === "codex-app-server"
    && structuredSession.session.host === "hosted";
  const voice = useCodexRealtime(
    cardId,
    voiceEnabled,
    structuredSession?.session.liveTurn?.text ?? "",
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
     pretending the text reached the live predecessor pane. */
  const holdsSends = migrationHoldsSends(cardMigrationState(file.migration));
  /* An off-screen or far-zoom pane skips the pane-resolution poll; the last
     known target keeps the composer usable the moment it comes back. */
  const target = useTmuxTarget(file.pid, canMessageWithoutPane(file) ? file.path : undefined, !pollPaused);
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
    /* Queue-first (issue #561): a submitted message lives in the durable
       outbox, so the field never locks behind an in-flight delivery. */
    holdInputWhileBusy: false,
  });
  const { text, textRef, setText, setTextState, inputRef, setStatus, busy, setBusy, voiceSending, attachments } = composer;
  const attachmentDraftHydrated = useRef(false);
  const isMobile = useIsMobile();
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
  /* Per-idempotency-key snapshot of the runtime settings a structured send
     carries (issue #390 §10): a same-key replay must re-send *identical*
     settings — a pill selection made between attempts changes only the NEXT
     message, and a drifted payload would 409 the idempotent replay. Bounded,
     newest last. */
  const runtimeSendSnapshots = useRef<Map<string, RuntimeProfile | undefined>>(new Map());
  /* Durable receipts for this session from the runtime bus (empty while the bus
     is disabled or the session is legacy/unhosted). */
  const runtimeReceipts = useRuntimeReceiptsForArtifact(file.path, cardId);
  const displayedRuntimeReceipts = mergeRuntimeReceipts(runtimeReceipts, immediateRuntimeReceipts);
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
      refresh: refreshRuntime,
      late: lateReceipt,
      timeoutMs: COMPOSER_RECEIPT_RECONCILIATION_MS,
      pollIntervalMs: COMPOSER_RECEIPT_POLL_INTERVAL_MS,
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
    /* Replay ownership survives independently from the editable draft. The
       next submit resolves the oldest unresolved generation first while text
       and attachments prepared for a later turn remain in the composer. */
    const draftNow = typeof window !== "undefined" ? sessionStorage.getItem(draftKey(cardId)) ?? "" : "";
    const resumable = restoredPending.find((entry) => entry.payloadComplete !== false);
    const draftImages = readDraftImages(cardId);
    attachmentDraftHydrated.current = false;
    const trayImages = draftImages ?? (resumable?.text === draftNow ? resumable.images : []);
    const restoredImages = attachments.replace(trayImages.map((image) => ({ ...image })));
    queueMicrotask(() => { attachmentDraftHydrated.current = true; });
    if (resumable && restoredImages) {
      idempotencyKey.current = resumable.key;
      if (resumable.runtimeCaptured) runtimeSendSnapshots.current.set(resumable.key, resumable.runtime);
    }
    const reconcilingKeys = restoredPending.filter((entry) => entry.reconciling).map((entry) => entry.key);
    const hasIncompletePayload = restoredPending.some((entry) => entry.payloadComplete === false);
    setReconcilingSend(reconcilingKeys.length > 0 || hasIncompletePayload);
    if (reconcilingKeys.length || hasIncompletePayload) setStatus({ kind: "err", text: t("composer.admissionTimedOut") });
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
        updateOutbox(cardId, settlement.entry.key, { state, settledAt: nowMs() });
      } else {
        const next = draftAfterDelivery(textRef.current, settlement.text);
        if (next !== textRef.current) setText(next);
      }
      attachments.settleDelivered(settlement.entry.images);
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
      const next = outboxStateForReceiptStatus(receipt.status);
      if (next === entry.state) continue;
      /* A failed bubble only advances on PROVEN admission — never on another
         failure, and never to "delivering" off an unproven receipt. */
      if (entry.state === "failed" && !(next === "delivered" || (next === "delivering" && receiptIsAdmitted(receipt.status)))) continue;
      updateOutbox(cardId, entry.id, { state: next, settledAt: nowMs() });
    }
  }, [displayedRuntimeReceipts, outbox, cardId]);

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
     current draft — the quick-ack (finding 5). It carries no attachments, mints
     its OWN idempotency key (leaving the draft's key intact), and leaves the
     composer's typed text and staged tiles exactly where they were. */
  const queueSubmit = (overrideText?: string, options?: { preserveDraft?: boolean }) => {
    const preserveDraft = options?.preserveDraft ?? false;
    const requestedText = overrideText ?? textRef.current;
    const requestedImages: PendingImage[] = preserveDraft ? [] : attachments.imagesRef.current.map((image) => ({ ...image }));
    if (voiceSending || reconcilingSend) return;
    if (!requestedText.trim() && !requestedImages.length) return;
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
    /* The entry owns the idempotency key of its generation; the composer mints
       a fresh one straight away so the next message is a different generation
       even if it is submitted before this one leaves. A `preserveDraft` ack takes
       its own fresh key and does not disturb the draft's pending key. */
    const clientMessageId = preserveDraft ? mintIdempotencyKey() : idempotencyKey.current;
    if (!preserveDraft) idempotencyKey.current = mintIdempotencyKey();
    outboxImages.current.set(clientMessageId, requestedImages);
    outboxKeys.current.add(clientMessageId);
    enqueueOutbox(cardId, {
      id: clientMessageId,
      text: requestedText,
      images: requestedImages.length,
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
    /** Records a queued submission's fate on the queue itself. A no-op for a
        direct (non-queued) send, which reports through the status line. The
        bubble takes the state the receipt PROVES: a bare admission stays
        `delivering`, only a delivered receipt reads `delivered` (round-1 P1#4). */
    const settleOutbox = (state: OutboxState, error?: string) => {
      if (!outboxId) return;
      updateOutbox(cardId, outboxId, { state, settledAt: nowMs(), ...(error ? { error } : {}) });
      if (state === "delivered") outboxImages.current.delete(outboxId);
    };
    const settleOutboxFromReceipt = (receipt: RuntimeReceipt) => settleOutbox(outboxStateForReceiptStatus(receipt.status));
    /* Resolve the key before selecting the payload. A generation retained after
       uncertain admission owns an immutable text/image snapshot; later edits
       stay in the composer for the following generation while an explicit
       submit replays the original bytes under the original key. */
    const clientMessageId = deliveryAttemptKey(idempotencyKey.current, retry?.clientMessageId);
    const replayGeneration = pendingDeliveries.current.find((entry) => entry.key === clientMessageId);
    const payloadText = replayGeneration?.text ?? requestedText;
    const sentImages: PendingImage[] = replayGeneration
      ? replayGeneration.images.map((image) => ({ ...image }))
      : requestedImages;
    if (!payloadText.trim() && !sentImages.length) {
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
          ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
          ...(capturesRuntime ? { runtimeCaptured: true as const } : {}),
        },
        ...pendingDeliveries.current,
      ].slice(0, PENDING_DELIVERY_LIMIT));
    }
    /* Clear exactly this settled generation: its text prefix leaves the draft
       (later typing survives) and its attachment snapshot leaves the tray
       (later images survive). At most once per key — a replayed receipt for an
       already-settled generation must not touch what the user typed since. */
    const settleGeneration = (clearedText: string, snapshot: readonly PendingImage[]) => {
      if (settledSendKeys.current.has(clientMessageId)) return;
      markSettled(clientMessageId);
      /* A queued generation left the composer when it was submitted; clearing
         the draft here would eat text prepared for the next message. */
      if (!outboxId) setText(draftAfterDelivery(textRef.current, clearedText));
      attachments.settleDelivered(snapshot);
    };
    const settleLegacySuccess = (result: ComposerSendResult) => {
      if (settledSendKeys.current.has(clientMessageId)) return;
      const imgCount = sentImages.length;
      const held = result.outcome === "held" || result.outcome === "queued" || result.outcome === "recovering";
      const at = nowMs();
      const entry: SentEntry = {
        id: at,
        text: payloadText.trim() || (imgCount ? t("composer.imagesCount", { count: imgCount }) : ""),
        at,
        via: result.outcome === "resumed" || result.spawned ? "spawn" : "pane",
        state: held ? (result.outcome as DeliveryReceiptState) : "sent",
        clientMessageId,
      };
      const prior = retry ? sent.filter((item) => item.id !== retry.receiptId) : sent;
      persistSent([...prior, entry].slice(-SENT_LIMIT));
      const attempt = pendingDeliveries.current.find((candidate) => candidate.key === clientMessageId);
      persistPendingDeliveries(pendingDeliveries.current.filter((candidate) => candidate.key !== clientMessageId));
      setImmediateRuntimeReceipts((current) => current.filter((candidate) =>
        candidate.idempotencyKey !== clientMessageId
        && candidate.operationId !== unconfirmedReceiptOperationId(clientMessageId)));
      if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
      settleGeneration(payloadText, attempt?.images ?? sentImages);
      /* A legacy pane send that reached the pane is delivered; a migration
         hold/queue is still in flight to the successor (round-1 P1#4). */
      settleOutbox(held ? "delivering" : "delivered");
      setStatus({
        kind: held ? "info" : "ok",
        text: held
          ? t("composer.deliveryHeld", { label: file.migration?.targetLabel ?? file.migration?.targetAccountId ?? "" })
          : result.outcome === "resumed" || result.spawned
            ? t("composer.spawned", { target: result.target ?? "" })
            : result.imagePaths?.length
              ? t("composer.sentPaths", { count: result.imagePaths.length })
              : t("common.sent"),
      });
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
          : sendRuntimeMessage({
              conversationId: structuredSession.session.conversationId,
              text: payloadText.trim(),
              images: sentImages.map((image) => ({ base64: image.base64, mime: image.mime })),
              idempotencyKey: clientMessageId,
              policy: "interrupt-active",
              ...(runtimeOverride ? { runtime: runtimeOverride } : {}),
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
              /* The "on resume" profile (issue #241 §4): when this send reopens a
                 finished root conversation, boot it with the model/effort the
                 strip's picker saved. Ignored for a live pane or a subagent relay. */
              ...(legacyResumeRuntime ? runtimeOverride ?? {} : {}),
            }),
          }).then(async (response) => {
            const body = await response.json() as ComposerSendResult;
            return { ...body, status: response.status, ok: response.ok && body.ok === true };
          }));
      const json = await withComposerAdmissionDeadline(admissionRequest, COMPOSER_ADMISSION_DEADLINE_MS);
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
            settleGeneration(admitted, attempt?.images ?? sentImages);
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
        settleGeneration(payloadText, attempt?.images ?? sentImages);
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
    updateOutbox(cardId, entry.id, { state: "delivering" });
    outboxKeys.current.add(entry.id);
    void send(entry.text, { clientMessageId: entry.id }, entry.id);
  };

  const retryRuntimeReceipt = async (receipt: RuntimeReceipt) => {
    if (busy || voiceSending) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/runtime/operations/${encodeURIComponent(receipt.operationId)}`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { receipt?: RuntimeReceipt; error?: string };
      if (!response.ok || !body.receipt) {
        setStatus({ kind: "err", text: body.error ?? t("common.failedSend") });
        return;
      }
      setImmediateRuntimeReceipts((current) => [
        body.receipt!,
        ...current.filter((candidate) => candidate.operationId !== body.receipt!.operationId),
      ].slice(0, 8));
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

  return (
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
      aria-label={structuredSession
        ? t("composer.sendStructuredAria")
        : unresolvedOwnership
          ? t("composer.resolvingAria")
          : spawnMode
            ? t("composer.spawnAria")
            : t("composer.sendAria", { target: target ?? "" })}
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
      <ComposerBar
        composer={composer}
        placeholder={unresolvedOwnership
          ? t("composer.placeholderResolving")
          : relayMode
            ? t("composer.placeholderRelay")
            : spawnMode
              ? t("composer.placeholderSpawn")
              : t("composer.placeholderSend")}
        textareaAriaLabel={t("composer.textAria")}
        imageAriaLabel={t("composer.addImages")}
        sendLabelIdle={spawnMode ? t("composer.launchAgent") : t("composer.sendToAgent")}
        sendLabelRecording={t("composer.stopAndSend")}
        sendTitleRecording={t("composer.stopAndSendTitle")}
        sendIdleClassName="border-accent bg-accent hover:opacity-90"
        sendMenuLabel={t("composer.sendMenuTitle")}
        /* ArrowUp/ArrowDown in an empty composer walk what is queued and what
           was already sent, newest first (issue #561). */
        history={composerHistory}
        voiceControl={voiceEnabled ? (
          <VoiceConversationButton
            phase={voice.phase}
            start={voice.start}
            stop={voice.stop}
            t={t}
          />
        ) : undefined}
        voicePanel={voiceEnabled ? (
          <VoiceConversationPanel
            phase={voice.phase}
            lines={voice.lines}
            error={voice.error}
            t={t}
          />
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
        onSendBlockedRecover={() => void refreshRuntime()}
        receipts={
          displayedRuntimeReceipts.length
            ? <RuntimeComposerReceipts
                receipts={displayedRuntimeReceipts}
                actionsDisabled={busy || voiceSending || deadHostBlocksSend}
                dismissed={dismissedReceipts}
                onRetry={(receipt) => void retryRuntimeReceipt(receipt)}
                onEdit={editRuntimeReceipt}
                onDismiss={dismissReceipts}
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
    </form>
  );
}
