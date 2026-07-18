"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, Check, ChevronRight, Loader2, Play, X } from "@/components/icons";
import { RotateCcw } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { sendRuntimeMessage, useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import { conversationIdentity } from "@/lib/accounts/identity";
import { cardMigrationState, migrationHoldsSends } from "@/lib/accounts/migration";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

import { savedResumeProfile } from "./AgentRuntimeControls";
import { ComposerBar } from "./ComposerBar";
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

const SENT_LIMIT = 8;
const SPAWN_TTL_MS = 90_000;
const PANE_TTL_MS = 10 * 60_000;
const RECOVERABLE_BUSY_RETRY_REASONS = new Set(["delivery-auto-retry", "interrupt-auto-retry"]);
const sentKey = (id: string) => "llvSent:" + id;

export function deliveryAttemptKey(current: string, stored?: string): string {
  return stored || current;
}

export function mergeRuntimeReceipts(
  runtimeReceipts: RuntimeReceipt[],
  immediateReceipts: RuntimeReceipt[],
): RuntimeReceipt[] {
  type RetryAwareReceipt = RuntimeReceipt & { retryOfOperationId?: string | null };
  const retryParent = (receipt: RuntimeReceipt): string | null =>
    (receipt as RetryAwareReceipt).retryOfOperationId ?? null;
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
    let ancestor = retryParent(receipt);
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
      ancestor = retryParent(parent);
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
}

const PENDING_DELIVERY_LIMIT = 8;
const SETTLED_SEND_KEY_LIMIT = 32;

/** Text-only projection persisted per conversation so an unsettled generation
    survives a composer remount or a full page refresh (the attachment snapshot
    is memory-only — previews don't survive a refresh either). */
const pendingSendKey = (id: string) => "llvPendingSend:" + id;

export function readPendingDeliveries(id: string): PendingDelivery[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(pendingSendKey(id)) ?? "[]") as { key?: unknown; text?: unknown }[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is { key: string; text: string } =>
        Boolean(entry) && typeof entry.key === "string" && typeof entry.text === "string")
      .slice(0, PENDING_DELIVERY_LIMIT)
      .map((entry) => ({ key: entry.key, text: entry.text, images: [] }));
  } catch {
    return [];
  }
}

export function writePendingDeliveries(id: string, pending: readonly PendingDelivery[]): void {
  try {
    if (pending.length) {
      sessionStorage.setItem(pendingSendKey(id), JSON.stringify(pending.map(({ key, text }) => ({ key, text }))));
    } else {
      sessionStorage.removeItem(pendingSendKey(id));
    }
  } catch { /* quota/opaque-origin: the in-memory generation still settles */ }
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
  for (const receipt of receipts) {
    if (!receiptIsAdmitted(receipt.status)) continue;
    const current = admittedByKey.get(receipt.idempotencyKey);
    if (!current || (receipt.status === "delivered" && current.status !== "delivered")) {
      admittedByKey.set(receipt.idempotencyKey, receipt);
    }
  }
  const settled: { entry: PendingDelivery; text: string }[] = [];
  const remaining: PendingDelivery[] = [];
  for (const entry of pending) {
    const receipt = admittedByKey.get(entry.key);
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

/** Removes one attachment per delivered snapshot entry (matched by content,
    not position), so attachments added while the send was in flight survive. */
export function attachmentsAfterDelivery(
  current: readonly PendingImage[],
  delivered: readonly PendingImage[],
): PendingImage[] {
  const remaining = [...current];
  for (const sent of delivered) {
    const index = remaining.findIndex((image) => image.base64 === sent.base64 && image.mime === sent.mime);
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
      for (const keyOf of [draftKey, pendingSendKey, sentKey, dismissedReceiptsKey]) {
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
  const keysSignature = keys.join(" ");
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
  const structuredImageCapability = structuredSession?.session.capabilities?.imageInput;
  const structuredImagesDisabled = Boolean(structuredSession && !structuredImageCapability?.supported);
  const structuredImagesReason = structuredImagesDisabled
    ? t("composer.structuredImagesProtocol")
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
      return sessionStorage.getItem(draftKey(cardId)) ?? "";
    },
    persistText: (value) => {
      if (value) sessionStorage.setItem(draftKey(cardId), value);
      else sessionStorage.removeItem(draftKey(cardId));
    },
    submit: (overrideText) => send(overrideText),
    imageCapability: structuredSession ? structuredImageCapability ?? null : null,
  });
  const { text, textRef, setText, setTextState, inputRef, setStatus, busy, setBusy, voiceSending, attachments } = composer;
  const isMobile = useIsMobile();
  /* Interrupt / compact / attach-terminal / mode chip moved into the unified
     control strip (issue #241) — the composer keeps only the message surface
     (text, images, mic, send) and its delivery receipts. */
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [immediateRuntimeReceipts, setImmediateRuntimeReceipts] = useState<RuntimeReceipt[]>([]);
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
  /* Durable receipts for this session from the runtime bus (empty while the bus
     is disabled or the session is legacy/unhosted). */
  const runtimeReceipts = useRuntimeReceiptsForArtifact(file.path, cardId);
  const displayedRuntimeReceipts = mergeRuntimeReceipts(runtimeReceipts, immediateRuntimeReceipts);
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
  const echoedReceipts = deliveryEchoes(displayedRuntimeReceipts, file.mtime * 1000, dismissedReceipts, nowMs());

  const persistPendingDeliveries = (next: PendingDelivery[]) => {
    pendingDeliveries.current = next;
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

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    /* Identity enrichment without a remount (a poll fills in the conversation
       id while this instance stays mounted): move the persisted records onto
       the new key before re-reading them. */
    adoptComposerState(file.path, cardId);
    setSent(readSent(cardId));
    setImmediateRuntimeReceipts([]);
    setDismissedReceiptIds(readDismissedReceipts(cardId));
    pendingDeliveries.current = readPendingDeliveries(cardId);
    settledSendKeys.current = new Set();
    /* Keyed by identity alone: a path migration under a stable id must not
       wipe the immediate receipts or the settled-key memory (`file.path` is
       only read to adopt records the old identity left behind). */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /* Settle submitted generations against the receipt stream: a durably
     admitted receipt (queued or beyond) for a remembered key means the server
     holds that attempt, so its exact text leaves the draft (later typing
     survives; a rewritten draft for the next turn stays untouched). Runs on
     mount too, so a refresh snapshot reconciles a persisted generation. */
  useEffect(() => {
    if (!pendingDeliveries.current.length) return;
    const { settled, remaining } = settlePendingDeliveries(pendingDeliveries.current, displayedRuntimeReceipts);
    if (!settled.length) return;
    persistPendingDeliveries(remaining);
    let remainingImages: readonly PendingImage[] = attachments.imagesRef.current;
    for (const settlement of settled) {
      markSettled(settlement.entry.key);
      const next = draftAfterDelivery(textRef.current, settlement.text);
      if (next !== textRef.current) setText(next);
      remainingImages = attachmentsAfterDelivery(remainingImages, settlement.entry.images);
      /* The admitted attempt consumed its key: minting a fresh one keeps the
         next message from being replay-deduped into silence server-side. */
      if (settlement.entry.key === idempotencyKey.current) idempotencyKey.current = mintIdempotencyKey();
    }
    if (remainingImages.length !== attachments.imagesRef.current.length) attachments.replace([...remainingImages]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setText/textRef/attachments are hook-stable
  }, [displayedRuntimeReceipts]);

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
  // otherwise treat as resumable and let POST /api/tmux (finding 2). Dead and
  // unresolved hosts keep a *disabled* Send (not hidden), so their composer stays
  // visible-but-blocked via `deadHost`/`sendBlockedReason`.
  if (caps.controls.send.state === "hidden") return null;
  const resumable = canMessageWithoutPane(file);
  if (target === null && !resumable) return null;
  const spawnMode = target === null && !structuredSession;
  const relayMode = spawnMode && file.root === "claude-projects" && file.kind === "subagent";

  const persistSent = (next: SentEntry[]) => {
    setSent(next);
    sessionStorage.setItem(sentKey(cardId), JSON.stringify(next));
  };

  const send = async (overrideText?: string, retry?: { receiptId: number; clientMessageId?: string }) => {
    const payloadText = overrideText ?? text;
    /* The generation snapshot: exactly the text and attachments this attempt
       carries onto the wire. Read through the ref so a submit racing a paste
       still sends and later clears the same set. */
    const sentImages: PendingImage[] = attachments.imagesRef.current.map((image) => ({ ...image }));
    if (busy || voiceSending || (!payloadText.trim() && !sentImages.length)) return;
    /* Dead host (§5): the draft survives but no POST is attempted, so no new
       `rejected: dead-host` receipts can stack. The banner is the single source
       of the bad news; the composer only says why Send is inert. */
    if (deadHost) {
      setStatus({ kind: "err", text: t("deadHost.sendBlocked") });
      return;
    }
    /* Host not yet resolved under the runtime plane: block the POST so a
       structured/dead conversation is never sent to via the legacy /api/tmux
       path before its real host capability arrives (finding 1). */
    if (sendBlockedReason) {
      setStatus({ kind: "err", text: sendBlockedReason });
      return;
    }
    if (structuredSession && sentImages.length && !attachments.validate()) return;
    setBusy(true);
    setStatus(null);
    /* Idempotency key: the backend can dedupe a retried held/failed delivery
       against this id so the successor never receives the same prompt twice. */
    const clientMessageId = deliveryAttemptKey(idempotencyKey.current, retry?.clientMessageId);
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
        { key: clientMessageId, text: payloadText, images: sentImages },
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
      setText(draftAfterDelivery(textRef.current, clearedText));
      attachments.replace(attachmentsAfterDelivery(attachments.imagesRef.current, snapshot));
    };
    try {
      const json: {
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
      } = structuredSession
        ? !reachesWire
          ? { ok: false, structured: true, error: structuredImagesReason }
          : await sendRuntimeMessage({
              conversationId: structuredSession.session.conversationId,
              text: payloadText.trim(),
              images: sentImages.map((image) => ({ base64: image.base64, mime: image.mime })),
              idempotencyKey: clientMessageId,
              policy: "interrupt-active",
            }).then((result) => ({
              ok: result.ok,
              structured: true,
              error: result.error,
              status: result.status,
              receipt: result.receipt,
              outcome: result.receipt?.status === "delivering" || result.receipt?.status === "delivered"
                ? result.receipt.status
                : "queued",
            }))
        : await fetch("/api/tmux", {
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
              ...(spawnMode && !relayMode ? resumeProfileBody(file) : {}),
            }),
          }).then(async (response) => {
            const body = await response.json() as typeof json;
            return { ...body, status: response.status, ok: response.ok && body.ok === true };
          });
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
            if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey();
            if (receipt.status === "delivered") setStatus({ kind: "ok", text: t("common.sent") });
            inputRef.current?.focus();
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
        inputRef.current?.focus();
        return;
      }
      const imgCount = sentImages.length;
      // The migration delivery fence returns `held`/`queued`/`recovering` when
      // the text was accepted for the successor rather than delivered live. Those
      // are durable acknowledgements (the backend persisted the message), so the
      // draft clears but the receipt tracks the pending state until it resolves.
      const held = json.outcome === "held" || json.outcome === "queued" || json.outcome === "recovering";
      const at = nowMs();
      const entry: SentEntry = {
        id: at,
        text: payloadText.trim() || (imgCount ? t("composer.imagesCount", { count: imgCount }) : ""),
        at,
        via: json.outcome === "resumed" || json.spawned ? "spawn" : "pane",
        state: held ? (json.outcome as DeliveryReceiptState) : "sent",
        clientMessageId,
      };
      const prior = retry ? sent.filter((item) => item.id !== retry.receiptId) : sent;
      persistSent([...prior, entry].slice(-SENT_LIMIT));
      const attempt = pendingDeliveries.current.find((candidate) => candidate.key === clientMessageId);
      persistPendingDeliveries(pendingDeliveries.current.filter((candidate) => candidate.key !== clientMessageId));
      if (idempotencyKey.current === clientMessageId) idempotencyKey.current = mintIdempotencyKey(); // next draft is a new message
      settleGeneration(payloadText, attempt?.images ?? sentImages);
      setStatus({
        kind: held ? "info" : "ok",
        text: held
          ? t("composer.deliveryHeld", { label: file.migration?.targetLabel ?? file.migration?.targetAccountId ?? "" })
          : json.outcome === "resumed" || json.spawned
            ? t("composer.spawned", { target: json.target ?? "" })
            : json.imagePaths?.length
              ? t("composer.sentPaths", { count: json.imagePaths.length })
              : t("common.sent"),
      });
      inputRef.current?.focus();
    } catch {
      /* The request died on the wire AFTER the server may have accepted it.
         The pre-flight record (text AND attachment snapshot) stays armed so a
         late admission receipt still clears exactly what was sent. A stale
         death racing a faster durable admission reports nothing — the receipt
         stack already tells the truth. */
      if (!settledSendKeys.current.has(clientMessageId)) {
        setStatus({ kind: "err", text: t("common.serverUnavailable") });
      }
    } finally {
      setBusy(false);
    }
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
  };

  /* Mode chip, interrupt, compact, and attach-terminal now live in the unified
     control strip (issue #241); the composer no longer renders them. */

  /* The main send surface is inert on a dead host (§5) or an unresolved host
     (finding 1); quick-ack calls the same `send()`, so it must obey the same
     block — otherwise the menu offers a control whose POST the inner guard
     silently swallows (round-3 finding). Blocked ⇒ the action leaves the menu
     entirely, so neither pointer nor keyboard can reach an enabled quick-ack. */
  const sendBlocked = deadHost || Boolean(sendBlockedReason);
  const canQuickAck = (!spawnMode || relayMode) && !sendBlocked;
  const quickAckDisabled = busy || voiceSending || attachments.images.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 py-2"
      aria-label={structuredSession ? t("composer.sendStructuredAria") : spawnMode ? t("composer.spawnAria") : t("composer.sendAria", { target: target ?? "" })}
    >
      {/* Unmounts exactly when the textarea does (a key-churn remount, an
          adoption flap, a pane-target flap hiding the composer), so its
          deletion pass can still see who held focus. */}
      <ComposerFocusContinuity claimKeys={[cardId, file.path]} />
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
        placeholder={relayMode ? t("composer.placeholderRelay") : spawnMode ? t("composer.placeholderSpawn") : t("composer.placeholderSend")}
        textareaAriaLabel={t("composer.textAria")}
        imageAriaLabel={t("composer.addImages")}
        sendLabelIdle={spawnMode ? t("composer.launchAgent") : t("composer.sendToAgent")}
        sendLabelRecording={t("composer.stopAndSend")}
        sendTitleRecording={t("composer.stopAndSendTitle")}
        sendIdleClassName="border-accent bg-accent hover:opacity-90"
        sendMenuLabel={t("composer.sendMenuTitle")}
        sendMenuActions={
          canQuickAck
            ? [
                {
                  id: "quick-ack",
                  label: t("composer.quickAckLabel"),
                  description: t("composer.quickAck"),
                  disabled: quickAckDisabled,
                  tone: "ok",
                  onSelect: () => void send(t("composer.quickAck")),
                },
              ]
            : []
        }
        showImage={!deadHost}
        imageDisabled={structuredImagesDisabled}
        imageDisabledReason={structuredImagesReason}
        sendDisabledReason={deadHost ? t("deadHost.sendBlocked") : sendBlockedReason ?? undefined}
        receipts={
          displayedRuntimeReceipts.length
            ? <RuntimeComposerReceipts
                receipts={displayedRuntimeReceipts}
                actionsDisabled={busy || voiceSending || deadHost}
                dismissed={dismissedReceipts}
                onRetry={(receipt) => void retryRuntimeReceipt(receipt)}
                onEdit={editRuntimeReceipt}
                onDismiss={dismissReceipts}
              />
            : undefined
        }
        leftSlot={null}
      />
    </form>
  );
}
