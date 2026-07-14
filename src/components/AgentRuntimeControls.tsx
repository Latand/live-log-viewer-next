"use client";

import { Check, Loader2, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { effortTierLabel } from "@/components/builderCopy";
import { X } from "@/components/icons";
import { Select } from "@/components/ui/Select";
import { useIsMobile } from "@/hooks/useIsMobile";
import { conversationIdentity } from "@/lib/accounts/identity";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

export type RuntimeDraft = { model: string; effort: string; fast: boolean };
export type RuntimeApplyState = "idle" | "saving" | "pending" | "confirming" | "applied" | "error";

function storageKey(file: FileEntry): string {
  return `llvAgentRuntime:${conversationIdentity(file)}`;
}

function defaults(file: FileEntry): RuntimeDraft {
  const engine = file.engine as "claude" | "codex";
  const models = ENGINE_MODELS[engine];
  const observedModel = engine === "claude" ? normalizeClaudeLaunchModel(file.launchModel ?? file.model) : file.model;
  const model = models.some((item) => item.id === observedModel) ? observedModel! : models[0]!.id;
  const efforts = effortScale(engine, model) ?? [];
  return { model, effort: efforts.includes(file.effort ?? "") ? file.effort! : efforts[0]!, fast: file.fast ?? false };
}

function readDraft(file: FileEntry): RuntimeDraft {
  const fallback = defaults(file);
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(file)) ?? "null") as Partial<RuntimeDraft> | null;
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

/**
 * The runtime (model · effort · apply) control face every agent window shares:
 * desktop renders the compact selects + apply, the phone folds them behind one
 * 44px pill opening a bottom sheet with thumb-sized controls (finding 6). The
 * live conversation window wraps it with the tmux reconfigure lifecycle below;
 * a pipeline stage placeholder wraps the SAME view with an override-stage
 * PATCH (issue #196) — one control component, two data adapters.
 * `withDefaults` prepends a "default" choice for model/effort (a stage may
 * leave both to its role's defaults); `showSpeed` gates the codex-only speed
 * control off for surfaces without a speed concept.
 */
export function RuntimeControlsView({
  engine,
  draft,
  state,
  error,
  observedModelLabel,
  observedEffort,
  draftPending,
  showSpeed = true,
  withDefaults = false,
  disabled = false,
  onEdit,
  onApply,
}: {
  engine: "claude" | "codex";
  draft: RuntimeDraft;
  state: RuntimeApplyState;
  error: string;
  /** The pill face shows the runtime the agent/stage currently resolves to. */
  observedModelLabel: string;
  observedEffort: string;
  /** An edited-but-unapplied draft flags a dot on the pill face. */
  draftPending: boolean;
  showSpeed?: boolean;
  withDefaults?: boolean;
  /** Frozen surfaces (a pipeline stage that already ran) disable the pickers;
      live windows never pass this. */
  disabled?: boolean;
  onEdit: (update: (current: RuntimeDraft) => RuntimeDraft) => void;
  onApply: () => void;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const efforts = useMemo(() => effortScale(engine, draft.model) ?? [], [engine, draft.model]);
  const speedShown = showSpeed && engine === "codex";
  const editModel = (model: string) => {
    const scale = effortScale(engine, model) ?? [];
    onEdit((current) => ({
      ...current,
      model,
      effort: scale.includes(current.effort) ? current.effort : withDefaults ? "" : scale[0]!,
    }));
  };

  const applyBusy = state === "saving" || state === "pending" || state === "confirming";
  const applyLabel = state === "pending"
    ? t("runtimeConfig.pending")
    : state === "confirming"
      ? t("runtimeConfig.confirming")
      : state === "applied"
        ? t("runtimeConfig.applied")
        : t("runtimeConfig.apply");
  const modelLabel = ENGINE_MODELS[engine].find((model) => model.id === draft.model)?.label ?? draft.model;

  if (isMobile) {
    return (
      <span onPointerDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-label={t("runtimeConfig.openSheet")}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-canvas px-2.5 text-label font-semibold text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          <span className="max-w-[38vw] truncate">{observedModelLabel} · {observedEffort}</span>
          {applyBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : state === "applied" ? (
            <Check className="h-3 w-3 text-success" aria-hidden />
          ) : draftPending ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" role="img" aria-label={t("runtimeConfig.pendingDraft", { model: modelLabel, effort: draft.effort })} title={t("runtimeConfig.pendingDraft", { model: modelLabel, effort: draft.effort })} />
          ) : null}
        </button>
        {sheetOpen ? (
          <div
            className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40"
            role="presentation"
            onClick={(event) => { if (event.target === event.currentTarget) setSheetOpen(false); }}
          >
            <div role="dialog" aria-label={t("runtimeConfig.openSheet")} className="max-h-[80vh] w-full max-w-[440px] overflow-y-auto rounded-t-[16px] bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2">
              <div className="mb-2 flex items-center gap-2">
                <div className="mx-auto h-1 w-10 rounded-full bg-border" aria-hidden />
                <button
                  type="button"
                  onClick={() => setSheetOpen(false)}
                  aria-label={t("common.close")}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">{t("runtimeConfig.model")}</div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(withDefaults ? [{ id: "", label: t("draft.modelDefault") }, ...ENGINE_MODELS[engine]] : [...ENGINE_MODELS[engine]]).map((model) => (
                  <button
                    key={model.id || "default"}
                    type="button"
                    aria-pressed={draft.model === model.id}
                    onClick={() => editModel(model.id)}
                    className={`inline-flex min-h-11 items-center rounded-control border px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      draft.model === model.id ? "border-accent bg-accent/10 text-accent" : "border-border bg-canvas text-primary"
                    }`}
                  >
                    {model.label}
                  </button>
                ))}
              </div>
              <div className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">{t("runtimeConfig.effort")}</div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(withDefaults ? ["", ...efforts] : efforts).map((effort) => (
                  <button
                    key={effort || "default"}
                    type="button"
                    aria-pressed={draft.effort === effort}
                    onClick={() => onEdit((current) => ({ ...current, effort }))}
                    className={`inline-flex min-h-11 items-center rounded-control border px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      draft.effort === effort ? "border-accent bg-accent/10 text-accent" : "border-border bg-canvas text-primary"
                    }`}
                  >
                    {effort ? effortTierLabel(t, effort) : t("draft.effortDefault")}
                  </button>
                ))}
              </div>
              {speedShown ? (
                <label className="mb-3 flex min-h-11 items-center gap-2 rounded-control border border-border bg-canvas px-3 text-body font-semibold text-primary">
                  <input type="checkbox" className="h-4 w-4" checked={draft.fast} onChange={(event) => onEdit((current) => ({ ...current, fast: event.target.checked }))} />
                  {t("runtimeConfig.speedTitle")}
                </label>
              ) : null}
              {error ? <div className="mb-2 text-ui font-semibold text-danger">{error}</div> : null}
              <button
                type="button"
                disabled={state === "saving"}
                onClick={onApply}
                className="flex min-h-12 w-full items-center justify-center gap-1.5 rounded-control border border-accent bg-accent text-body font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {applyBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                {applyLabel}
              </button>
            </div>
          </div>
        ) : null}
      </span>
    );
  }

  return (
    <div className="inline-flex min-w-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()} title={error || undefined}>
      <Select
        aria-label={t("runtimeConfig.model")}
        value={draft.model}
        disabled={disabled}
        onChange={(event) => editModel(event.target.value)}
      >
        {withDefaults ? <option value="">{t("draft.modelDefault")}</option> : null}
        {ENGINE_MODELS[engine].map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </Select>
      <Select
        aria-label={t("runtimeConfig.effort")}
        value={draft.effort}
        disabled={disabled}
        onChange={(event) => onEdit((current) => ({ ...current, effort: event.target.value }))}
      >
        {withDefaults ? <option value="">{t("draft.effortDefault")}</option> : null}
        {efforts.map((effort) => <option key={effort} value={effort}>{effortTierLabel(t, effort)}</option>)}
      </Select>
      {speedShown ? (
        <label className="inline-flex h-7 items-center gap-1 rounded-control border border-border bg-card px-1.5 text-ui font-semibold text-secondary" title={t("runtimeConfig.speedTitle")}>
          <input type="checkbox" checked={draft.fast} onChange={(event) => onEdit((current) => ({ ...current, fast: event.target.checked }))} /> {t("draft.speedFast")}
        </label>
      ) : null}
      <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-canvas px-1.5 text-[9.5px] font-semibold text-muted hover:border-accent/45 hover:text-accent disabled:opacity-60" disabled={disabled || state === "saving"} onClick={onApply} aria-label={t("runtimeConfig.apply")}>
        {applyBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
        {state === "pending" ? t("runtimeConfig.pending") : state === "confirming" ? t("runtimeConfig.confirming") : state === "applied" ? t("runtimeConfig.applied") : t("runtimeConfig.apply")}
      </button>
    </div>
  );
}

/** The live conversation window's runtime controls: the shared view wired to
    the tmux reconfigure lifecycle (persisted draft, converging re-apply,
    confirm-by-observation). */
export function AgentRuntimeControls({ file }: { file: FileEntry }) {
  const { t } = useLocale();
  const engine = file.engine as "claude" | "codex";
  const [draft, setDraft] = useState<RuntimeDraft>(() => defaults(file));
  const [state, setState] = useState<RuntimeApplyState>("idle");
  const [error, setError] = useState("");
  const revisionRef = useRef(0);
  const editDraft = (update: (current: RuntimeDraft) => RuntimeDraft) => {
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

  /* The pill face shows the agent's live configuration — the observed model and
     effort — so this single control never misreports the running agent while an
     edited-but-unapplied draft sits in localStorage (issue #177 review). A dot
     flags an unapplied draft; the sheet holds and edits that draft. */
  const observedModelId = engine === "claude" ? (normalizeClaudeLaunchModel(file.launchModel ?? file.model) ?? file.model ?? draft.model) : (file.model ?? draft.model);
  const observedModelLabel = ENGINE_MODELS[engine].find((model) => model.id === observedModelId)?.label ?? file.model ?? observedModelId;
  const observedEffort = file.effort ?? draft.effort;
  const draftPending = (file.model != null && draft.model !== observedModelId) || (file.effort != null && draft.effort !== file.effort);

  return (
    <RuntimeControlsView
      engine={engine}
      draft={draft}
      state={state}
      error={error}
      observedModelLabel={observedModelLabel}
      observedEffort={observedEffort}
      draftPending={draftPending}
      onEdit={editDraft}
      onApply={() => void apply()}
    />
  );
}
