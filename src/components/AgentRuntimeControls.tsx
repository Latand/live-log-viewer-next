"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { conversationIdentity } from "@/lib/accounts/identity";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

type Draft = { model: string; effort: string; fast: boolean };
type ApplyState = "idle" | "saving" | "pending" | "confirming" | "applied" | "error";

function storageKey(file: FileEntry): string {
  return `llvAgentRuntime:${conversationIdentity(file)}`;
}

function defaults(file: FileEntry): Draft {
  const engine = file.engine as "claude" | "codex";
  const models = ENGINE_MODELS[engine];
  const observedModel = engine === "claude" ? normalizeClaudeLaunchModel(file.launchModel ?? file.model) : file.model;
  const model = models.some((item) => item.id === observedModel) ? observedModel! : models[0]!.id;
  const efforts = effortScale(engine, model) ?? [];
  return { model, effort: efforts.includes(file.effort ?? "") ? file.effort! : efforts[0]!, fast: file.fast ?? false };
}

function readDraft(file: FileEntry): Draft {
  const fallback = defaults(file);
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(file)) ?? "null") as Partial<Draft> | null;
    const engine = file.engine as "claude" | "codex";
    const model = ENGINE_MODELS[engine].some((item) => item.id === value?.model) ? value!.model! : fallback.model;
    const efforts = effortScale(engine, model) ?? [];
    return {
      model,
      effort: efforts.includes(value?.effort ?? "") ? value!.effort! : fallback.effort,
      fast: engine === "codex" && typeof value?.fast === "boolean" ? value.fast : fallback.fast,
    };
  } catch {
    return fallback;
  }
}

export function AgentRuntimeControls({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const engine = file.engine as "claude" | "codex";
  const [draft, setDraft] = useState<Draft>(() => defaults(file));
  const [state, setState] = useState<ApplyState>("idle");
  const [error, setError] = useState("");
  const revisionRef = useRef(0);
  const efforts = useMemo(() => effortScale(engine, draft.model) ?? [], [engine, draft.model]);
  const editDraft = (update: (current: Draft) => Draft) => {
    revisionRef.current += 1;
    localStorage.removeItem(storageKey(file) + ":phase");
    setDraft(update);
    setState("idle");
  };

  useEffect(() => {
    const stored = readDraft(file);
    setDraft(stored);
    const phase = localStorage.getItem(storageKey(file) + ":phase");
    setState(phase === "pending" || phase === "confirming" ? phase : "idle");
  }, [file.path]);

  useEffect(() => {
    localStorage.setItem(storageKey(file), JSON.stringify(draft));
  }, [draft, file]);

  const apply = async () => {
    if (state === "saving") return;
    const revision = revisionRef.current;
    setState("saving");
    setError("");
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconfigure", path: file.path, ...draft, fast: engine === "codex" ? draft.fast : undefined }),
      });
      const body = await response.json() as { ok?: boolean; outcome?: string; error?: string };
      if (revision !== revisionRef.current) return;
      if (!response.ok || !body.ok) throw new Error(body.error ?? t("runtimeConfig.failed"));
      const pending = body.outcome === "pending";
      const phase = pending ? "pending" : "confirming";
      localStorage.setItem(storageKey(file) + ":phase", phase);
      setState(phase);
    } catch (cause) {
      if (revision !== revisionRef.current) return;
      setError(cause instanceof Error ? cause.message : t("runtimeConfig.failed"));
      setState("error");
    }
  };

  useEffect(() => {
    if (state !== "pending") return;
    const id = window.setInterval(() => void apply(), 1500);
    return () => window.clearInterval(id);
  });

  useEffect(() => {
    if (state !== "confirming") return;
    const observedModel = engine === "claude" ? normalizeClaudeLaunchModel(file.launchModel ?? file.model) : file.model;
    const modelMatches = observedModel === draft.model;
    const effortMatches = file.effort === draft.effort;
    const speedMatches = engine === "claude" || file.fast === draft.fast;
    if (!modelMatches || !effortMatches || !speedMatches) return;
    localStorage.removeItem(storageKey(file) + ":phase");
    setState("applied");
  }, [draft, engine, file, state]);

  const selectClass = "h-6 rounded-full border border-line bg-bg px-1.5 font-mono text-[9.5px] font-semibold text-[#555] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  return (
    <div className="inline-flex min-w-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()} title={error || undefined}>
      <select
        className={selectClass}
        aria-label={t("runtimeConfig.model")}
        value={draft.model}
        onChange={(event) => {
          const model = event.target.value;
          const scale = effortScale(engine, model) ?? [];
          editDraft((current) => ({ ...current, model, effort: scale.includes(current.effort) ? current.effort : scale[0]! }));
        }}
      >
        {ENGINE_MODELS[engine].map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>
      <select className={selectClass} aria-label={t("runtimeConfig.effort")} value={draft.effort} onChange={(event) => editDraft((current) => ({ ...current, effort: event.target.value }))}>
        {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
      </select>
      {engine === "codex" ? (
        <label className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-bg px-1.5 font-mono text-[9.5px] font-semibold text-[#555]" title={t("runtimeConfig.speedTitle")}>
          <input type="checkbox" checked={draft.fast} onChange={(event) => editDraft((current) => ({ ...current, fast: event.target.checked }))} /> fast
        </label>
      ) : null}
      <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-bg px-1.5 text-[9.5px] font-semibold text-dim hover:border-accent/45 hover:text-accent disabled:opacity-60" disabled={state === "saving"} onClick={() => void apply()} aria-label={t("runtimeConfig.apply")}>
        {state === "saving" || state === "pending" || state === "confirming" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
        {state === "pending" ? t("runtimeConfig.pending") : state === "confirming" ? t("runtimeConfig.confirming") : state === "applied" ? t("runtimeConfig.applied") : t("runtimeConfig.apply")}
      </button>
    </div>
  );
}
