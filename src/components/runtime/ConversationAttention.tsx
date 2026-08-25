"use client";

import { useState } from "react";

import { QuestionCard } from "@/components/feed/QuestionCard";
import { useRuntimeSession, answerRuntime } from "@/hooks/useRuntime";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AttentionCard } from "./AttentionCard";
import { isDeadHostSession } from "./DeadHostBanner";
import { mintIdempotencyKey, type RuntimeAttention } from "./runtimeModel";

/*
 * Issue #765, structured half: dismissal is a view decision, exactly as on the
 * transcript-path QuestionCard (#779). It never answers or resolves the
 * attention — the runtime record stays whatever the engine says it is — the
 * card only stops occupying the live composer region and stops presenting
 * itself as awaiting input. Remembered per attention id in localStorage so a
 * dead card does not return on every reload.
 */
type StorageLike = Pick<Storage, "getItem" | "setItem">;
type AttentionIdentity = { conversationId: string; id: string };

export function attentionDismissKey(attention: AttentionIdentity): string {
  return `llvAttentionDismissed:${attention.conversationId}:${attention.id}`;
}

export function isAttentionDismissed(storage: StorageLike | null, attention: AttentionIdentity): boolean {
  try {
    return storage?.getItem(attentionDismissKey(attention)) === "1";
  } catch {
    return false;
  }
}

export function rememberAttentionDismissed(storage: StorageLike | null, attention: AttentionIdentity): void {
  try {
    storage?.setItem(attentionDismissKey(attention), "1");
  } catch { /* best-effort: a full or blocked store only costs durability */ }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function approvalResolution(attention: RuntimeAttention, approved: boolean): unknown {
  const protocol = attention.request.protocol;
  if (protocol?.engine === "claude") {
    return approved
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Denied in Viewer" };
  }
  return { decision: approved ? "accept" : "decline" };
}

export function questionResolution(attention: RuntimeAttention, optionIndex: number): unknown {
  return questionsResolution(attention, [[optionIndex]]);
}

export function questionsResolution(attention: RuntimeAttention, optionIndices: number[][]): unknown {
  const questions = attention.request.questions
    ?? (attention.request.question ? [attention.request.question] : []);
  const labels = questions.map((question, questionIndex) => (optionIndices[questionIndex] ?? [])
    .map((optionIndex) => question.options?.[optionIndex]?.label ?? String(optionIndex + 1)));
  const protocol = attention.request.protocol;
  if (protocol?.engine === "claude") {
    const answers = Object.fromEntries(questions.map((question, index) => [question.prompt, labels[index]!.join(", ")]));
    return { behavior: "allow", updatedInput: { ...(protocol.input ?? {}), answers } };
  }
  const questionIds = protocol?.questionIds ?? (protocol?.questionId ? [protocol.questionId] : []);
  const answers = Object.fromEntries(labels.map((answerLabels, index) => [questionIds[index] ?? `answer_${index + 1}`, { answers: answerLabels }]));
  return { answers };
}

export function ConversationAttention({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const runtime = useRuntimeSession(conversationIdentity(file));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* Ids dismissed in this mount; the storage read below covers earlier ones. */
  const [dismissedIds, setDismissedIds] = useState<readonly string[]>([]);

  if (!runtime) {
    return file.pendingQuestion || file.waitingInput ? <QuestionCard file={file} /> : null;
  }
  if (runtime.legacy) {
    return file.pendingQuestion || file.waitingInput ? <QuestionCard file={file} /> : null;
  }

  /* When the host died the banner (§5) owns recovery: these cards can never be
     answered (the request died with the host), so they render as inert history
     — dimmed, buttons removed, a one-line "expired" caption. No POST is ever
     attempted from an archived card. */
  const archived = isDeadHostSession(runtime);

  const answer = async (attention: RuntimeAttention, resolution: unknown) => {
    setBusyId(attention.id);
    setError(null);
    const result = await answerRuntime(
      runtime.session.conversationId,
      attention.id,
      resolution,
      mintIdempotencyKey(),
    );
    if (!result.ok) setError(result.error ?? t("common.failedSend"));
    setBusyId(null);
  };

  /* Issue #765: a dismissed question card leaves the composer region entirely
     — the same exit an engine-confirmed resolution takes — while the attention
     record itself is untouched. Only question cards get the control: dismissing
     an approval/permission would hide a request the engine is still blocked on
     with no other surface to answer it from. */
  const dismiss = (attention: RuntimeAttention) => {
    rememberAttentionDismissed(browserStorage(), attention);
    setDismissedIds((current) => [...current, attention.id]);
  };
  const visible = runtime.attentions.filter((attention) =>
    !dismissedIds.includes(attention.id) && !isAttentionDismissed(browserStorage(), attention));

  return (
    <>
      {visible.map((attention) => (
        <AttentionCard
          key={attention.id}
          attention={attention}
          archived={archived}
          busy={busyId === attention.id}
          onApprove={!archived && (attention.kind === "approval" || attention.kind === "permission")
            ? () => void answer(attention, approvalResolution(attention, true))
            : undefined}
          onDeny={!archived && (attention.kind === "approval" || attention.kind === "permission")
            ? () => void answer(attention, approvalResolution(attention, false))
            : undefined}
          onAnswerQuestion={!archived && attention.kind === "question"
            ? (optionIndex) => void answer(attention, questionResolution(attention, optionIndex))
            : undefined}
          onAnswerQuestions={!archived && attention.kind === "question"
            ? (optionIndices) => void answer(attention, questionsResolution(attention, optionIndices))
            : undefined}
          onDismiss={!archived && attention.kind === "question" ? () => dismiss(attention) : undefined}
        />
      ))}
      {error ? <div role="alert" className="my-2 text-[12px] font-semibold text-danger">{error}</div> : null}
    </>
  );
}
