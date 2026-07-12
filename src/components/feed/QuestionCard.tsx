"use client";

import { Check, Loader2, Pause, Send, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { type TFunction, useLocale } from "@/lib/i18n";
import type { FileEntry, PendingQuestionItem } from "@/lib/types";

type CardState = "pending" | "delivering" | "answered" | "superseded" | "failed";

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
          setMessage(json.error ?? t("common.failedSend"));
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
        <div id="question" className="my-4 rounded-[8px] border border-ok/25 bg-[#eefaf1] px-4 py-3 text-[13px] font-semibold text-ok">
          {t("question.sentToPane", { text: message })}
        </div>
      );
    }
    return (
      <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
        </div>
        <div className="text-[13px] font-semibold text-ink">{t("question.pane", { target: file.waitingInput.target })} · {elapsed(t, file.waitingInput.since)}</div>
        {menu ? (
          <>
            {menu.tabs.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {menu.tabs.map((tab, index) => (
                  <span key={index} className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tab.done ? "bg-ok/15 text-ok" : "bg-bg text-dim"}`}>
                    {tab.done ? "✓ " : ""}
                    {tab.label}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="mt-2 text-[14px] font-bold text-ink">{menu.question}</div>
            <div className="mt-2 space-y-1.5">
              {menu.options.map((option) => (
                <button
                  key={option.value}
                  className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60 ${mob} ${
                    option.recommended ? "border-[#e0ae45]/45 bg-[#fff5dc]" : "border-line bg-bg"
                  }`}
                  disabled={busy || option.value > 9}
                  onClick={() => void sendDialogKey(String(option.value), option.label)}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line bg-panel text-[10px] font-bold">
                    {option.value}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold">{option.label}</span>
                    {option.description ? <span className="block text-[12px] text-dim">{option.description}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-bg px-3 py-2 text-[12px] text-dim">
            {file.waitingInput.screenTail}
          </pre>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(["Tab", "Enter", "Escape"] as const).map((key) => (
            <button
              key={key}
              className={`inline-flex items-center justify-center rounded-[8px] border border-line bg-bg text-[12px] font-semibold text-dim disabled:opacity-60 ${
                isMobile ? "min-h-11 min-w-11 px-3" : "px-2.5 py-1"
              }`}
              disabled={busy}
              onClick={() => void sendDialogKey(key, key === "Escape" ? "Esc" : key)}
            >
              {key === "Escape" ? "Esc" : key}
            </button>
          ))}
          <span className="text-[12px] text-dim">{t("question.keysHint")}</span>
        </div>
        {state === "delivering" ? (
          <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("common.sending")}
          </div>
        ) : null}
        {state === "failed" ? <div className="mt-2 text-[12px] font-semibold text-err">{message}</div> : null}
      </div>
    );
  }

  const submit = async (payload: Record<string, unknown>, optimistic: string) => {
    setState("delivering");
    setMessage("");
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcriptPath: pending.transcriptPath, toolUseId: pending.toolUseId, kind: pending.kind, ...payload }),
      });
      const json = (await res.json()) as { ok?: boolean; answer?: string; error?: string; superseded?: boolean };
      if (!res.ok || !json.ok) {
        if (res.status === 409 && (json.superseded || json.answer)) {
          setState("superseded");
          setMessage(json.answer ?? json.error ?? t("question.alreadyAnswered"));
          return;
        }
        setState("failed");
        setMessage(json.error ?? t("common.failedSend"));
        return;
      }
      setState("answered");
      setMessage(json.answer ?? optimistic);
    } catch {
      setState("failed");
      setMessage(t("common.serverUnavailable"));
    }
  };

  const setChoice = (qIndex: number, option: number, multi: boolean) => {
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
        setMessage(json.error ?? t("question.openFailed"));
        return;
      }
      setMessage(t("question.opened", { target: json.target ?? "tmux" }));
    } catch {
      setMessage(t("common.serverUnavailable"));
    } finally {
      setResuming(false);
    }
  };

  const disabled = state === "delivering" || !hasPane;
  if (state === "answered") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-ok/25 bg-[#eefaf1] px-4 py-3 text-[13px] font-semibold text-ok">
        {t("question.answered", { text: message || selectedLabel })}
      </div>
    );
  }
  if (state === "superseded") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-line bg-chip px-4 py-3 text-[13px] font-semibold text-dim">
        {t("question.answeredElsewhere", { text: message })}
      </div>
    );
  }

  if (pending && !hasPane) {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
        </div>
        <div className="text-[13px] font-semibold text-err">{t("question.noPane")}</div>
        {pending.kind === "plan" ? (
          <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px]">{pending.plan}</pre>
        ) : (
          pending.questions?.map((question, index) => (
            <div key={index} className="mt-2">
              <div className="text-[12px] font-bold text-dim">{question.header}</div>
              <div className="text-[13px] font-semibold text-ink">{question.question}</div>
            </div>
          ))
        )}
        <button className="mt-3 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={resuming} onClick={resume}>
          {t("question.openSession")}
        </button>
        {message ? <div className="mt-2 text-[12px] font-semibold text-dim">{message}</div> : null}
      </div>
    );
  }

  return (
    <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> {t("question.waiting")}
        </span>
        {!hasPane ? <span className="text-[12px] font-semibold text-err">{t("question.noPane")}</span> : null}
      </div>
      {pending.kind === "plan" ? (
        <>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px]">
            {pending.plan}
          </pre>
          <textarea
            className="mt-3 min-h-20 w-full resize-y rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            placeholder={t("question.rejectComment")}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={`inline-flex items-center gap-1.5 rounded-[8px] bg-ok px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled} onClick={() => submit({ approve: true }, t("question.approved"))}>
              <Check className="h-4 w-4" aria-hidden /> {t("question.approve")}
            </button>
            <button className={`inline-flex items-center gap-1.5 rounded-[8px] bg-err px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled} onClick={() => submit({ approve: false, text: comment }, t("question.rejected"))}>
              <X className="h-4 w-4" aria-hidden /> {t("question.reject")}
            </button>
          </div>
        </>
      ) : (
        <>
          {pending.questions?.map((question, qIndex) => (
            <section key={qIndex} className="mt-3 first:mt-0">
              <div className="mb-1 inline-flex rounded-full bg-bg px-2 py-0.5 text-[11px] font-bold text-dim">{question.header}</div>
              <div className="mb-2 text-[14px] font-bold text-ink">{question.question}</div>
              <div className="space-y-1.5">
                {question.options.map((option, index) => {
                  const selected = (answers[qIndex] ?? []).includes(index);
                  return (
                    <button
                      key={index}
                      className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${mob} ${
                        selected ? "border-accent/45 bg-accent/10" : option.recommended ? "border-[#e0ae45]/45 bg-[#fff5dc]" : "border-line bg-bg"
                      }`}
                      disabled={disabled}
                      onClick={() => {
                        const nextAnswers = { ...answers, [qIndex]: [index] };
                        setChoice(qIndex, index, question.multiSelect);
                        if (!question.multiSelect && questionCount === 1) void submit({ answers: packedAnswers(nextAnswers) }, option.label);
                      }}
                    >
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line bg-panel text-[10px] font-bold">
                        {selected ? "✓" : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-bold">{option.label}</span>
                        {option.description ? <span className="block text-[12px] text-dim">{option.description}</span> : null}
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
                className={`min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${mob}`}
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
            <button className={`mt-3 inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60 ${mob}`} disabled={disabled || !allAnswered} onClick={() => submit({ answers: packedAnswers() }, selectedLabel)}>
              <Send className="h-4 w-4" aria-hidden /> {t("common.send")}
            </button>
          ) : null}
        </>
      )}
      {state === "delivering" ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-dim">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("common.sending")}
        </div>
      ) : null}
      {state === "failed" ? <div className="mt-3 text-[12px] font-semibold text-err">{message}</div> : null}
    </div>
  );
}
