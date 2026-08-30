"use client";

import { Check, Loader2, Pause, RotateCw, Send, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { type MessageKey, type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry, PendingQuestionItem } from "@/lib/types";

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
  const { t } = useLocale();
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
      setState("answered");
      setMessage(json.answer ?? optimistic);
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
