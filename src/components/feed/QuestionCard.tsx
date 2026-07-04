"use client";

import { Check, Loader2, Pause, Send, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { FileEntry, PendingQuestionItem } from "@/lib/types";

type CardState = "pending" | "delivering" | "answered" | "superseded" | "failed";

function labelFor(question: PendingQuestionItem, value: number): string {
  return question.options[value]?.label ?? String(value + 1);
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - since));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} хв` : `${Math.floor(minutes / 60)} год`;
}

export function QuestionCard({ file }: { file: FileEntry }) {
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
    return (
      <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> чекає на відповідь
        </div>
        <div className="text-[13px] font-semibold text-ink">Пейн {file.waitingInput.target} · {elapsed(file.waitingInput.since)}</div>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-[8px] border border-line bg-bg px-3 py-2 text-[12px] text-dim">
          {file.waitingInput.screenTail}
        </pre>
        <div className="mt-3 text-[12px] text-dim">Можна відповісти через композер нижче.</div>
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
          setMessage(json.answer ?? json.error ?? "відповідь уже записана");
          return;
        }
        setState("failed");
        setMessage(json.error ?? "не вдалося надіслати");
        return;
      }
      setState("answered");
      setMessage(json.answer ?? optimistic);
    } catch {
      setState("failed");
      setMessage("сервер недоступний");
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
        setMessage(json.error ?? "не вдалося відкрити сесію");
        return;
      }
      setMessage(`відкрито ${json.target ?? "tmux"}`);
    } catch {
      setMessage("сервер недоступний");
    } finally {
      setResuming(false);
    }
  };

  const disabled = state === "delivering" || !hasPane;
  if (state === "answered") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-ok/25 bg-[#eefaf1] px-4 py-3 text-[13px] font-semibold text-ok">
        Відповідено: {message || selectedLabel}
      </div>
    );
  }
  if (state === "superseded") {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-line bg-chip px-4 py-3 text-[13px] font-semibold text-dim">
        Відповідено в іншому місці: {message}
      </div>
    );
  }

  if (pending && !hasPane) {
    return (
      <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> чекає на відповідь
        </div>
        <div className="text-[13px] font-semibold text-err">tmux-пейн недоступний</div>
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
          відкрити сесію
        </button>
        {message ? <div className="mt-2 text-[12px] font-semibold text-dim">{message}</div> : null}
      </div>
    );
  }

  return (
    <div id="question" className="my-4 rounded-[8px] border border-[#e0ae45]/45 bg-[#fff9ed] p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f5dfae] px-2 py-0.5 text-[11px] font-bold text-[#8a5a00]">
          <Pause className="h-3.5 w-3.5" aria-hidden /> чекає на відповідь
        </span>
        {!hasPane ? <span className="text-[12px] font-semibold text-err">tmux-пейн недоступний</span> : null}
      </div>
      {pending.kind === "plan" ? (
        <>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px]">
            {pending.plan}
          </pre>
          <textarea
            className="mt-3 min-h-20 w-full resize-y rounded-[8px] border border-line bg-bg px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
            placeholder="Коментар до відхилення…"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="inline-flex items-center gap-1.5 rounded-[8px] bg-ok px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={disabled} onClick={() => submit({ approve: true }, "затверджено")}>
              <Check className="h-4 w-4" aria-hidden /> Затвердити
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-[8px] bg-err px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={disabled} onClick={() => submit({ approve: false, text: comment }, "відхилено")}>
              <X className="h-4 w-4" aria-hidden /> Відхилити
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
                      className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 ${
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
                className="min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                placeholder="Своя відповідь…"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <button className="inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={disabled || !text.trim()} onClick={() => submit({ text }, text)}>
                <Send className="h-4 w-4" aria-hidden /> Надіслати
              </button>
            </div>
          ) : null}
          {needsExplicitSubmit ? (
            <button className="mt-3 inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60" disabled={disabled || !allAnswered} onClick={() => submit({ answers: packedAnswers() }, selectedLabel)}>
              <Send className="h-4 w-4" aria-hidden /> Надіслати
            </button>
          ) : null}
        </>
      )}
      {state === "delivering" ? (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-dim">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> надсилаю…
        </div>
      ) : null}
      {state === "failed" ? <div className="mt-3 text-[12px] font-semibold text-err">{message}</div> : null}
    </div>
  );
}
