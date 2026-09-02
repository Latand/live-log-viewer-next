"use client";

import { Check, ChevronDown, ChevronRight, Loader2, Pause, RotateCw, Send, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { type Locale, type MessageKey, type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry, PendingQuestion, PendingQuestionItem } from "@/lib/types";

type CardState = "pending" | "delivering" | "answered" | "superseded" | "failed";

/*
 * Issue #765: an explicit dismiss on the live composer card. Dismissal is a
 * view decision, so it mirrors what scanner-side retirement (#775) already
 * does to the composer region — the card stops rendering there — while the
 * transcript's own tool record stays as history (#757: nothing vanishes from
 * the transcript). It is remembered in localStorage per question, the same
 * store the deck disclosure pins use, so a dead card does not return on every
 * reload — which is exactly the friction the issue describes.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type QuestionIdentity = { transcriptPath: string; toolUseId: string };

export function questionDismissKey(question: QuestionIdentity): string {
  return `llvQuestionDismissed:${question.transcriptPath}:${question.toolUseId}`;
}

export function isQuestionDismissed(storage: StorageLike | null, question: QuestionIdentity): boolean {
  try {
    return storage?.getItem(questionDismissKey(question)) === "1";
  } catch {
    return false;
  }
}

export function rememberQuestionDismissed(storage: StorageLike | null, question: QuestionIdentity): void {
  try {
    storage?.setItem(questionDismissKey(question), "1");
  } catch { /* best-effort: a full or blocked store only costs durability */ }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A submitted answer, kept so a failure can offer a labelled retry (#697). */
interface Attempt {
  payload: Record<string, unknown>;
  optimistic: string;
  /** The picks this attempt carried, so a failure can keep them on screen. */
  selection: Record<number, number[]> | null;
}

/**
 * Issue #697: delivery failures reach the operator as translated copy. The
 * server's `error` string is internal detail — it carried untranslated driver
 * text and colon-terminated pane dumps ("screen does not match this question: ")
 * straight into the card — so it never becomes UI text.
 */
export function deliveryErrorKey(status: number, body: { noPane?: boolean; delivered?: boolean } = {}): MessageKey {
  if (body.noPane) return "question.noPane";
  if (status === 400) return "question.errorRejected";
  if (status === 403) return "question.errorNotRunning";
  if (status === 409) return "question.errorMoved";
  /* 502 is two different events and only the route knows which (issue #697):
     `delivered` means Enter was pressed and only the transcript confirmation is
     missing; without it the driver failed while still navigating to the option,
     so nothing was submitted. Claiming "the answer was sent" for the second is
     the same class of untruth as the raw exception text this replaced. */
  if (status === 502) return body.delivered ? "question.errorUnconfirmed" : "question.errorNotDelivered";
  if (status >= 500) return "common.serverUnavailable";
  return "common.failedSend";
}

/*
 * Mobile v2 (#1439, lane 4): a suggested-reply chip answers the pending
 * question on tap, from outside this card. The chip posts through this seam
 * and the mounted card hears the outcome, so the card folds (or shows the
 * failure with its retry) exactly as if one of its own options had been
 * tapped. Module-level because the chip row and the card are siblings with no
 * shared parent that owns the question.
 */
export type QuestionAnswerEvent =
  | { toolUseId: string; ok: true; text: string; answer: string; at: number; picks?: Record<number, number[]> | null }
  | { toolUseId: string; ok: false; text: string; key: MessageKey; superseded?: string };

const answerListeners = new Set<(event: QuestionAnswerEvent) => void>();

export function subscribeQuestionAnswers(listener: (event: QuestionAnswerEvent) => void): () => void {
  answerListeners.add(listener);
  return () => {
    answerListeners.delete(listener);
  };
}

function announceQuestionAnswer(event: QuestionAnswerEvent): void {
  for (const listener of [...answerListeners]) listener(event);
}

/** Sends `text` as the reply to `pending` and tells every mounted card. */
export async function answerPendingQuestionWithText(pending: PendingQuestion, text: string): Promise<QuestionAnswerEvent> {
  const toolUseId = pending.toolUseId;
  let event: QuestionAnswerEvent;
  try {
    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcriptPath: pending.transcriptPath, toolUseId, kind: pending.kind, text }),
    });
    const json = (await res.json()) as { ok?: boolean; answer?: string; superseded?: boolean; noPane?: boolean; delivered?: boolean };
    if (!res.ok || !json.ok) {
      event = res.status === 409 && (json.superseded || json.answer)
        ? { toolUseId, ok: false, text, key: "question.alreadyAnswered", superseded: json.answer ?? "" }
        : { toolUseId, ok: false, text, key: deliveryErrorKey(res.status, json) };
    } else {
      event = { toolUseId, ok: true, text, answer: json.answer ?? text, at: Date.now() };
    }
  } catch {
    event = { toolUseId, ok: false, text, key: "common.serverUnavailable" };
  }
  announceQuestionAnswer(event);
  return event;
}

/* The phone's answered fold shows the minute the reply went, HH:MM. */
function answeredClock(locale: Locale, at: number): string {
  return new Date(at).toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

/* Mobile v2 (#1439, lane 4): the picks an answer carried, shown marked in the
   folded card's expansion. `null` for a typed answer or a chip. */
type Picks = Record<number, number[]> | null;

function labelFor(question: PendingQuestionItem, value: number): string {
  return question.options[value]?.label ?? String(value + 1);
}

function elapsed(t: TFunction, since: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - since));
  if (seconds < 60) return t("question.sec", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? t("question.min", { n: minutes }) : t("question.hour", { n: Math.floor(minutes / 60) });
}

export function QuestionCard({ file }: { file: FileEntry }) {
  const { t, locale } = useLocale();
  const isMobile = useIsMobile();
  /* Phone transcript question actions meet the 44px minimum. */
  const mob = isMobile ? "min-h-11" : "";
  const pending = file.pendingQuestion;
  const [state, setState] = useState<CardState>("pending");
  const [message, setMessage] = useState("");
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [text, setText] = useState("");
  const [comment, setComment] = useState("");
  const [resuming, setResuming] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  /* Mobile v2 (#1439, lane 4): when the reply went and which picks it
     carried, for the folded `question · answered` line and its expansion. */
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const [answeredPicks, setAnsweredPicks] = useState<Picks>(null);
  const [foldOpen, setFoldOpen] = useState(false);
  const pendingToolUseId = pending?.toolUseId ?? null;
  useEffect(() => {
    if (!pendingToolUseId) return;
    return subscribeQuestionAnswers((event) => {
      if (event.toolUseId !== pendingToolUseId) return;
      if (event.ok) {
        setState("answered");
        setMessage(event.answer);
        setAnsweredAt(event.at);
        setAnsweredPicks(event.picks ?? null);
        setFailedAnswers(null);
        return;
      }
      if (event.superseded !== undefined) {
        setState("superseded");
        setMessage(event.superseded || t("question.alreadyAnswered"));
        return;
      }
      setState("failed");
      setMessage(t(event.key));
      setAttempt({ payload: { text: event.text }, optimistic: event.text, selection: null });
      setFailedAnswers(null);
    });
  }, [pendingToolUseId, t]);
  /* Issue #697: the picks that a failed submit carried. They stay on screen in
     a failed treatment — deleting them lost work the failure never invalidated
     (a multi-question form is several decisions), and leaving them looking
     chosen asserted an acceptance that never happened. */
  const [failedAnswers, setFailedAnswers] = useState<Record<number, number[]> | null>(null);
  /* Issue #765: the toolUseId the operator dismissed in this mount. Keyed by
     id — the component instance survives one pending question being replaced
     by the next, and a dismissal must never carry over to the newcomer. */
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const hasPane = pending ? pending.paneTarget !== null : file.pid !== null && file.proc === "running";

  const selectedLabel = useMemo(() => {
    if (!pending?.questions) return "";
    return pending.questions
      .map((question, index) => (answers[index] ?? []).map((value) => labelFor(question, value)).join(", "))
      .filter(Boolean)
      .join(" · ");
  }, [answers, pending]);

  if (!pending) {
    if (!file.waitingInput) return null;
    const menu = file.waitingInput.menu;
    const busy = state === "delivering";
    const sendDialogKey = async (key: string, label: string) => {
      setState("delivering");
      setMessage("");
      try {
        const res = await fetch("/api/tmux", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "dialog-key",
            path: file.path,
            key,
            ...(menu ? { question: menu.question } : {}),
            ...(/^[1-9]$/.test(key) ? { label } : {}),
          }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          setState("failed");
          setMessage(t(deliveryErrorKey(res.status)));
          return;
        }
        setState("answered");
        setMessage(label);
      } catch {
        setState("failed");
        setMessage(t("common.serverUnavailable"));
      }
    };
    if (state === "answered") {
      return (
        <div id="question" className="my-4 rounded-[8px] border border-success/25 bg-success-soft px-4 py-3 text-[13px] font-semibold text-success">
          {t("question.sentToPane", { text: message })}
        </div>
      );
    }
    return (
      <div id="question" className="my-4 rounded-[8px] border border-warning/45 bg-warning-soft p-4 shadow-1">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">
          <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
        </div>
        <div className="text-[13px] font-semibold text-primary">{t("question.pane", { target: file.waitingInput.target })} · {elapsed(t, file.waitingInput.since)}</div>
        {menu ? (
          <>
            {menu.tabs.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {menu.tabs.map((tab, index) => (
                  <span key={index} className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tab.done ? "bg-success/15 text-success" : "bg-canvas text-muted"}`}>
                    {tab.done ? "✓ " : ""}
                    {tab.label}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-2 text-[14px] font-bold text-primary">{menu.question}</div>
            <div className="mt-2 space-y-1.5">
              {menu.options.map((option) => (
                <button
                  key={option.value}
                  className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60 ${mob} ${
                    option.recommended ? "border-warning/45 bg-warning-soft" : "border-border bg-canvas"
                  }`}
                  disabled={busy || option.value > 9}
                  onClick={() => void sendDialogKey(String(option.value), option.label)}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-card text-[10px] font-bold">
                    {option.value}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold">{option.label}</span>
                    {option.description ? <span className="block text-[12px] text-muted">{option.description}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-canvas px-3 py-2 text-[12px] text-muted">
            {file.waitingInput.screenTail}
          </pre>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["Tab", "Enter", "Escape"] as const).map((key) => (
            <button
              key={key}
              className={`inline-flex items-center justify-center rounded-[8px] border border-border bg-canvas text-[12px] font-semibold text-muted disabled:opacity-60 ${
                isMobile ? "min-h-11 min-w-11 px-3" : "px-2.5 py-1"
              }`}
              disabled={busy}
              onClick={() => void sendDialogKey(key, key === "Escape" ? "Esc" : key)}
            >
              {key === "Escape" ? "Esc" : key}
            </button>
          ))}
          <span className="text-[12px] text-muted">{t("question.keysHint")}</span>
        </div>
        {state === "delivering" ? (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("common.sending")}
          </div>
        ) : null}
        {state === "failed" ? <div className="mt-2 text-[12px] font-semibold text-danger">{message}</div> : null}
      </div>
    );
  }

  /* Issue #765: a dismissed question leaves the composer region entirely —
     the same exit scanner-side retirement takes — and the transcript's tool
     record remains the history. The storage read covers a dismissal recorded
     before this mount (a reload, another pane of the same conversation). */
  if (dismissedFor === pending.toolUseId || isQuestionDismissed(browserStorage(), pending)) return null;

  const dismiss = () => {
    rememberQuestionDismissed(browserStorage(), pending);
    setDismissedFor(pending.toolUseId);
  };
  const dismissButton = (
    <button
      type="button"
      aria-label={t("question.dismiss")}
      className={`ml-auto inline-flex shrink-0 items-center justify-center rounded text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        isMobile ? "h-11 w-11" : "px-0.5"
      }`}
      onClick={dismiss}
    >
      <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
    </button>
  );

  const submit = async (payload: Record<string, unknown>, optimistic: string, selection: Record<number, number[]> | null = null) => {
    setState("delivering");
    setMessage("");
    setAttempt({ payload, optimistic, selection });
    setFailedAnswers(null);
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcriptPath: pending.transcriptPath, toolUseId: pending.toolUseId, kind: pending.kind, ...payload }),
      });
      const json = (await res.json()) as { ok?: boolean; answer?: string; error?: string; superseded?: boolean; noPane?: boolean; delivered?: boolean };
      if (!res.ok || !json.ok) {
        if (res.status === 409 && (json.superseded || json.answer)) {
          /* `answer` is the transcript's recorded answer, operator-facing by
             construction; `error` beside it is not, so it is dropped. */
          setState("superseded");
          setMessage(json.answer ?? t("question.alreadyAnswered"));
          return;
        }
        setState("failed");
        setMessage(t(deliveryErrorKey(res.status, json)));
        setFailedAnswers(selection);
        return;
      }
      const at = Date.now();
      setState("answered");
      setMessage(json.answer ?? optimistic);
      setAnsweredAt(at);
      setAnsweredPicks(selection);
      /* The card's own answer goes out on the same seam a chip's does, so the
         suggested-reply row retires with it (mobile v2, #1439 lane 4): a chip
         left live under an answered question would re-post and get a 409. */
      announceQuestionAnswer({ toolUseId: pending.toolUseId, ok: true, text: optimistic, answer: json.answer ?? optimistic, at, picks: selection });
    } catch {
      setState("failed");
      setMessage(t("common.serverUnavailable"));
      setFailedAnswers(selection);
    }
  };

  /** True while `option` of `qIndex` is a pick that a failed submit carried. */
  const choiceFailed = (qIndex: number, option: number): boolean =>
    (failedAnswers?.[qIndex] ?? []).includes(option);

  const setChoice = (qIndex: number, option: number, multi: boolean) => {
    /* Editing after a failure leaves the failed treatment behind. */
    setFailedAnswers(null);
    setAnswers((current) => {
      const prev = current[qIndex] ?? [];
      const next = multi ? (prev.includes(option) ? prev.filter((item) => item !== option) : [...prev, option]) : [option];
      return { ...current, [qIndex]: next };
    });
  };
  const packedAnswers = (next = answers): number[][] =>
    pending.questions?.map((_, index) => next[index] ?? []) ?? [];
  const questionCount = pending.questions?.length ?? 0;
  const needsExplicitSubmit = questionCount > 1 || (pending.questions?.some((question) => question.multiSelect) ?? false);
  const allAnswered = pending.questions?.every((_, index) => (answers[index] ?? []).length > 0) ?? false;

  const resume = async () => {
    setResuming(true);
    setMessage("");
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", path: file.path }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; target?: string };
      if (!res.ok || !json.ok) {
        setMessage(t("question.openFailed"));
        return;
      }
      /* A structured resume answers with no target; naming the transport in
         its place told the operator a tmux session had opened when none had
         (#1301). */
      setMessage(json.target ? t("question.opened", { target: json.target }) : t("question.openedUnnamed"));
    } catch {
      setMessage(t("common.serverUnavailable"));
    } finally {
      setResuming(false);
    }
  };

  const disabled = state === "delivering" || !hasPane;
  if (state === "answered" && isMobile) {
    /* Mobile v2 (#1439, lane 4; README §4.3): the reply is the user's bubble,
       and the card folds to one quiet 44 px line that expands to the original
       question with the chosen option marked. */
    const replyText = message || selectedLabel;
    const time = answeredClock(locale, answeredAt ?? Date.now());
    const picks = answeredPicks ?? answers;
    return (
      <div id="question" data-mobile-question="answered">
        <div className="mt-3 flex justify-end">
          <div data-question-reply className="max-w-[86%] whitespace-pre-wrap break-words rounded-surface bg-user px-3 py-[9px] text-title leading-[1.45]">
            {replyText}
          </div>
        </div>
        <button
          type="button"
          data-question-fold
          aria-expanded={foldOpen}
          aria-label={t("mobile2.feed.answeredFoldToggle")}
          className="flex min-h-11 w-full items-center gap-1.5 px-0.5 text-left text-ui text-muted"
          onClick={() => setFoldOpen((current) => !current)}
        >
          {foldOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 truncate text-secondary">{t("mobile2.feed.answeredFold", { time })}</span>
        </button>
        {foldOpen ? (
          <div data-question-fold-body className="mb-1 rounded-surface border border-border bg-sunken px-3 py-2.5">
            {pending.kind === "plan" ? (
              <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words text-[13px] text-secondary">{pending.plan}</pre>
            ) : (
              pending.questions?.map((question, qIndex) => (
                <section key={qIndex} className="mt-2 first:mt-0">
                  <p className="text-title font-semibold text-secondary">{question.question}</p>
                  {question.options.map((option, index) => {
                    const chosen = (picks[qIndex] ?? []).includes(index);
                    return (
                      <div
                        key={index}
                        data-choice-state={chosen ? "selected" : undefined}
                        className={`mt-1.5 flex min-h-11 items-center gap-2.5 rounded-control border bg-card px-3 py-1.5 text-title ${chosen ? "border-accent" : "border-border"}`}
                      >
                        <i aria-hidden className={`h-4 w-4 shrink-0 rounded-full border-[1.5px] ${chosen ? "border-accent bg-accent shadow-[inset_0_0_0_3px_var(--surface-card)]" : "border-border"}`} />
                        <span className="min-w-0">{option.label}</span>
                      </div>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        ) : null}
      </div>
    );
  }
  if (state === "answered") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-success/25 bg-success-soft px-4 py-3 text-[13px] font-semibold text-success">
        {t("question.answered", { text: message || selectedLabel })}
      </div>
    );
  }
  if (state === "superseded") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-border bg-sunken px-4 py-3 text-[13px] font-semibold text-muted">
        {t("question.answeredElsewhere", { text: message })}
      </div>
    );
  }

  if (pending && !hasPane && isMobile) {
    /* Mobile v2 (#1439, lane 4; README §4.3, audit finding 6): the question
       with no pane to answer through keeps the phone card's shape — "Needs
       you" header, the question at 15 px / 600, the options as inert rows —
       and states the transport as a caption under it, never as the headline;
       the one control is a 44 px "Open session". */
    const askedAtSeconds = Math.floor(Date.parse(pending.askedAt) / 1000);
    const since = Number.isFinite(askedAtSeconds) ? elapsed(t, askedAtSeconds) : "";
    return (
      <div id="question" data-mobile-question="unreachable" className="mt-3 rounded-surface border border-warning/45 bg-warning-soft px-3 pb-2.5 pt-1">
        <div className="flex min-h-11 items-center gap-1.5 text-label font-bold text-warning">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{since ? `${t("mobile2.feed.needsYou")} · ${since}` : t("mobile2.feed.needsYou")}</span>
          {dismissButton}
        </div>
        {pending.kind === "plan" ? (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-card px-3 py-2 text-[13px]">
            {pending.plan}
          </pre>
        ) : (
          pending.questions?.map((question, qIndex) => (
            <section key={qIndex} className="mt-2 first:mt-0">
              {question.header ? <div className="text-label font-semibold text-muted">{question.header}</div> : null}
              <p className="mb-1 text-title font-semibold text-primary">{question.question}</p>
              {question.options.map((option, index) => (
                <div key={index} className="mt-1.5 flex min-h-11 items-center gap-2.5 rounded-control border border-border bg-card px-3 py-1.5 text-title text-secondary">
                  <i aria-hidden className="h-4 w-4 shrink-0 rounded-full border-[1.5px] border-border" />
                  <span className="min-w-0">{option.label}</span>
                </div>
              ))}
            </section>
          ))
        )}
        <p role="note" data-question-transport="unavailable" className="mt-2 text-label text-muted">{t("question.noPane")}</p>
        <button
          type="button"
          data-question-open-session
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-control bg-accent px-3 text-title font-semibold text-white disabled:opacity-60"
          disabled={resuming}
          onClick={resume}
        >
          {t("question.openSession")}
        </button>
        {message ? <div className="mt-2 text-label font-semibold text-muted">{message}</div> : null}
      </div>
    );
  }

  if (pending && !hasPane) {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-warning/45 bg-warning-soft p-4 shadow-1">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">
            <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
          </span>
          {dismissButton}
        </div>
        {pending.kind === "plan" ? (
          <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-canvas px-3 py-2 text-[13px]">{pending.plan}</pre>
        ) : (
          pending.questions?.map((question, index) => (
            <div key={index} className="mt-2">
              <div className="text-[12px] font-bold text-muted">{question.header}</div>
              <div className="text-[13px] font-semibold text-primary">{question.question}</div>
            </div>
          ))
        )}
        <p role="note" data-question-transport="unavailable" className="mt-3 text-[12px] font-semibold text-muted">{t("question.noPane")}</p>
        <button className="mt-3 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={resuming} onClick={resume}>
          {t("question.openSession")}
        </button>
        {message ? <div className="mt-2 text-[12px] font-semibold text-muted">{message}</div> : null}
      </div>
    );
  }

  if (isMobile) {
    /* Mobile v2 (#1439, lane 4; README §4.3): warning-soft card with a 45%
       warning border, headed `⚠ Needs you · <since>`, the question at 15 px /
       600, each option a 44 px card row with a radio mark that SENDS on tap,
       and the operator's own answer as a 44 px field. Transport, when it
       matters, is the caption under the card, never the headline. */
    const askedAtSeconds = Math.floor(Date.parse(pending.askedAt) / 1000);
    const since = Number.isFinite(askedAtSeconds) ? elapsed(t, askedAtSeconds) : "";
    const status = (
      <>
        {state === "delivering" ? (
          <div className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-ui font-semibold text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("common.sending")}
          </div>
        ) : null}
        {state === "failed" ? (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-danger/30 bg-danger-soft px-2.5 py-2">
            <span className="text-ui font-bold text-danger">{t("question.deliveryFailed")}</span>
            <span className="min-w-0 text-ui font-semibold text-danger">{message}</span>
            {attempt ? (
              <button
                type="button"
                className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-ui font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
                disabled={!hasPane}
                onClick={() => void submit(attempt.payload, attempt.optimistic, attempt.selection)}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden /> {t("question.retryAnswer")}
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );
    return (
      <div id="question" data-mobile-question="pending" className="mt-3 rounded-surface border border-warning/45 bg-warning-soft px-3 pb-2.5 pt-1">
        <div className="flex min-h-11 items-center gap-1.5 text-label font-bold text-warning">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{since ? `${t("mobile2.feed.needsYou")} · ${since}` : t("mobile2.feed.needsYou")}</span>
          {dismissButton}
        </div>
        {pending.kind === "plan" ? (
          <>
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-card px-3 py-2 text-[13px]">
              {pending.plan}
            </pre>
            <textarea
              className="mt-2 min-h-20 w-full resize-y rounded-control border border-border bg-card px-3 py-2 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
              placeholder={t("question.rejectComment")}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control bg-success px-3 text-title font-semibold text-white disabled:opacity-60" disabled={disabled} onClick={() => submit({ approve: true }, t("question.approved"))}>
                <Check className="h-4 w-4" aria-hidden /> {t("question.approve")}
              </button>
              <button className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control bg-danger px-3 text-title font-semibold text-white disabled:opacity-60" disabled={disabled} onClick={() => submit({ approve: false, text: comment }, t("question.rejected"))}>
                <X className="h-4 w-4" aria-hidden /> {t("question.reject")}
              </button>
            </div>
          </>
        ) : (
          <>
            {pending.questions?.map((question, qIndex) => (
              <section key={qIndex} className="mt-2 first:mt-0">
                {question.header ? <div className="text-label font-semibold text-muted">{question.header}</div> : null}
                <p className="mb-1 text-title font-semibold text-primary">{question.question}</p>
                {question.options.map((option, index) => {
                  const selected = (answers[qIndex] ?? []).includes(index);
                  const failed = choiceFailed(qIndex, index);
                  return (
                    <button
                      key={index}
                      type="button"
                      data-choice-state={failed ? "failed" : selected ? "selected" : undefined}
                      className={`mt-1.5 flex min-h-11 w-full items-center gap-2.5 rounded-control border bg-card px-3 py-1.5 text-left text-title focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60 ${
                        failed ? "border-danger/45" : selected ? "border-accent" : "border-border"
                      }`}
                      disabled={disabled}
                      onClick={() => {
                        const nextAnswers = { ...answers, [qIndex]: [index] };
                        setChoice(qIndex, index, question.multiSelect);
                        if (!question.multiSelect && questionCount === 1) void submit({ answers: packedAnswers(nextAnswers) }, option.label, nextAnswers);
                      }}
                    >
                      <i
                        aria-hidden
                        className={`h-4 w-4 shrink-0 rounded-full border-[1.5px] ${
                          failed ? "border-danger" : selected ? "border-accent bg-accent shadow-[inset_0_0_0_3px_var(--surface-card)]" : "border-border"
                        }`}
                      />
                      <span className="min-w-0">
                        <span className="block">
                          {option.label}
                          {failed ? <span className="ml-1.5 text-ui font-semibold text-danger">· {t("question.failedChoice")}</span> : null}
                        </span>
                        {option.description ? <span className="block text-ui text-muted">{option.description}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
            {questionCount <= 1 ? (
              <p data-question-own-answer-hint className="mt-2 text-label text-muted">{t("mobile2.feed.ownAnswerHint")}</p>
            ) : null}
            {questionCount <= 1 ? (
              <div className="mt-2 flex gap-1.5">
                <input
                  className="min-h-11 min-w-0 flex-1 rounded-control border border-border bg-card px-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                  placeholder={t("question.ownAnswer")}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <button
                  type="button"
                  aria-label={t("common.send")}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-accent text-white disabled:opacity-60"
                  disabled={disabled || !text.trim()}
                  onClick={() => submit({ text }, text)}
                >
                  <Send className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : null}
            {needsExplicitSubmit ? (
              <button className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-control bg-accent px-3 text-title font-semibold text-white disabled:opacity-60" disabled={disabled || !allAnswered} onClick={() => submit({ answers: packedAnswers() }, selectedLabel, answers)}>
                <Send className="h-4 w-4" aria-hidden /> {t("common.send")}
              </button>
            ) : null}
          </>
        )}
        {status}
      </div>
    );
  }

  return (
    <div id="question" className="my-4 rounded-[8px] border border-warning/45 bg-warning-soft p-4 shadow-1">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">
          <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
        </span>
        {dismissButton}
      </div>
      {pending.kind === "plan" ? (
        <>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-canvas px-3 py-2 text-[13px]">
            {pending.plan}
          </pre>
          <textarea
            className="mt-3 min-h-20 w-full resize-y rounded-[8px] border border-border bg-canvas px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            placeholder={t("question.rejectComment")}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={`inline-flex items-center gap-1.5 rounded-[8px] bg-success px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled} onClick={() => submit({ approve: true }, t("question.approved"))}>
              <Check className="h-4 w-4" aria-hidden /> {t("question.approve")}
            </button>
            <button className={`inline-flex items-center gap-1.5 rounded-[8px] bg-danger px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled} onClick={() => submit({ approve: false, text: comment }, t("question.rejected"))}>
              <X className="h-4 w-4" aria-hidden /> {t("question.reject")}
            </button>
          </div>
        </>
      ) : (
        <>
          {pending.questions?.map((question, qIndex) => (
            <section key={qIndex} className="mt-3 first:mt-0">
              <div className="mb-1 inline-flex rounded-full bg-canvas px-2 py-0.5 text-[11px] font-bold text-muted">{question.header}</div>
              <div className="mb-2 text-[14px] font-bold text-primary">{question.question}</div>
              <div className="space-y-1.5">
                {question.options.map((option, index) => {
                  const selected = (answers[qIndex] ?? []).includes(index);
                  /* Issue #697: a pick a failed submit carried keeps its place
                     — it is still the operator's choice and still editable —
                     but it wears the failure, so it can be read neither as
                     accepted nor as lost. */
                  const failed = choiceFailed(qIndex, index);
                  return (
                    <button
                      key={index}
                      data-choice-state={failed ? "failed" : selected ? "selected" : undefined}
                      className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${mob} ${
                        failed
                          ? "border-danger/45 bg-danger-soft"
                          : selected
                            ? "border-accent/45 bg-accent/10"
                            : option.recommended
                              ? "border-warning/45 bg-warning-soft"
                              : "border-border bg-canvas"
                      }`}
                      disabled={disabled}
                      onClick={() => {
                        const nextAnswers = { ...answers, [qIndex]: [index] };
                        setChoice(qIndex, index, question.multiSelect);
                        if (!question.multiSelect && questionCount === 1) void submit({ answers: packedAnswers(nextAnswers) }, option.label, nextAnswers);
                      }}
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border bg-card text-[10px] font-bold ${
                          failed ? "border-danger/45 text-danger" : "border-border"
                        }`}
                      >
                        {failed ? "!" : selected ? "✓" : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-bold">
                          {option.label}
                          {failed ? <span className="ml-1.5 font-semibold text-danger">· {t("question.failedChoice")}</span> : null}
                        </span>
                        {option.description ? <span className="block text-[12px] text-muted">{option.description}</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {questionCount <= 1 ? (
            <div className="mt-3 flex gap-2">
              <input
                className={`min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${mob}`}
                placeholder={t("question.ownAnswer")}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <button className={`inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled || !text.trim()} onClick={() => submit({ text }, text)}>
                <Send className="h-4 w-4" aria-hidden /> {t("common.send")}
              </button>
            </div>
          ) : null}
          {needsExplicitSubmit ? (
            <button className={`mt-3 inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled || !allAnswered} onClick={() => submit({ answers: packedAnswers() }, selectedLabel, answers)}>
              <Send className="h-4 w-4" aria-hidden /> {t("common.send")}
            </button>
          ) : null}
        </>
      )}
      {state === "delivering" ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("common.sending")}
        </div>
      ) : null}
      {/* Issue #697: the failure states what did not happen and offers the
          recovery, so the strip's "waiting for a reply" and the card agree —
          the question is still open and the operator can resend. */}
      {state === "failed" ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded-[8px] border border-danger/30 bg-danger-soft px-2.5 py-2">
          <span className="text-[12px] font-bold text-danger">{t("question.deliveryFailed")}</span>
          <span className="min-w-0 text-[12px] font-semibold text-danger">{message}</span>
          {attempt ? (
            <button
              type="button"
              className={`ml-auto inline-flex items-center gap-1.5 rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${mob}`}
              disabled={!hasPane}
              onClick={() => void submit(attempt.payload, attempt.optimistic, attempt.selection)}
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden /> {t("question.retryAnswer")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
