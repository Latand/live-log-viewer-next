"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, ChevronRight, FoldVertical, Loader2, Play, Square, SquareTerminal, X } from "@/components/icons";
import { Check, Plus, RotateCcw } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

import { Hint } from "@/components/Hint";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { interruptRuntime, sendRuntimeMessage, useRuntimeReceiptsForArtifact, useRuntimeSession, type RuntimeSessionView } from "@/hooks/useRuntime";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import { conversationIdentity } from "@/lib/accounts/identity";
import { cardMigrationState, migrationHoldsSends } from "@/lib/accounts/migration";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

import { ComposerBar } from "./ComposerBar";
import { ImagePickerButton } from "./imageAttachments";
import { ReceiptChip, runtimeReceiptStatusText } from "./runtime/ReceiptChip";
import { mintIdempotencyKey, receiptIsTerminal } from "./runtime/runtimeModel";

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

export function RuntimeComposerReceipts({
  receipts,
  actionsDisabled = false,
  onRetry,
  onEdit,
}: {
  receipts: RuntimeReceipt[];
  actionsDisabled?: boolean;
  onRetry: (receipt: RuntimeReceipt) => void;
  onEdit: (receipt: RuntimeReceipt) => void;
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
  const messageReceipts = receipts
    .filter((receipt) => isMessage(receipt) && receipt.status !== "delivered" && Boolean(receipt.text))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  /* Repeated attempts of one logical send (identical kind + text) share one
     row: the newest attempt carries the current state and the action set, the
     older ones survive as counted status history instead of duplicate text. */
  const attemptGroups: { current: RuntimeReceipt; attempts: RuntimeReceipt[] }[] = [];
  const groupsByText = new Map<string, { current: RuntimeReceipt; attempts: RuntimeReceipt[] }>();
  for (const receipt of messageReceipts) {
    const key = `${receipt.kind}\u0000${receipt.text}`;
    const group = groupsByText.get(key);
    if (group) {
      group.attempts.push(receipt);
      continue;
    }
    const next = { current: receipt, attempts: [receipt] };
    groupsByText.set(key, next);
    attemptGroups.push(next);
  }
  const supersededStatusLabels = (attempts: RuntimeReceipt[]): string[] => {
    const counts = new Map<string, number>();
    for (const attempt of attempts.slice(1)) {
      const label = runtimeReceiptStatusText(t, attempt);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  };
  const standaloneReceipts = receipts.filter((receipt) => {
    if (isMessage(receipt) && receipt.status === "delivered") return false;
    return !isMessage(receipt) || !receipt.text;
  });
  const pendingReceipts = messageReceipts.filter((receipt) => !receiptIsTerminal(receipt.status));
  const problemReceipts = messageReceipts.filter((receipt) => receipt.status === "failed" || receipt.status === "rejected");
  const busyRetry = pendingReceipts.some((receipt) => typeof receipt.reason === "string" && RECOVERABLE_BUSY_RETRY_REASONS.has(receipt.reason));
  const receiptSummaryLabel = t("runtime.receipt.summary", { count: messageReceipts.length });
  const disclosureLabel = t(detailsOpen ? "runtime.receipt.hideDetails" : "runtime.receipt.showDetails");

  return (
    <>
      {messageReceipts.length ? (
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
                title={messageReceipts[0]!.text ?? undefined}
              >
                {messageReceipts[0]!.text}
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
                    <div className="flex w-full min-w-0 items-start justify-end gap-1.5">
                      <span
                        className="min-w-0 flex-1 whitespace-pre-wrap break-words text-right text-secondary"
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
          <ReceiptChip
            key={receipt.operationId}
            receipt={receipt}
            actionsDisabled={actionsDisabled}
            onRetry={isMessage(receipt) && failed ? () => onRetry(receipt) : undefined}
            onEdit={editable(receipt) ? () => onEdit(receipt) : undefined}
          />
        );
      })}
    </>
  );
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
export function TmuxComposer({ file, pollPaused = false }: { file: FileEntry; pollPaused?: boolean }) {
  const { t } = useLocale();
  /* Draft text and delivery receipts key on the stable conversation identity,
     not the transcript path: a committed account migration gives the card a new
     path under the target account, and the draft/held receipts must ride along
     (falls back to path pre-migration). */
  const cardId = conversationIdentity(file);
  const runtimeSession = useRuntimeSession(cardId);
  const structuredSession = structuredComposerSession(runtimeSession);
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
    initialText: () => (typeof window === "undefined" ? "" : sessionStorage.getItem(draftKey(cardId)) ?? ""),
    persistText: (value) => {
      if (value) sessionStorage.setItem(draftKey(cardId), value);
      else sessionStorage.removeItem(draftKey(cardId));
    },
    submit: (overrideText) => send(overrideText),
  });
  const { text, textRef, setText, setTextState, inputRef, setStatus, busy, setBusy, voiceSending, attachments } = composer;
  const isMobile = useIsMobile();
  /* The phone folds the secondary controls (target chip, interrupt, compact,
     images) behind one toggle: mic and send stay, the row stops crowding. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [attachingTerminal, setAttachingTerminal] = useState(false);
  const [compacting, setCompacting] = useState(false);
  /* Two-step compact: the first click arms the button, only the second sends
     /compact — a stray click must never condense a live agent's context. */
  const [compactArmed, setCompactArmed] = useState(false);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const [immediateRuntimeReceipts, setImmediateRuntimeReceipts] = useState<RuntimeReceipt[]>([]);
  /* One idempotency key per message draft: reused verbatim on a retry (never a
     second send) and re-minted after a successful delivery. Passed to the send
     so the runtime host can round-trip it once the structured plane is on; the
     legacy /api/tmux route ignores the extra field. */
  const idempotencyKey = useRef<string>(mintIdempotencyKey());
  /* Durable receipts for this session from the runtime bus (empty while the bus
     is disabled or the session is legacy/unhosted). */
  const runtimeReceipts = useRuntimeReceiptsForArtifact(file.path, cardId);
  const displayedRuntimeReceipts = mergeRuntimeReceipts(runtimeReceipts, immediateRuntimeReceipts);

  useEffect(() => {
    if (!compactArmed) return;
    const timer = window.setTimeout(() => setCompactArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [compactArmed]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSent(readSent(cardId));
    setImmediateRuntimeReceipts([]);
  }, [cardId]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    if (busy || voiceSending || (!payloadText.trim() && !attachments.images.length)) return;
    setBusy(true);
    setStatus(null);
    /* Idempotency key: the backend can dedupe a retried held/failed delivery
       against this id so the successor never receives the same prompt twice. */
    const clientMessageId = deliveryAttemptKey(idempotencyKey.current, retry?.clientMessageId);
    try {
      const json: {
        ok?: boolean;
        structured?: boolean;
        error?: string;
        imagePaths?: string[];
        target?: string;
        spawned?: boolean;
        outcome?: "delivered-to-live" | "resumed" | "held" | "queued" | "delivering" | "delivered" | "recovering" | "failed";
        receipt?: RuntimeReceipt;
      } = structuredSession
        ? attachments.images.length > 0
          ? await fetch("/api/tmux", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                path: file.path,
                conversationId: structuredSession.session.conversationId,
                text: payloadText,
                clientMessageId,
                images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
              }),
            }).then(async (response) => {
              const body = await response.json() as typeof json;
              return { ...body, ok: response.ok && body.ok === true };
            })
          : await sendRuntimeMessage({
              conversationId: structuredSession.session.conversationId,
              text: payloadText.trim(),
              idempotencyKey: clientMessageId,
              policy: "interrupt-active",
            }).then((result) => ({
              ok: result.ok,
              structured: true,
              error: result.error,
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
              images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
            }),
          }).then(async (response) => {
            const body = await response.json() as typeof json;
            return { ...body, ok: response.ok && body.ok === true };
          });
      if (!json.ok) {
        if (json.structured && json.receipt) {
          setImmediateRuntimeReceipts((current) => [
            json.receipt!,
            ...current.filter((receipt) => receipt.operationId !== json.receipt!.operationId),
          ].slice(0, 8));
          idempotencyKey.current = mintIdempotencyKey();
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
        idempotencyKey.current = mintIdempotencyKey();
        setText("");
        attachments.clear();
        inputRef.current?.focus();
        return;
      }
      const imgCount = attachments.images.length;
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
      idempotencyKey.current = mintIdempotencyKey(); // next draft is a new message
      setText("");
      attachments.clear();
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
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
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

  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    setStatus(null);
    try {
      const result = structuredSession
        ? await interruptRuntime(structuredSession.session.conversationId, mintIdempotencyKey())
        : await fetch("/api/tmux", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "interrupt", path: file.path }),
          }).then(async (response) => {
            const body = await response.json() as { ok?: boolean; error?: string };
            return { ok: response.ok && body.ok === true, error: body.error };
          });
      if (!result.ok) {
        setStatus({ kind: "err", text: result.error ?? t("composer.failedInterrupt") });
        return;
      }
      setStatus({ kind: "ok", text: t("composer.escapeSent") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setInterrupting(false);
    }
  };

  const attachTerminal = async () => {
    if (attachingTerminal) return;
    setAttachingTerminal(true);
    setStatus(null);
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "attach-terminal", path: file.path }),
      });
      const body = await response.json() as { ok?: boolean; target?: string; error?: string };
      if (!response.ok || !body.ok) {
        setStatus({ kind: "err", text: body.error ?? t("composer.attachTerminalFailed") });
        return;
      }
      setStatus({ kind: "ok", text: t("composer.attachTerminalReady", { target: body.target ?? "" }) });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setAttachingTerminal(false);
    }
  };

  /* Types /compact into the live pane; the compaction band then appears in
     the feed on its own once the transcript grows the marker. */
  const compact = async () => {
    if (compacting) return;
    setCompacting(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "compact", path: file.path }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? t("composer.failedCompact") });
        return;
      }
      setStatus({ kind: "ok", text: t("composer.compactSent") });
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setCompacting(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
  };

  const modeChip = (
    <span
      className="inline-flex min-w-0 items-center gap-1 rounded-control bg-sunken px-1.5 py-1 text-caption font-semibold text-secondary"
      title={structuredSession ? t("composer.structuredHost") : relayMode ? t("composer.titleRelay") : spawnMode ? t("composer.titleSpawnResumed") : `tmux ${target}`}
    >
      {structuredSession ? (
        <>
          <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden /> {t("composer.structured")}
        </>
      ) : relayMode ? (
        <>
          <ArrowUpToLine className="h-3 w-3 shrink-0" aria-hidden /> {t("composer.root")}
        </>
      ) : spawnMode ? (
        <>
          <Play className="h-3 w-3 shrink-0" aria-hidden /> resume
        </>
      ) : (
        <>
          <SquareTerminal className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate font-mono">{target}</span>
        </>
      )}
    </span>
  );

  /* Phone composer controls meet the 44px minimum; desktop keeps the compact p-2. */
  const iconBtn = isMobile ? "h-11 w-11" : "p-2";
  const liveControls = !spawnMode ? (
    <>
      <Hint label={t("composer.interruptTitle")}>
        <button
          type="button"
          aria-label={t("composer.interruptAria")}
          disabled={interrupting}
          onClick={() => void interrupt()}
          className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${iconBtn}`}
        >
          {interrupting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Square className="h-4 w-4" fill="currentColor" aria-hidden />}
        </button>
      </Hint>
      {structuredSession ? (
        <Hint label={t("composer.attachTerminal")}>
          <button
            type="button"
            aria-label={t("composer.attachTerminal")}
            disabled={attachingTerminal}
            onClick={() => void attachTerminal()}
            className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${iconBtn}`}
          >
            {attachingTerminal ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SquareTerminal className="h-4 w-4" aria-hidden />}
          </button>
        </Hint>
      ) : <Hint label={compactArmed ? t("composer.compactConfirmTitle") : t("composer.compactTitle")}>
        <button
          type="button"
          aria-label={compactArmed ? t("composer.compactConfirmTitle") : t("composer.compactAria")}
          disabled={compacting}
          onClick={() => {
            if (!compactArmed) {
              setCompactArmed(true);
              return;
            }
            setCompactArmed(false);
            void compact();
          }}
          className={`inline-flex shrink-0 items-center justify-center gap-1 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
            isMobile ? "min-h-11 px-2.5" : "p-2"
          } ${
            compactArmed
              ? "bg-info/10 text-info"
              : "text-muted hover:bg-sunken hover:text-info"
          }`}
        >
          {compacting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : compactArmed ? (
            <>
              <Check className="h-4 w-4" aria-hidden />
              <span className="text-[10.5px] font-bold">{t("composer.compactConfirm")}</span>
            </>
          ) : (
            <FoldVertical className="h-4 w-4" aria-hidden />
          )}
        </button>
      </Hint>}
    </>
  ) : null;

  const canQuickAck = !spawnMode || relayMode;
  const quickAckDisabled = busy || voiceSending || attachments.images.length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 py-2"
      aria-label={structuredSession ? t("composer.sendStructuredAria") : spawnMode ? t("composer.spawnAria") : t("composer.sendAria", { target: target ?? "" })}
    >
      {/* Proactive hold hint: while the card is switching accounts, the next
          send is queued for the successor rather than delivered live. Shown
          identically under the desktop and mobile composers. */}
      {holdsSends ? (
        <div role="status" aria-live="polite" className="flex items-center gap-1.5 rounded-control border border-warning/45 bg-warning-soft px-2 py-1 text-label font-semibold text-warning">
          <ArrowUpToLine className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{t("migrate.heldSend")}</span>
        </div>
      ) : null}
      {sent.length ? (
        <div className="flex flex-col gap-0.5" aria-label={t("composer.queueAria")}>
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
        showImage={!isMobile}
        receipts={
          displayedRuntimeReceipts.length
            ? <RuntimeComposerReceipts
                receipts={displayedRuntimeReceipts}
                actionsDisabled={busy || voiceSending}
                onRetry={(receipt) => void retryRuntimeReceipt(receipt)}
                onEdit={editRuntimeReceipt}
              />
            : undefined
        }
        leftSlot={
          isMobile ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                aria-expanded={toolsOpen}
                aria-label={t("composer.moreTools")}
                title={t("composer.moreTools")}
                onClick={() => setToolsOpen((value) => !value)}
                className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${iconBtn}`}
              >
                <Plus className={`h-4 w-4 transition-transform ${toolsOpen ? "rotate-45" : ""}`} aria-hidden />
              </button>
              {toolsOpen ? (
                <>
                  {modeChip}
                  {liveControls}
                  <ImagePickerButton
                    ariaLabel={t("composer.addImages")}
                    className={`inline-flex shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${iconBtn}`}
                    onFiles={attachments.addFiles}
                  />
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              {modeChip}
              {liveControls}
            </div>
          )
        }
      />
    </form>
  );
}
