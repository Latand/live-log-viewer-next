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
import {
  readRetainedQueueAdmissions,
  releaseQueueAdmission,
  retainQueueAdmission,
  sameQueueOperation,
  type RetainedQueueAdmission,
} from "@/components/retainedQueueAdmissions";
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

/** One hand-off this browser cannot say the outcome of, for the panel to offer
    the single control that resolves it. */
export interface NativeQueueUnresolvedAdmission {
  key: string;
  text: string;
  imageCount: number;
}

export interface NativeQueuePanelProps {
  view: NativeQueueView;
  /**
   * Hand-offs admitted from this conversation whose reply never arrived.
   *
   * They are NOT queue rows: the journal may or may not hold them, which is the
   * whole point, and the panel says so rather than counting them among the
   * messages Codex is holding. Sending one again replays that one operation
   * under its own key — the journal answers a replay with the operation it
   * already has, so the message reaches Codex once either way.
   */
  unresolved?: readonly NativeQueueUnresolvedAdmission[];
  onReplay?(key: string): void;
  /** True until this conversation's queue has been read once. Accepted so a
      caller need not decide what to do with it; the panel opens on rows, not on
      a pending read, because a card that has never queued anything would flash
      an empty header above the composer on every mount. */
  loading?: boolean;
  error: string | null;
  /** The thread's model and effort right now, for the truthful profile line. */
  thread: { model: string | null; effort: string | null };
  /**
   * The card these controls belong to, and the thread and account they are
   * admitted against.
   *
   * The card id is where a press whose reply never arrived keeps its key, so
   * that key survives the poll-driven remount above (#1629 review). The binding
   * rides in the frozen envelope for the same reason the composer's does: an
   * account switched between the press and the replay must be refused by the
   * journal rather than silently followed.
   */
  cardId: string;
  binding?: { threadId: string | null; accountId: string | null };
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
  const { observed, requested } = nativeQueueProfile(row, thread);
  const runs = observed ? t("queue.runsOn", { settings: observed }) : t("queue.runsOnThread");
  return requested ? `${runs} ${t("queue.asked", { settings: requested })}` : runs;
}

export function NativeQueuePanel({ view, error, thread, cardId, binding, unresolved, onReplay, mintKey, submit, onRefresh, t }: NativeQueuePanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /* The edit box is UNCONTROLLED, and read at save. A queued message can be
     paragraphs long, and re-rendering the whole queue on every keystroke is the
     kind of cost the operator feels as lag in the one control they are using. */
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  /**
   * Every control funnels through here so exactly one thing decides what a
   * refusal looks like: the runtime's own words, verbatim, next to the queue it
   * is about. A refusal never clears the panel or the draft.
   *
   * AND THE SAME ORIGINAL-KEY RULE THE COMPOSER USES, THROUGH THE SAME RECORD.
   * A mutation whose outcome this browser never learned may already be in the
   * journal, so pressing the same control on the same row again must replay THAT
   * operation rather than mint a second one — and it must still do so after the
   * composer above has been remounted by a board poll or the tab reloaded, which
   * a component ref cannot survive. So the key lives in the retained-admission
   * store the composer's own hand-offs use: written BEFORE the request leaves,
   * matched by everything the press authored and addressed, and released the
   * moment the journal gives any verdict on it. Anything the operator changed —
   * a different row, different words, a different order — is a different request
   * and gets its own key.
   *
   * This adds no scheduler and no retry. The replay happens only when the
   * operator presses the control again, and the journal answers a replayed key
   * with the operation it already holds.
   */
  const run = async (mutation: NativeQueueMutation) => {
    setFailure(null);
    const retained = readRetainedQueueAdmissions(cardId).find((entry) => sameQueueOperation(entry.mutation, mutation));
    const envelope: RetainedQueueAdmission = retained ?? {
      key: mintKey(),
      mutation,
      binding: binding ?? { threadId: null, accountId: null },
    };
    /* NOTHING IS SENT THAT THIS BROWSER COULD NOT NAME AFTERWARDS. The store
       refuses a NEW operation it cannot keep — the card already holds the most
       unresolved operations it may, the slot holds bytes nothing here can read,
       or the browser will not take the write. Refusing here costs a press; going
       ahead would put an operation in the journal under a key that vanishes on
       reload, and the operator's next press would be a second one of it. A
       replay is never refused: its key is already in the slot. */
    if (retainQueueAdmission(cardId, envelope) === "refused") {
      setFailure(t("queue.retentionRefused"));
      return false;
    }
    /* The ORIGINAL binding rides with a replay, so a thread or account that
       moved since the first press is refused by the journal rather than quietly
       followed. A caller that named no binding leaves it to the hook's live one,
       which is what every ordinary first press wants anyway. */
    const command = binding ? { ...envelope.mutation, binding: envelope.binding } : envelope.mutation;
    const answer = await submit(command, envelope.key);
    if (answer.outcome !== "unknown") releaseQueueAdmission(cardId, envelope.key);
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
  /* An empty queue is not a panel — unless something is unresolved, which is
     exactly when the operator needs the one control that settles it. */
  const pending = unresolved ?? [];
  if (view.rows.length === 0 && pending.length === 0) return null;

  return (
    <section
      aria-label={t("queue.panel")}
      data-testid="native-queue-panel"
      data-stale={view.nativeStale ? "true" : undefined}
      /* IT SITS ABOVE THE INPUT, SO IT TAKES WHAT THE CONVERSATION CAN SPARE.
         The composer budgets itself against the conversation it is in
         (`TmuxComposer`'s form), and inside that budget this panel is the part
         that yields: `min-h-0` is what lets the flexbox shrink it, so the
         textarea, the send control and a readable transcript keep their room
         at every conversation size instead of being pushed past the pane's
         bottom edge and clipped. Sized from the viewport alone the panel could
         be taller than the whole phone composer — 378 px inside a 319 px form —
         and the operator had no way left to type or send.
         The ceiling stays for the surfaces whose height is not definite, where
         a percentage budget cannot resolve and this is the only bound.
         What yields first is the rows list; when even its floor does not fit,
         the panel scrolls itself, in the same
         `max-h / overflow-y-auto / overscroll-contain` idiom the rest of the app
         uses, so the header, the recovery controls and every row stay reachable
         and a wheel inside the queue never escapes to the board. With room to
         spare nothing scrolls and nothing moves. */
      className="flex min-h-0 max-h-[min(45dvh,26rem)] flex-col overflow-y-auto overscroll-contain rounded-control border border-border bg-raised/60"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1">
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
        <p data-testid="native-queue-notice" role="status" className="shrink-0 border-b border-border/40 px-2 py-1 text-caption text-muted">
          {noticeText(view.notice, t)}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <section
          data-testid="native-queue-unresolved"
          aria-label={t("queue.unresolvedTitle")}
          className="shrink-0 border-b border-warning/30 bg-warning/5 px-2 py-1.5"
        >
          <p className="text-caption text-secondary">{t("queue.unresolved", { count: pending.length })}</p>
          {/* Its own small cap, so a run of unanswered hand-offs cannot take the
              room the queue's rows need to stay reachable. */}
          <ul className="mt-1 flex max-h-24 flex-col gap-1 overflow-y-auto overscroll-contain">
            {pending.map((entry) => (
              <li key={entry.key} data-testid="native-queue-unresolved-row" data-key={entry.key} className="flex items-start gap-2">
                <p className="min-w-0 flex-1 truncate text-ui text-primary">
                  {entry.text || t("queue.unresolvedNoText", { count: entry.imageCount })}
                </p>
                {onReplay ? (
                  <button
                    type="button"
                    data-testid="native-queue-unresolved-retry"
                    onClick={() => onReplay(entry.key)}
                    className="shrink-0 rounded-control border border-accent/50 px-1.5 py-0.5 text-caption text-accent hover:bg-accent/10"
                  >
                    {t("queue.unresolvedRetry")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The first part to scroll, and the first to yield. No `flex-1`: its basis
          stays its content, so a short queue is laid out exactly as before and
          only an overflowing one shrinks against the room above. The floor is
          about half a row: a panel squeezed to almost nothing still shows the
          queue it is a view of, rather than a bare header over an empty
          strip. */}
      <ul data-testid="native-queue-rows" className="min-h-14 divide-y divide-border/40 overflow-y-auto overscroll-contain">
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
