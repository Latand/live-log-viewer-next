"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { RuntimeControlsView, type RuntimeApplyState, type RuntimeDraft } from "@/components/AgentRuntimeControls";
import { EngineRadioGroup, RoleSection, useRoleCatalog } from "@/components/DraftAgentPane";
import { X } from "@/components/icons";
import type { StageSlot } from "@/components/scheme/layout";
import { engineTintOf } from "@/components/utils";
import { isEngineEffort } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import type { FlowEngine } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { PatchPipelineRequest, PipelineRoleId } from "@/lib/pipelines/types";

import {
  PIPELINE_ROLE_OPTIONS,
  STAGE_TONES,
  patchPipeline,
  reviewLoopChainValid,
  stageAttempts,
  stageChipLabel,
  stageChipState,
} from "./pipelineModel";

const PIPELINE_ROLE_ID_SET: ReadonlySet<string> = new Set(PIPELINE_ROLE_OPTIONS);

/** Trimmed, non-empty param values — matches the server's boundedText gate. */
function sanitizeParams(params: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A planned pipeline stage as the SAME window a new agent gets (issue #196):
 * the DraftAgentPane recipe — engine chips in the header, the shared
 * RoleSection (role select, params, scaffold preview), the live windows' own
 * RuntimeControlsView (model · effort · apply, exactly as BranchPane mounts
 * it), and the prompt editor at the bottom — just dashed,
 * because no agent is attached yet. Every edit is an `override-stage` PATCH
 * against the draft; server echoes re-seed the controls in place (render-phase
 * adjustment), so the pane never remounts under the operator's cursor. When
 * the stage materializes a node/deck, the layout dissolves this slot and the
 * live chat window takes over the footprint.
 */
export function StagePlaceholderPane({ slot, interactive }: { slot: StageSlot; interactive: boolean }) {
  const { t } = useLocale();
  const { pipeline, stage } = slot;
  const roles = useRoleCatalog();
  const state = stageChipState(pipeline, stage);
  const tone = STAGE_TONES[state];
  const label = stageChipLabel(t, stage);
  const review = stage.kind === "review-loop";
  const draft = pipeline.state === "draft";
  /* Only a stage that has never run can be re-configured — the engine snapshots
     a stage's config at its first attempt (same guard as the builder panel). */
  const editable =
    interactive &&
    stageAttempts(pipeline, stage.id).length === 0 &&
    pipeline.state !== "completed" &&
    pipeline.state !== "closed";

  const effectiveModel = stage.effectiveRole.model ?? "";
  const effectiveEffort = stage.effectiveRole.effort ?? "";
  const [engine, setEngine] = useState<FlowEngine>(stage.effectiveRole.engine);
  /* The stage's runtime draft rides the SAME RuntimeControlsView the live
     conversation windows use (review round 1) — edited here, applied as an
     override-stage PATCH instead of a tmux reconfigure. */
  const [runtime, setRuntime] = useState<RuntimeDraft>({ model: effectiveModel, effort: effectiveEffort, fast: false });
  const [applyState, setApplyState] = useState<RuntimeApplyState>("idle");
  const [roleId, setRoleId] = useState(stage.role?.roleId ?? "");
  const [roleParams, setRoleParams] = useState<Record<string, string | number>>(stage.role?.params ?? {});
  const [prompt, setPrompt] = useState(stage.prompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /* Server echoes (the PATCH round-trips through the poll) re-seed the controls
     in place. Render-phase adjustments — no remount, so an in-progress prompt
     edit survives an unrelated echo: the prompt only adopts the server value
     while the local copy is not dirty. */
  const runtimeSig = `${stage.effectiveRole.engine}:${stage.effectiveRole.model ?? ""}:${stage.effectiveRole.effort ?? ""}`;
  const [seenRuntime, setSeenRuntime] = useState(runtimeSig);
  if (seenRuntime !== runtimeSig) {
    setSeenRuntime(runtimeSig);
    setEngine(stage.effectiveRole.engine);
    setRuntime({ model: effectiveModel, effort: effectiveEffort, fast: false });
  }
  const roleSig = `${stage.role?.roleId ?? ""}:${JSON.stringify(stage.role?.params ?? {})}`;
  const [seenRole, setSeenRole] = useState(roleSig);
  if (seenRole !== roleSig) {
    setSeenRole(roleSig);
    setRoleId(stage.role?.roleId ?? "");
    setRoleParams(stage.role?.params ?? {});
  }
  const [seenPrompt, setSeenPrompt] = useState(stage.prompt);
  if (seenPrompt !== stage.prompt) {
    const previous = seenPrompt;
    setSeenPrompt(stage.prompt);
    setPrompt((current) => (current === previous ? stage.prompt : current));
  }

  const save = async (body: Omit<PatchPipelineRequest, "action" | "stageId">) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const fail = await patchPipeline(pipeline.id, "override-stage", { stageId: stage.id, ...body });
    if (fail) setError(fail);
    else setSaved(true);
    setBusy(false);
  };
  const changeEngine = (next: FlowEngine) => {
    if (next === engine) return;
    /* Switching the engine invalidates the model and can invalidate the effort
       tier; clearing the pins hands both back to the engine/role defaults. */
    const keepEffort = Boolean(runtime.effort && isEngineEffort(next, runtime.effort));
    setEngine(next);
    setRuntime((current) => ({ ...current, model: "", effort: keepEffort ? current.effort : "" }));
    void save({ engine: next, model: null, ...(keepEffort ? {} : { effort: null }) });
  };
  const editRuntime = (update: (current: RuntimeDraft) => RuntimeDraft) => {
    setRuntime(update);
    setApplyState("idle");
  };
  /* Apply carries only the fields that differ from the stage's resolved
     runtime, so unchanged values never pin a role default (issue #118 rule). */
  const applyRuntime = async () => {
    if (applyState === "saving") return;
    const body: Omit<PatchPipelineRequest, "action" | "stageId"> = {};
    if (runtime.model.trim() !== effectiveModel) body.model = runtime.model.trim() || null;
    if (runtime.effort !== effectiveEffort) body.effort = runtime.effort || null;
    if (!Object.keys(body).length) {
      setApplyState("applied");
      return;
    }
    setApplyState("saving");
    setError(null);
    const fail = await patchPipeline(pipeline.id, "override-stage", { stageId: stage.id, ...body });
    if (fail) {
      setError(fail);
      setApplyState("error");
    } else {
      setApplyState("applied");
    }
  };
  const selectRole = (next: string) => {
    setRoleId(next);
    const selected = roles.find((role) => role.id === next);
    const params = selected
      ? Object.fromEntries(selected.parameters.map((parameter) => [
          parameter.key,
          parameter.kind === "integer" ? parameter.min ?? 1 : parameter.options?.[0] ?? "",
        ]))
      : {};
    setRoleParams(params);
    /* A role change hands unpinned runtime back to the new role's defaults
       server-side; the echo re-seeds the pickers above. */
    void save({ role: next ? { roleId: next as PipelineRoleId, ...(Object.keys(sanitizeParams(params)).length ? { params: sanitizeParams(params) } : {}) } : null });
  };
  const setParam = (key: string, value: string | number) => {
    const next = { ...roleParams, [key]: value };
    setRoleParams(next);
    if (!roleId) return;
    const params = sanitizeParams(next);
    void save({ role: { roleId: roleId as PipelineRoleId, ...(Object.keys(params).length ? { params } : {}) } });
  };
  const promptDirty = prompt !== stage.prompt;
  const savePrompt = () => {
    if (!promptDirty || !prompt.trim()) return;
    void save({ prompt: prompt.trim() });
  };
  /* Removing this stage must keep the chain startable: a removal that would
     orphan a review loop is disabled (same guard as the builder panel). */
  const canRemove =
    draft && interactive && reviewLoopChainValid(pipeline.stages.filter((item) => item.id !== stage.id).map((item) => item.kind));
  const removeStage = () => {
    setBusy(true);
    void patchPipeline(pipeline.id, "remove-stage", { stageId: stage.id }).then((fail) => {
      if (fail) setError(fail);
      setBusy(false);
    });
  };

  const tint = engineTintOf(engine);
  const active = state !== "pending" && state !== "skipped";
  const pulse = (state === "running" || state === "reviewing" || state === "committing") && pipeline.state !== "paused";
  const hint = review
    ? t("pipelineSlot.reviewHint")
    : state === "running" || state === "reviewing" || state === "committing"
      ? t("pipelineSlot.starting", { role: label })
      : t("pipelineSlot.waiting", { role: label });
  const observedModelLabel = (ENGINE_MODELS[engine].find((option) => option.id === effectiveModel)?.label ?? effectiveModel) || t("draft.modelDefault");
  const observedEffort = effectiveEffort || t("groupOverride.effortDefault");
  const runtimePending = runtime.model !== effectiveModel || runtime.effort !== effectiveEffort;

  return (
    <section
      data-pan-ignore
      aria-label={t("pipelineSlot.paneAria", { role: label })}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border-2 border-dashed bg-card shadow-1"
      style={{ borderColor: active ? tone.color : "var(--border-strong)" }}
    >
      <span aria-hidden className="h-1 w-full shrink-0 opacity-60" style={{ backgroundColor: tint.color }} />
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5" style={{ backgroundColor: tint.soft }}>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${pulse ? "animate-pulse" : ""}`}
          style={{ backgroundColor: tone.color }}
          title={t(`pipelineChipState.${state}`)}
        />
        <EngineRadioGroup engine={engine as "claude" | "codex"} disabled={!editable || busy} onChange={changeEngine} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted" title={label}>
          {label} · {t("pipelineSlot.stageOf", { k: slot.index + 1, n: slot.total })}
        </span>
        <span className="shrink-0 rounded-full border border-border bg-card/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted">
          {review ? `⟳ ${t("groupOverride.reviewKind")}` : t("groupOverride.runKind")}
        </span>
        {canRemove ? (
          <button
            className="inline-flex shrink-0 items-center rounded-[8px] border border-border bg-canvas px-1.5 py-0.5 text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            aria-label={t("groupOverride.removeStage")}
            disabled={busy}
            onClick={removeStage}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : null}
      </header>

      {interactive ? (
        <RoleSection
          idPrefix={slot.key}
          roles={roles}
          roleId={roleId}
          roleParams={roleParams}
          disabled={!editable || busy}
          allowedRoleIds={PIPELINE_ROLE_ID_SET}
          compactPreview
          onSelectRole={selectRole}
          onSetParam={setParam}
        />
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-muted">{t("draft.reasoning")}</span>
        {interactive ? (
          <>
            <RuntimeControlsView
              engine={engine as "claude" | "codex"}
              draft={runtime}
              state={applyState}
              error={error ?? ""}
              observedModelLabel={observedModelLabel}
              observedEffort={observedEffort}
              draftPending={runtimePending}
              showSpeed={false}
              withDefaults
              disabled={!editable || busy}
              onEdit={editRuntime}
              onApply={() => void applyRuntime()}
            />
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-hidden />
            ) : saved ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" role="img" aria-label={t("pipelineSlot.saved")} />
            ) : null}
          </>
        ) : (
          <span className="min-w-0 truncate text-[11px] font-semibold text-muted">
            {observedModelLabel}
            {effectiveEffort ? ` · ${effectiveEffort}` : ""}
          </span>
        )}
      </div>
      {error ? (
        <div className="shrink-0 px-2.5 py-1 text-[10.5px] font-semibold text-danger" role="alert">
          {error}
        </div>
      ) : null}
      {interactive && !editable ? (
        <div className="shrink-0 px-2.5 py-1 text-[10.5px] font-semibold text-muted">{t("pipelineSlot.frozen")}</div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-4 py-3 text-center">
        <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ backgroundColor: tone.soft, color: tone.color }}>
          {label}
        </span>
        <span className="max-w-[380px] text-[12px] leading-5 text-muted">{hint}</span>
      </div>

      {interactive ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            savePrompt();
          }}
          className="flex shrink-0 flex-col gap-1 border-t border-border bg-card px-2.5 py-2"
          aria-label={t("pipelineSlot.promptAria")}
        >
          <label className="text-[10px] font-semibold text-muted" htmlFor={`slot-prompt-${slot.key}`}>
            {t("pipelineSlot.promptLabel")}
          </label>
          <textarea
            id={`slot-prompt-${slot.key}`}
            value={prompt}
            disabled={!editable || busy}
            onChange={(event) => setPrompt(event.target.value)}
            onBlur={savePrompt}
            placeholder={t("pipelineSlot.noPrompt")}
            className="min-h-[52px] w-full resize-y rounded-[8px] border border-border bg-canvas px-2 py-1.5 text-[11.5px] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
          {promptDirty ? (
            <div className="flex items-center justify-end">
              <button
                type="submit"
                disabled={!editable || busy || !prompt.trim()}
                className="inline-flex h-7 items-center gap-1 rounded-[8px] border border-accent bg-accent px-2.5 text-[10.5px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
              >
                {t("pipelineSlot.savePrompt")}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
