"use client";

import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import type { AttentionKind, RuntimeAttention } from "./runtimeModel";

const KIND_LABEL: Record<AttentionKind, "runtime.attention.approval" | "runtime.attention.permission" | "runtime.attention.question" | "runtime.attention.waiting_heuristic"> = {
  approval: "runtime.attention.approval",
  permission: "runtime.attention.permission",
  question: "runtime.attention.question",
  waiting_heuristic: "runtime.attention.waiting_heuristic",
};

export interface AttentionCardProps {
  attention: RuntimeAttention;
  onApprove?: () => void;
  onDeny?: () => void;
  onAnswerQuestion?: (optionIndex: number, questionIndex?: number) => void;
  onAnswerQuestions?: (answers: number[][]) => void;
  busy?: boolean;
}

/**
 * A structured attention request — the real command/tool/question, never a
 * scraped menu. The heuristic tier is visually muted (lower confidence);
 * `unowned` is a red alarm pinned to the top. Fully keyboard-operable and
 * focus-trapped while open (Enter approves, Esc denies); pulse/scale respect
 * reduced motion. The `autoResolutionMs` countdown is display-only — only an
 * engine-confirmed resolution closes the card (Sol: no client auto-resolve).
 */
export function AttentionCard({ attention, onApprove, onDeny, onAnswerQuestion, onAnswerQuestions, busy }: AttentionCardProps) {
  const { t } = useLocale();
  const cardRef = useRef<HTMLDivElement>(null);
  const heuristic = attention.kind === "waiting_heuristic";
  const remaining = useCountdown(attention.autoResolutionMs ?? null);
  const [selections, setSelections] = useState<Record<number, number[]>>({});
  const [selectionAttentionId, setSelectionAttentionId] = useState(attention.id);
  if (selectionAttentionId !== attention.id) {
    setSelectionAttentionId(attention.id);
    setSelections({});
  }

  // Focus the first control and trap Tab within the card while it is open.
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onDeny) {
        event.preventDefault();
        onDeny();
        return;
      }
      if (event.key === "Enter" && onApprove && (event.target as HTMLElement)?.tagName !== "BUTTON") {
        event.preventDefault();
        onApprove();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => node.removeEventListener("keydown", onKey);
  }, [attention.id, onApprove, onDeny]);

  const questions = attention.request.questions
    ?? (attention.request.question ? [attention.request.question] : []);
  const border = attention.unowned
    ? "border-danger/60 bg-danger/5"
    : heuristic
      ? "border-dashed border-border bg-canvas"
      : "border-warning/45 bg-warning-soft";

  return (
    <div
      ref={cardRef}
      role="group"
      aria-label={t("runtime.attention.title")}
      data-attention-kind={attention.kind}
      className={`my-3 rounded-[8px] border p-4 shadow-1 ${border}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {attention.unowned ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-bold text-danger" role="alert">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {t("runtime.attention.unowned")}
          </span>
        ) : null}
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${heuristic ? "bg-sunken text-muted" : "bg-warning-soft text-warning"}`}>
          {t(KIND_LABEL[attention.kind])}
        </span>
        {heuristic ? <span className="text-[11px] text-muted">{t("runtime.attention.heuristicNote")}</span> : null}
        {remaining !== null ? (
          <span className="text-[11px] font-semibold text-muted" role="timer" aria-live="off">
            {t("runtime.attention.expiresIn", { seconds: remaining })}
          </span>
        ) : null}
      </div>

      {attention.request.title ? <div className="text-[13px] font-semibold text-primary">{attention.request.title}</div> : null}

      {attention.request.command ? (
        <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-canvas px-3 py-2 text-[12px]">
          <span className="mb-1 block text-[10px] font-semibold text-secondary">{t("runtime.attention.command")}</span>
          {attention.request.command}
        </pre>
      ) : null}

      {attention.request.tool ? (
        <div className="mt-2 text-[13px]">
          <span className="text-[11px] font-semibold text-secondary">{t("runtime.attention.tool")}</span>{" "}
          <span className="font-semibold text-primary">{attention.request.tool}</span>
        </div>
      ) : null}

      {attention.request.detail ? <div className="mt-2 text-[12px] text-muted">{attention.request.detail}</div> : null}

      {questions.length > 0 ? (
        <div className="mt-2 space-y-3">
          {questions.map((question, questionIndex) => {
            const staged = questions.length > 1 || question.multiSelect === true;
            const selected = selections[questionIndex] ?? [];
            return <div key={questionIndex}>
              {question.header ? <div className="text-[11px] font-bold text-muted">{question.header}</div> : null}
              <div className="text-[14px] font-bold text-primary">{question.prompt}</div>
              <div className="mt-2 space-y-1.5">
                {(question.options ?? []).map((option, index) => (
              <button
                key={index}
                className={`flex w-full items-start gap-2 rounded-[8px] border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60 ${
                  selected.includes(index) ? "border-accent bg-accent/10" : option.recommended ? "border-warning/45 bg-warning-soft" : "border-border bg-canvas"
                }`}
                disabled={busy}
                onClick={() => {
                  if (!staged) {
                    onAnswerQuestion?.(index, questionIndex);
                    return;
                  }
                  setSelections((current) => {
                    const prior = current[questionIndex] ?? [];
                    const next = question.multiSelect
                      ? prior.includes(index) ? prior.filter((candidate) => candidate !== index) : [...prior, index]
                      : [index];
                    return { ...current, [questionIndex]: next };
                  });
                }}
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border bg-card text-[10px] font-bold">{index + 1}</span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold">{option.label}</span>
                  {option.description ? <span className="block text-[12px] text-muted">{option.description}</span> : null}
                </span>
              </button>
                ))}
              </div>
            </div>;
          })}
          {questions.length > 1 || questions.some((question) => question.multiSelect) ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-[8px] bg-accent px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60"
              disabled={busy || questions.some((_question, index) => !(selections[index]?.length))}
              onClick={() => onAnswerQuestions?.(questions.map((_question, index) => selections[index] ?? []))}
            >
              <Check className="h-4 w-4" aria-hidden /> {t("runtime.attention.answer")}
            </button>
          ) : null}
          </div>
      ) : null}

      {(attention.kind === "approval" || attention.kind === "permission") && (onApprove || onDeny) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onApprove ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-[8px] bg-success px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60"
              disabled={busy}
              onClick={onApprove}
            >
              <Check className="h-4 w-4" aria-hidden /> {t("runtime.attention.approve")}
            </button>
          ) : null}
          {onDeny ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-[8px] bg-danger px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-60"
              disabled={busy}
              onClick={onDeny}
            >
              <X className="h-4 w-4" aria-hidden /> {t("runtime.attention.deny")}
            </button>
          ) : null}
          <span className="text-[11px] text-muted">{t("runtime.attention.keysHint")}</span>
        </div>
      ) : null}

      {busy ? (
        <div className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> {t("runtime.attention.answering")}
        </div>
      ) : null}
    </div>
  );
}

/** Display-only countdown in whole seconds. Never fires a client resolution. */
function useCountdown(totalMs: number | null): number | null {
  const initial = totalMs === null ? null : Math.max(0, Math.ceil(totalMs / 1000));
  const [remaining, setRemaining] = useState<number | null>(initial);
  /* Reset during render when the request changes (the repo's render-phase
     adjustment pattern), so the effect only owns the ticking interval. */
  const [seen, setSeen] = useState<number | null>(totalMs);
  if (totalMs !== seen) {
    setSeen(totalMs);
    setRemaining(initial);
  }
  useEffect(() => {
    if (totalMs === null) return;
    const timer = window.setInterval(() => setRemaining((prev) => (prev === null || prev <= 0 ? 0 : prev - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [totalMs]);
  return remaining;
}
