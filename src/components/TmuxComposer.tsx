"use client";

import { useEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, Play, X } from "@/components/icons";
import { RotateCcw } from "lucide-react";

import type { TFunction } from "@/lib/i18n";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useComposer } from "@/hooks/useComposer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { sendRuntimeMessage, useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { useAgentCapabilities } from "./useAgentCapabilities";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import { conversationIdentity } from "@/lib/accounts/identity";
import { cardMigrationState, migrationHoldsSends } from "@/lib/accounts/migration";
import { getLocale, useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

import { ComposerBar } from "./ComposerBar";
import { savedResumeProfile } from "./AgentRuntimeControls";
import { ReceiptChip } from "./runtime/ReceiptChip";
import { collapseReceipts, mintIdempotencyKey } from "./runtime/runtimeModel";

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
const sentKey = (id: string) => "llvSent:" + id;

export function deliveryAttemptKey(current: string, stored?: string): string {
  return stored || current;
}

/** Parsed epoch-ms of a receipt's `at`; malformed timestamps sort oldest so a
    newer, well-formed receipt always wins the current row. */
function receiptTime(receipt: RuntimeReceipt): number {
  const ms = Date.parse(receipt.at);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Merge durable (bus) and immediate (just-POSTed) receipts into one newest-first
 * list. Deduplicate by `operationId` keeping the highest revision, then order by
 * timestamp descending so {@link collapseReceipts} surfaces the newest
 * non-success — never an older durable failure over a newer immediate operation
 * (issue #247 finding 3). Ties (equal or malformed timestamps) break
 * deterministically by revision then operationId so the ordering is stable.
 */
export function mergeRuntimeReceipts(
  runtimeReceipts: RuntimeReceipt[],
  immediateReceipts: RuntimeReceipt[],
): RuntimeReceipt[] {
  const merged = new Map<string, RuntimeReceipt>();
  for (const receipt of [...runtimeReceipts, ...immediateReceipts]) {
    const current = merged.get(receipt.operationId);
    if (!current || receipt.revision > current.revision) merged.set(receipt.operationId, receipt);
  }
  return [...merged.values()].sort((a, b) => {
    const ta = receiptTime(a);
    const tb = receiptTime(b);
    if (ta !== tb) return tb - ta;
    if (a.revision !== b.revision) return b.revision - a.revision;
    return a.operationId.localeCompare(b.operationId);
  });
}

/** Whether a receipt's message text is short enough to safely edit-and-resend
    (durable retry reads the full journaled request; editing needs the summary). */
function receiptEditable(receipt: RuntimeReceipt): boolean {
  const messageOperation = receipt.kind === "send" || receipt.kind === "steer";
  return messageOperation
    && (receipt.status === "failed" || receipt.status === "rejected")
    && typeof receipt.text === "string"
    && receipt.text.length > 0
    && receipt.text.length < 240;
}

/**
 * The single-slot receipt row (issue #247 §7): terminal successes are silent
 * (the transcript is the proof), identical consecutive failures collapse into
 * one row with a ×N counter, and older receipts hide behind a `history (n)`
 * disclosure. In-flight rows keep their quiet pulse.
 */
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
  const { current, history } = collapseReceipts(receipts);
  return (
    <div className="flex w-full flex-col gap-1">
      {current ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <ReceiptChip
            receipt={current.receipt}
            actionsDisabled={actionsDisabled}
            onRetry={current.receipt.status === "failed" && (current.receipt.kind === "send" || current.receipt.kind === "steer") ? () => onRetry(current.receipt) : undefined}
            onEdit={receiptEditable(current.receipt) ? () => onEdit(current.receipt) : undefined}
          />
          {current.count > 1 ? (
            <span className="text-caption font-semibold tabular-nums text-muted" aria-label={t("runtime.receipt.repeatCount", { count: current.count })}>
              ×{current.count}
            </span>
          ) : null}
        </span>
      ) : null}
      {history.length ? (
        <details className="text-caption text-muted">
          <summary className="cursor-pointer select-none font-semibold">{t("runtime.receipt.history", { count: history.length })}</summary>
          <div className="mt-1 flex flex-col gap-1">
            {history.map((receipt) => (
              <ReceiptChip key={receipt.operationId} receipt={receipt} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
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
  const { structuredSession } = useAgentCapabilities(file);
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
  /* Interrupt / compact / attach-terminal / mode chip moved into the unified
     control strip (issue #241) — the composer keeps only the message surface
     (text, images, mic, send) and its delivery receipts. */
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
          ? { ok: false, structured: true, error: t("composer.structuredImagesUnavailable") }
          : await sendRuntimeMessage({
              conversationId: structuredSession.session.conversationId,
              text: payloadText.trim(),
              idempotencyKey: clientMessageId,
              policy: "steer-if-active",
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
              /* The "on resume" profile (issue #241 §4): when this send reopens a
                 finished root conversation, boot it with the model/effort the
                 strip's picker saved. Ignored for a live pane or a subagent relay. */
              ...(spawnMode && !relayMode ? resumeProfileBody(file) : {}),
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
        setStatus({ kind: "info", text: t("composer.deliveryQueued") });
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
      setStatus({ kind: "info", text: t("composer.deliveryQueued") });
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
        showImage={!deadHost}
        imageDisabledReason={structuredSession ? t("strip.imagesStructured") : undefined}
        sendDisabledReason={deadHost ? t("deadHost.sendBlocked") : sendBlockedReason ?? undefined}
        receipts={
          displayedRuntimeReceipts.length
            ? <RuntimeComposerReceipts
                receipts={displayedRuntimeReceipts}
                actionsDisabled={busy || voiceSending || deadHost}
                onRetry={(receipt) => void retryRuntimeReceipt(receipt)}
                onEdit={editRuntimeReceipt}
              />
            : undefined
        }
        leftSlot={null}
      />
    </form>
  );
}
