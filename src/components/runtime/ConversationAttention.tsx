"use client";

import { useState } from "react";

import { QuestionCard } from "@/components/feed/QuestionCard";
import { useRuntimeSession, answerRuntime } from "@/hooks/useRuntime";
import { conversationIdentity } from "@/lib/accounts/identity";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AttentionCard } from "./AttentionCard";
import { mintIdempotencyKey, type RuntimeAttention } from "./runtimeModel";

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

  if (!runtime) {
    return file.pendingQuestion || file.waitingInput ? <QuestionCard file={file} /> : null;
  }
  if (runtime.legacy) {
    return file.pendingQuestion || file.waitingInput ? <QuestionCard file={file} /> : null;
  }

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

  return (
    <>
      {runtime.attentions.map((attention) => (
        <AttentionCard
          key={attention.id}
          attention={attention}
          busy={busyId === attention.id}
          onApprove={attention.kind === "approval" || attention.kind === "permission"
            ? () => void answer(attention, approvalResolution(attention, true))
            : undefined}
          onDeny={attention.kind === "approval" || attention.kind === "permission"
            ? () => void answer(attention, approvalResolution(attention, false))
            : undefined}
          onAnswerQuestion={attention.kind === "question"
            ? (optionIndex) => void answer(attention, questionResolution(attention, optionIndex))
            : undefined}
          onAnswerQuestions={attention.kind === "question"
            ? (optionIndices) => void answer(attention, questionsResolution(attention, optionIndices))
            : undefined}
        />
      ))}
      {error ? <div role="alert" className="my-2 text-[12px] font-semibold text-danger">{error}</div> : null}
    </>
  );
}
