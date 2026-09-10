"use client";

import { useEffect, useRef, useState } from "react";

import {
  nativeQueueProfile,
  reorderedNativeQueue,
  type NativeQueueBlocked,
  type NativeQueueNotice,
  type NativeQueueRow,
  type NativeQueueView,
} from "@/components/nativeQueueView";
import type { NativeQueueMutation, NativeQueueSubmission } from "@/hooks/useNativeQueue";
import type { TFunction } from "@/lib/i18n";

/**
 * Codex's own queue, and the controls on it (#1629).
 *
 * The operator asked for native send/queue behaviour, and the whole point of it
 * is that the queue is CODEX'S: it holds the messages, it decides when the next
 * one goes, and it can dispatch one the moment a turn ends without asking
 * anybody. So this panel is a view of that queue rather than a plan for it —
 * the order is Codex's order, a row says whether Codex has acknowledged it, and
 * every control here is a request that may be refused on the wire.
 *
 * WHAT IT NEVER DOES:
 *
 * - promise a per-message model or effort. Native's queue parameters carry
 *   neither; a queued message runs on the thread's settings at the moment Codex
 *   dispatches it, and the row says exactly that.
 * - retry anything. A change whose outcome is unknown keeps its own operation
 *   and its own key, and the row says so instead of offering a button that would
 *   be a second attempt at something nobody has the result of.
 * - treat a message vanishing from the queue as delivery. That is the runtime's
 *   rule and it is visible here: an entry leaves this panel when the journal
 *   settles it, never because Codex stopped listing it.
 */

export interface NativeQueuePanelProps {
  view: NativeQueueView;
  /** True until this conversation's queue has been read once. Accepted so a
      caller need not decide what to do with it; the panel opens on rows, not on
      a pending read, because a card that has never queued anything would flash
      an empty header above the composer on every mount. */
  loading?: boolean;
  error: string | null;
  /** The thread's model and effort right now, for the truthful profile line. */
  thread: { model: string | null; effort: string | null };
  /** Mint a fresh immutable key per control press. */
  mintKey(): string;
  submit(mutation: NativeQueueMutation, idempotencyKey: string): Promise<NativeQueueSubmission>;
  onRefresh(): void;
  t: TFunction;
}

/** The projection names a condition; this is where it becomes words, in the
    operator's own language. */
function blockedText(blocked: NativeQueueBlocked, t: TFunction): string {
  const reason = blocked.code === "busy" ? t("queue.blocked.busy")
    : blocked.code === "dispatched" ? t("queue.blocked.dispatched")
      : blocked.code === "delivered" ? t("queue.blocked.delivered")
        : blocked.code === "removed" ? t("queue.blocked.removed")
          : blocked.code === "withdrawn-running" ? t("queue.blocked.withdrawnRunning")
            : blocked.code === "unacknowledged" ? t("queue.blocked.unacknowledged")
              : blocked.code === "refused" ? t("queue.blocked.refused")
                : t("queue.blocked.uncertain");
  /* THE RUNTIME'S OWN WORDS WIN. When it gave a reason it is the authoritative
     one and the code's generic sentence would only repeat it at length; the code
     is what speaks for the conditions the runtime says nothing about. */
  return t("queue.blocked", { reason: blocked.detail ?? reason });
}

function noticeText(notice: NativeQueueNotice, t: TFunction): string {
  return notice.code === "stale" ? t("queue.noticeStale") : t("queue.noticePending", { count: notice.count });
}

function profileText(row: NativeQueueRow, thread: { model: string | null; effort: string | null }, t: TFunction): string {
  const { effective, requested } = nativeQueueProfile(row, thread);
  const runs = effective ? t("queue.runsOn", { settings: effective }) : t("queue.runsOnThread");
  return requested ? `${runs} ${t("queue.asked", { settings: requested })}` : runs;
}

export function NativeQueuePanel({ view, error, thread, mintKey, submit, onRefresh, t }: NativeQueuePanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /* The edit box is UNCONTROLLED, and read at save. A queued message can be
     paragraphs long, and re-rendering the whole queue on every keystroke is the
     kind of cost the operator feels as lag in the one control they are using. */
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  /* Every control funnels through here so exactly one thing decides what a
     refusal looks like: the runtime's own words, verbatim, next to the queue it
     is about. A refusal never clears the panel or the draft. */
  const run = async (mutation: NativeQueueMutation) => {
    setFailure(null);
    const answer = await submit(mutation, mintKey());
    if (!answer.ok) setFailure(answer.error ?? t("queue.refused"));
    return answer.ok;
  };

  if (error) {
    return (
      <section aria-label={t("queue.panel")} data-testid="native-queue-panel" className="rounded-control border border-danger/40 bg-danger/5 px-2 py-1.5">
        <p className="text-label text-danger">{t("queue.readFailed", { reason: error })}</p>
        <button
          type="button"
          data-testid="native-queue-retry"
          onClick={onRefresh}
          className="mt-1 rounded-control border border-danger/40 px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10"
        >
          {t("queue.retryRead")}
        </button>
      </section>
    );
  }
  /* An empty queue is not a panel. */
  if (view.rows.length === 0) return null;

  return (
    <section
      aria-label={t("queue.panel")}
      data-testid="native-queue-panel"
      data-stale={view.nativeStale ? "true" : undefined}
      className="rounded-control border border-border bg-raised/60"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1">
        <span className="text-caption font-medium text-secondary">{t("queue.title")}</span>
        <span data-testid="native-queue-count" className="text-caption text-muted">
          {t("queue.count", { count: view.rows.length })}
        </span>
        <span className="flex-1" />
        {view.canStart ? (
          <button
            type="button"
            data-testid="native-queue-start"
            onClick={() => void run({ action: "start", turnId: null })}
            className="rounded-control border border-accent/50 px-1.5 py-0.5 text-caption text-accent hover:bg-accent/10"
          >
            {t("queue.start")}
          </button>
        ) : null}
      </header>

      {view.notice ? (
        <p data-testid="native-queue-notice" role="status" className="border-b border-border/40 px-2 py-1 text-caption text-muted">
          {noticeText(view.notice, t)}
        </p>
      ) : null}

      <ul className="divide-y divide-border/40">
        {view.rows.map((row, index) => (
          <li key={row.entryId} data-testid="native-queue-row" data-entry={row.entryId} data-state={row.state} className="px-2 py-1.5">
            {editing === row.entryId ? (
              <div className="flex flex-col gap-1">
                <textarea
                  ref={editRef}
                  data-testid="native-queue-edit-field"
                  defaultValue={row.text}
                  rows={2}
                  aria-label={t("queue.editAria")}
                  className="w-full resize-none rounded-control border border-border bg-base px-1.5 py-1 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="native-queue-save"
                    onClick={() => void (async () => {
                      const text = editRef.current?.value.trim() ?? "";
                      /* An ATTACHMENT-ONLY entry is editable too. Its text is
                         empty and always was, so refusing an empty box here left
                         the one message whose words the operator most likely
                         wanted to add with no way to save them. */
                      if (!text && !row.images.length) return;
                      /* The EXPECTED REVISION rides the update: an entry the
                         runtime has admitted a newer version of is a conflict,
                         and the operator is told rather than overwriting it.
                         THE ATTACHMENTS RIDE IT TOO. An update replaces the
                         version wholesale and its digest is computed over what
                         the command carries, so an edit of the words that named
                         no images used to admit revision 2 with none — the
                         operator saw a text edit and lost the pictures. */
                      const saved = await run({
                        action: "update",
                        entryId: row.entryId,
                        expectedRevision: row.revision,
                        text,
                        ...(row.images.length ? { images: [...row.images] } : {}),
                      });
                      if (saved) setEditing(null);
                    })()}
                    className="rounded-control border border-accent/50 px-1.5 py-0.5 text-caption text-accent disabled:opacity-50 hover:bg-accent/10"
                  >
                    {t("queue.save")}
                  </button>
                  <button
                    type="button"
                    data-testid="native-queue-cancel"
                    onClick={() => setEditing(null)}
                    className="rounded-control border border-border px-1.5 py-0.5 text-caption text-secondary hover:bg-raised"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui text-primary">
                  {row.text || t("queue.noText", { count: row.imageCount })}
                </p>
                <RowControls
                  row={row}
                  view={view}
                  first={index === 0}
                  last={index === view.rows.length - 1}
                  onEdit={() => setEditing(row.entryId)}
                  run={run}
                  t={t}
                />
              </div>
            )}
            <p data-testid="native-queue-row-status" className="mt-0.5 text-caption text-muted">
              {row.blocked
                ? blockedText(row.blocked, t)
                /* A WITHDRAWN ROW IS NOT WAITING FOR ANYTHING. Codex no longer
                   holds it and the Viewer still does, so "waiting for Codex to
                   acknowledge it" — which is what an unobserved row otherwise
                   says — described the opposite of its situation next to the one
                   control that moves it. */
                : row.state === "withdrawn"
                  ? t("queue.withdrawnIdle")
                  : row.observedInNative
                    ? t("queue.heldByCodex")
                    : t("queue.awaitingCodex")}
              {/* What it will run on, for a message that still has a future.
                  A row that is finished, refused or unresolved is not going to
                  be dispatched, so saying which settings it would use is noise
                  on the one line the operator is reading for the reason. */}
              {!row.blocked || row.blocked.code === "busy" || row.blocked.code === "unacknowledged"
                ? <>{" · "}{profileText(row, thread, t)}</>
                : null}
            </p>
          </li>
        ))}
      </ul>

      {failure ? (
        <p data-testid="native-queue-failure" role="alert" className="border-t border-danger/30 bg-danger/5 px-2 py-1 text-caption text-danger">
          {failure}
        </p>
      ) : null}
    </section>
  );
}

function RowControls({
  row, view, first, last, onEdit, run, t,
}: {
  row: NativeQueueRow;
  view: NativeQueueView;
  first: boolean;
  last: boolean;
  onEdit(): void;
  run(mutation: NativeQueueMutation): Promise<boolean>;
  t: TFunction;
}) {
  const can = (action: NativeQueueRow["actions"][number]) => row.actions.includes(action);
  const move = (direction: "up" | "down") => {
    const order = row.nativeSubmissionId ? reorderedNativeQueue(view, row.nativeSubmissionId, direction) : null;
    if (order) void run({ action: "reorder", queuedSubmissionIds: order });
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {can("move") ? (
        <>
          <button
            type="button"
            data-testid="native-queue-up"
            disabled={first}
            aria-label={t("queue.moveUp")}
            onClick={() => move("up")}
            className="rounded-control border border-border px-1 py-0.5 text-ui leading-none text-secondary disabled:opacity-40 hover:bg-raised"
          >
            ↑
          </button>
          <button
            type="button"
            data-testid="native-queue-down"
            disabled={last}
            aria-label={t("queue.moveDown")}
            onClick={() => move("down")}
            className="rounded-control border border-border px-1 py-0.5 text-ui leading-none text-secondary disabled:opacity-40 hover:bg-raised"
          >
            ↓
          </button>
        </>
      ) : null}
      {can("edit") ? (
        <button
          type="button"
          data-testid="native-queue-edit"
          onClick={onEdit}
          className="rounded-control border border-border px-1.5 py-0.5 text-caption text-secondary hover:bg-raised"
        >
          {t("queue.edit")}
        </button>
      ) : null}
      {can("start") ? (
        <button
          type="button"
          data-testid="native-queue-row-start"
          /* THE ONE ROUTE BACK for a payload native no longer holds. The runtime
             refuses every action but `start` on a withdrawn entry, so this is a
             start — naming the entry and its revision — rather than the
             `send-now` the row used to offer and the journal always refused. */
          onClick={() => void run({
            action: "start",
            entryId: row.entryId,
            expectedRevision: row.revision,
            turnId: null,
          })}
          className="rounded-control border border-accent/50 px-1.5 py-0.5 text-caption text-accent hover:bg-accent/10"
        >
          {t("queue.sendNow")}
        </button>
      ) : null}
      {can("send-now") ? (
        <button
          type="button"
          data-testid="native-queue-send-now"
          /* The fence the runtime requires: an explicit null when the thread is
             idle, and the exact active turn otherwise. Send now on an active
             turn withdraws the queued entry and steers that turn — so naming the
             wrong turn must be impossible from here. */
          onClick={() => void run({
            action: "send-now",
            entryId: row.entryId,
            expectedRevision: row.revision,
            turnId: view.canStart ? null : (view.activeTurnId ?? null),
          })}
          className="rounded-control border border-accent/50 px-1.5 py-0.5 text-caption text-accent hover:bg-accent/10"
        >
          {t("queue.sendNow")}
        </button>
      ) : null}
      {can("delete") ? (
        <button
          type="button"
          data-testid="native-queue-delete"
          aria-label={t("queue.delete")}
          onClick={() => void run({ action: "delete", entryId: row.entryId, expectedRevision: row.revision })}
          className="rounded-control border border-border px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10"
        >
          {t("queue.delete")}
        </button>
      ) : null}
    </div>
  );
}
