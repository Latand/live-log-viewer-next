"use client";

import { ArrowDown, ArrowUp, Pause, Play, Plus, RefreshCw, Square, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import type { FlowEngine } from "@/lib/flows/types";
import type { PipelineStage, PipelineStageKind } from "@/lib/pipelines/types";
import { useLocale } from "@/lib/i18n";

import { flowPresentation, patchFlow } from "@/components/flows/flowModel";
import { patchPipeline, PIPELINE_ROLE_OPTIONS, reviewLoopChainValid, stageOverrideBody } from "@/components/pipelines/pipelineModel";

import type { SchemeGroup } from "./layout";

const ENGINES: FlowEngine[] = ["claude", "codex"];

/**
 * Switching the engine invalidates the model (a claude model can't run on codex
 * and vice-versa) and can invalidate the effort tier, so both are reset together
 * (issue #118 review Finding 2). Model clears to the engine default; effort keeps
 * a value only if the new engine still accepts it. Otherwise a stale gpt model
 * would ride along a claude switch and fail the next launch / 400 the override.
 */
export function resetRuntimeForEngine(
  next: FlowEngine,
  ctl: { setEngine: (e: FlowEngine) => void; setModel: (m: string) => void; setEffort: (e: string) => void; effort: string },
): void {
  ctl.setEngine(next);
  ctl.setModel("");
  if (ctl.effort && !ENGINE_EFFORTS[next].includes(ctl.effort)) ctl.setEffort("");
}

/** How many attempts a pipeline stage has already run — 0 means it is still in
    the future and safe to re-configure (matches the engine's override guard). */
function stageAttemptCount(group: SchemeGroup, stageId: string): number {
  return group.pipeline?.runs.find((run) => run.stageId === stageId)?.attempts.length ?? 0;
}

/**
 * On-canvas stage-override controls for a running flow or pipeline (issue #118),
 * opened from a group halo's label. It steers a flow/pipeline WITHOUT recreating
 * it: change the next round/stage engine·model·effort, edit the next-round note
 * or next-stage prompt, extend or cap rounds, and drive the existing
 * retry/cancel/pause/resume/skip/close actions — every button is a PATCH to the
 * flows or pipelines API. A running round/stage keeps the config it froze at
 * spawn; the override lands on the next one.
 */
export function GroupOverridePanel({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  return (
    <div
      data-scheme-ui
      data-group-override={group.kind}
      role="dialog"
      aria-label={group.label}
      className={`flex flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 shadow-[0_10px_36px_rgb(20_20_30/0.18)] ${group.pipeline?.state === "draft" ? "w-[320px]" : "w-[268px]"}`}
    >
      {group.flow ? <FlowOverride group={group} onClose={onClose} /> : null}
      {group.pipeline ? <PipelineOverride group={group} onClose={onClose} /> : null}
    </div>
  );
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[12px] font-bold">{title}</span>
      <button
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={t("groupOverride.closePanel")}
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

const fieldLabel = "text-[10px] font-bold uppercase tracking-wide text-dim";
const inputBase =
  "h-7 w-full rounded-[8px] border border-line bg-bg px-2 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
const primaryBtn =
  "inline-flex items-center justify-center gap-1 rounded-full border border-accent bg-accent px-3 py-1 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40";
const ghostBtn =
  "inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40";

/* The effort tiers offered depend on the selected engine — codex tops out at
   xhigh, claude adds max — so the control can never present a combination the
   API rejects (issue #118 review: codex + max was a guaranteed 400). A stale
   value outside the engine's list falls back to the default option. */
function EffortSelect({ engine, value, onChange, label }: { engine: FlowEngine; value: string; onChange: (value: string) => void; label: string }) {
  const { t } = useLocale();
  const tiers = ENGINE_EFFORTS[engine];
  const safe = value && tiers.includes(value) ? value : "";
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{label}</span>
      <select className={inputBase} value={safe} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("groupOverride.effortDefault")}</option>
        {tiers.map((effort) => (
          <option key={effort} value={effort}>{effort}</option>
        ))}
      </select>
    </label>
  );
}

function EngineSelect({ value, onChange }: { value: FlowEngine; onChange: (value: FlowEngine) => void }) {
  const { t } = useLocale();
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className={fieldLabel}>{t("groupOverride.engine")}</span>
      <select className={inputBase} value={value} onChange={(event) => onChange(event.target.value as FlowEngine)}>
        {ENGINES.map((engine) => (
          <option key={engine} value={engine}>
            {engine}
          </option>
        ))}
      </select>
    </label>
  );
}

function FlowOverride({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  const { locale, t } = useLocale();
  const flow = group.flow!;
  const reviewer = flow.roles.reviewer;
  const [engine, setEngine] = useState<FlowEngine>(reviewer.engine);
  const [model, setModel] = useState(reviewer.model ?? "");
  const [effort, setEffort] = useState(reviewer.effort ?? "");
  const [note, setNote] = useState(flow.rounds.at(-1)?.readyNote ?? "");
  /* The panel stays mounted across polls, so re-seed the note whenever the current
     round changes — otherwise a note typed for round N would be submitted over
     round N+1 once it reaches a note-consuming state (issue #118 review). Tracked
     via the round number, so an operator's in-progress edit within the SAME round
     survives a refresh. Render-time state adjustment (React's endorsed idiom), so
     no stale-effect flash. */
  const roundKey = flow.rounds.at(-1)?.n ?? 0;
  const [noteRound, setNoteRound] = useState(roundKey);
  if (noteRound !== roundKey) {
    setNoteRound(roundKey);
    setNote(flow.rounds.at(-1)?.readyNote ?? "");
  }
  const [limit, setLimit] = useState(String(flow.roundLimit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const closed = flow.state === "closed" || flow.state === "approved";
  /* The one action the current state is waiting on (Start review / Spawn / Relay
     / Retry round / …). The next-round note is delivered only where the backend
     actually consumes it: advancing from waiting_ready (new round) or spawn_pending
     (revising the created-but-unspawned round), and retry-round. A relay_pending
     advance delivers findings to the implementer and never reads the note, so it
     is not carried there (issue #118 Finding 4). */
  const pending = flowPresentation(t, flow, locale).pending;
  const pendingCarriesNote =
    (pending?.action === "advance" && (flow.state === "waiting_ready" || flow.state === "spawn_pending")) ||
    pending?.action === "retry-round";

  const run = async (label: string, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const fail = await action();
    if (fail) setError(fail);
    else setSaved(label);
    setBusy(false);
  };

  return (
    <>
      <PanelHeader title={t("groupOverride.flowTitle", { name: group.label })} onClose={onClose} />
      {error ? <span className="truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
      {saved ? <span className="truncate text-[10.5px] font-semibold text-ok">{saved}</span> : null}

      <span className="text-[10.5px] font-bold text-ink">{t("groupOverride.reviewerRole")}</span>
      <div className="flex items-end gap-1.5">
        <EngineSelect value={engine} onChange={(next) => resetRuntimeForEngine(next, { setEngine, setModel, setEffort, effort })} />
        <EffortSelect engine={engine} value={effort} onChange={setEffort} label={t("groupOverride.effort")} />
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.model")}</span>
        <input
          className={inputBase}
          value={model}
          placeholder={t("groupOverride.modelPlaceholder")}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <button
        className={primaryBtn}
        disabled={busy || closed}
        onClick={() =>
          void run(t("groupOverride.savedReviewer"), () =>
            patchFlow(flow.id, {
              action: "set-roles",
              roles: { reviewer: { engine, model: model.trim() || null, effort: effort || null } },
            }),
          )
        }
      >
        {t("groupOverride.applyRole")}
      </button>

      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.nextRoundNote")}</span>
        {/* Editable only where a panel action actually persists it (Start review /
            Spawn / Retry round). In every other state the next round is created by
            the engine (an auto-mode marker, etc.), which never reads this field —
            so the editor is disabled instead of silently discarding edits
            (issue #118 review). */}
        <textarea
          className="min-h-[52px] w-full resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          value={note}
          placeholder={t("groupOverride.notePlaceholder")}
          disabled={!pendingCarriesNote || busy}
          onChange={(event) => setNote(event.target.value)}
        />
        {!pendingCarriesNote ? (
          <span className="text-[10px] font-semibold text-dim">{t("groupOverride.noteUnavailable")}</span>
        ) : null}
      </label>

      <div className="flex items-end gap-1.5">
        <label className="flex w-[86px] flex-col gap-1">
          <span className={fieldLabel}>{t("groupOverride.roundLimit")}</span>
          <input
            className={inputBase}
            type="number"
            min={0}
            max={50}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </label>
        <button
          className={ghostBtn}
          disabled={busy || closed}
          onClick={() =>
            void run(t("groupOverride.savedLimit"), () =>
              patchFlow(flow.id, { action: "set-round-limit", rounds: Math.max(0, Math.min(50, Number(limit) || 0)) }),
            )
          }
        >
          {t("groupOverride.setLimit")}
        </button>
        <button
          className={ghostBtn}
          disabled={busy || closed}
          onClick={() => void run(t("groupOverride.savedExtend"), () => patchFlow(flow.id, { action: "extend", rounds: 1 }))}
        >
          {t("groupOverride.extend")}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        {pending ? (
          <button
            className={primaryBtn + " flex-1"}
            disabled={busy}
            onClick={() =>
              void run(pending.action === "retry-round" ? t("groupOverride.savedRetry") : t(pending.labelKey), () =>
                patchFlow(flow.id, {
                  action: pending.action,
                  /* Send the field even when empty so clearing the editor actually
                     clears the round's note; the backend reads "" as an explicit
                     clear and an absent field as "no change" (issue #118 review). */
                  ...(pendingCarriesNote ? { note: note.trim() } : {}),
                }),
              )
            }
          >
            <RefreshCw className="h-3 w-3" aria-hidden /> {t(pending.labelKey)}
          </button>
        ) : null}
        {flow.state === "reviewing" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-err/40 bg-[#fbeaea] px-3 py-1 text-[11px] font-bold text-err hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("groupOverride.savedCancel"), () => patchFlow(flow.id, { action: "cancel-round" }))}
          >
            <Square className="h-3 w-3" aria-hidden /> {t("flowStrip.stopReviewer")}
          </button>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5">
        {closed ? null : flow.state === "paused" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-ok/40 bg-[#eef8f0] px-3 py-1 text-[11px] font-bold text-ok hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("flowStrip.resume"), () => patchFlow(flow.id, { action: "resume" }))}
          >
            <Play className="h-3 w-3" aria-hidden /> {t("flowStrip.resume")}
          </button>
        ) : (
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("flowStrip.pause"), () => patchFlow(flow.id, { action: "pause" }))}
          >
            <Pause className="h-3 w-3" aria-hidden /> {t("flowStrip.pause")}
          </button>
        )}
        <button
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={busy}
          onClick={() => void run(t("flowStrip.close"), () => patchFlow(flow.id, { action: "close" }))}
        >
          <X className="h-3 w-3" aria-hidden /> {t("flowStrip.close")}
        </button>
      </div>
    </>
  );
}

/** The per-stage editing form (issue #118): engine·model·effort·prompt for one
    not-yet-started stage. Remounted (via `key={stage.id}`) whenever the operator
    picks a different upcoming stage, so its inputs always start from that stage's
    current config without a reset effect. */
function StageForm({
  group,
  stage,
  busy,
  disabled,
  run,
}: {
  group: SchemeGroup;
  stage: PipelineStage;
  busy: boolean;
  disabled: boolean;
  run: (label: string, action: () => Promise<string | null>) => Promise<void>;
}) {
  const { t } = useLocale();
  const pipeline = group.pipeline!;
  const [roleId, setRoleId] = useState(stage.role?.roleId ?? "");
  const [engine, setEngine] = useState<FlowEngine>(stage.effectiveRole.engine);
  const [model, setModel] = useState(stage.effectiveRole.model ?? "");
  const [effort, setEffort] = useState(stage.effectiveRole.effort ?? "");
  const [prompt, setPrompt] = useState(stage.prompt);
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.role")}</span>
        <select className={inputBase} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          <option value="">{t("groupOverride.noRole")}</option>
          {PIPELINE_ROLE_OPTIONS.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-1.5">
        <EngineSelect value={engine} onChange={(next) => resetRuntimeForEngine(next, { setEngine, setModel, setEffort, effort })} />
        <EffortSelect engine={engine} value={effort} onChange={setEffort} label={t("groupOverride.effort")} />
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.model")}</span>
        <input
          className={inputBase}
          value={model}
          placeholder={t("groupOverride.modelPlaceholder")}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>{t("groupOverride.stagePrompt")}</span>
        <textarea
          className="min-h-[64px] w-full resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <button
        className={primaryBtn}
        disabled={busy || disabled || !prompt.trim()}
        onClick={() =>
          void run(t("groupOverride.savedStage"), () =>
            /* Only the fields the operator changed are sent, so a role-only change
               lets the backend apply the new role's runtime defaults (Finding 4). */
            patchPipeline(pipeline.id, "override-stage", stageOverrideBody(stage, { roleId, engine, model, effort, prompt })),
          )
        }
      >
        {t("groupOverride.applyStage")}
      </button>
    </>
  );
}

/**
 * The on-canvas draft BUILDER (issue #136): the draft's stages as a vertical stack
 * of cards, each the same {@link StageForm} the override-stage editor renders
 * (role·engine·model·effort·prompt). The stack order IS the execution chain — drag
 * a card (or use the move buttons) to reorder, which PATCHes `reorder-stage`; the
 * per-card trash removes (`remove-stage`); the footer adds a run or review-loop
 * stage (`add-stage`). Every action is a #189 draft PATCH — no second data path,
 * no form. A draft's stages have never run, so all of them are editable.
 */
function DraftStageCards({
  group,
  busy,
  run,
}: {
  group: SchemeGroup;
  busy: boolean;
  run: (label: string, action: () => Promise<string | null>) => Promise<void>;
}) {
  const { t } = useLocale();
  const pipeline = group.pipeline!;
  const stages = pipeline.stages;
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const kinds = stages.map((item) => item.kind);
  /* A move/removal that would place a review-loop ahead of every run is invalid
     (the API rejects it), so the controls that would produce one are disabled and
     an out-of-band drop is a no-op — the plan on the canvas is always startable. */
  const orderAfterMove = (from: number, to: number): PipelineStageKind[] => {
    const next = [...kinds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
  };
  const canMoveTo = (fromIndex: number, toIndex: number) =>
    toIndex >= 0 && toIndex < stages.length && toIndex !== fromIndex && reviewLoopChainValid(orderAfterMove(fromIndex, toIndex));
  const canRemove = (index: number) => reviewLoopChainValid(kinds.filter((_, i) => i !== index));
  /* A review-loop needs a preceding run, so the add-review control stays disabled
     until at least one run exists (and while the plan is already at the 4-stage cap). */
  const canAddReview = stages.length < 4 && stages.some((item) => item.kind === "run");

  const moveTo = (stageId: string, toIndex: number) => {
    const from = stages.findIndex((item) => item.id === stageId);
    if (from < 0 || !canMoveTo(from, toIndex)) return;
    void run(t("groupOverride.reordered"), () => patchPipeline(pipeline.id, "reorder-stage", { stageId, toIndex }));
  };
  const addStage = (kind: PipelineStageKind) => {
    const ids = new Set(stages.map((item) => item.id));
    let n = stages.length + 1;
    while (ids.has(`stage-${n}`)) n += 1;
    void run(t("groupOverride.stageAdded"), () =>
      patchPipeline(pipeline.id, "add-stage", {
        index: stages.length,
        stage: { id: `stage-${n}`, kind, prompt: pipeline.task || "{{task}}", next: null },
      }),
    );
  };
  const removeStage = (stageId: string) =>
    void run(t("groupOverride.stageRemoved"), () => patchPipeline(pipeline.id, "remove-stage", { stageId }));

  /* Drop resolves against React state (dragId), which works in environments where
     the drag payload (dataTransfer) is unavailable, and keeps this unit-testable.
     Splice semantics: the dragged stage lands at the drop target's current slot;
     a drop that would break the run→review chain is ignored (moveTo guards it). */
  const onDrop = (targetId: string) => {
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (!from || from === targetId) return;
    const toIndex = stages.findIndex((item) => item.id === targetId);
    if (toIndex >= 0) moveTo(from, toIndex);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10.5px] font-bold text-ink">{t("groupOverride.stagesHeading")}</span>
      <span className="text-[10px] font-semibold text-dim">{stages.length ? t("groupOverride.stagesHint") : t("groupOverride.stagesEmpty")}</span>
      <div className="flex max-h-[46vh] flex-col gap-2 overflow-y-auto pr-0.5">
        {stages.map((stage, index) => (
          <div
            key={stage.id}
            data-stage-card={stage.id}
            draggable={!busy}
            onDragStart={(event) => {
              setDragId(stage.id);
              event.dataTransfer?.setData?.("text/plain", stage.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (overId !== stage.id) setOverId(stage.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              onDrop(stage.id);
            }}
            className={`flex flex-col gap-1.5 rounded-[10px] border bg-panel p-2 ${
              overId === stage.id && dragId && dragId !== stage.id ? "border-accent" : "border-line"
            } ${dragId === stage.id ? "opacity-60" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="cursor-grab select-none text-[13px] leading-none text-dim"
                aria-label={t("groupOverride.dragHandle")}
                title={t("groupOverride.dragHandle")}
              >
                ⠿
              </span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-chip px-1.5 text-[10px] font-black text-dim">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] font-bold text-ink">{stage.role?.roleId ?? stage.id}</span>
              <span className="shrink-0 rounded-full border border-line px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wide text-dim">
                {t(stage.kind === "review-loop" ? "groupOverride.reviewKind" : "groupOverride.runKind")}
              </span>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
                disabled={busy || !canMoveTo(index, index - 1)}
                aria-label={t("groupOverride.moveStageUp")}
                onClick={() => moveTo(stage.id, index - 1)}
              >
                <ArrowUp className="h-3 w-3" aria-hidden />
              </button>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
                disabled={busy || !canMoveTo(index, index + 1)}
                aria-label={t("groupOverride.moveStageDown")}
                onClick={() => moveTo(stage.id, index + 1)}
              >
                <ArrowDown className="h-3 w-3" aria-hidden />
              </button>
              <button
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line bg-bg text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
                disabled={busy || !canRemove(index)}
                aria-label={t("groupOverride.removeStage")}
                onClick={() => removeStage(stage.id)}
              >
                <Trash2 className="h-3 w-3" aria-hidden />
              </button>
            </div>
            {/* Same key strategy as the override editor: remount when the resolved
                runtime/prompt changes so the inputs re-seed after a save. */}
            <StageForm
              key={`${stage.id}:${stage.role?.roleId ?? ""}:${stage.effectiveRole.engine}:${stage.effectiveRole.model ?? ""}:${stage.effectiveRole.effort ?? ""}:${stage.prompt}`}
              group={group}
              stage={stage}
              busy={busy}
              disabled={false}
              run={run}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button className={ghostBtn} disabled={busy || stages.length >= 4} onClick={() => addStage("run")}>
          <Plus className="h-3 w-3" aria-hidden /> {t("groupOverride.addRunStage")}
        </button>
        <button className={ghostBtn} disabled={busy || !canAddReview} onClick={() => addStage("review-loop")}>
          <Plus className="h-3 w-3" aria-hidden /> {t("groupOverride.addReviewStage")}
        </button>
      </div>
    </div>
  );
}

function PipelineOverride({ group, onClose }: { group: SchemeGroup; onClose: () => void }) {
  const { t } = useLocale();
  const pipeline = group.pipeline!;
  const draft = pipeline.state === "draft";
  /* Only stages that have not run yet can be re-configured — the engine snapshots
     a stage's config the moment its first attempt starts. */
  const editable = useMemo(
    () => pipeline.stages.filter((stage) => stageAttemptCount(group, stage.id) === 0),
    [pipeline, group],
  );
  const [stageId, setStageId] = useState(editable[0]?.id ?? "");
  const stage = editable.find((item) => item.id === stageId) ?? editable[0] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [task, setTask] = useState(pipeline.task);
  const [spec, setSpec] = useState(pipeline.spec ?? "");
  const [repoDir, setRepoDir] = useState(pipeline.repoDir);

  const closed = pipeline.state === "completed" || pipeline.state === "closed";
  const parked = pipeline.state === "needs_decision";

  const run = async (label: string, action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    const fail = await action();
    if (fail) setError(fail);
    else setSaved(label);
    setBusy(false);
  };

  return (
    <>
      <PanelHeader title={t(draft ? "groupOverride.draftTitle" : "groupOverride.pipelineTitle", { name: group.label })} onClose={onClose} />
      {error ? <span className="truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : null}
      {saved ? <span className="truncate text-[10.5px] font-semibold text-ok">{saved}</span> : null}

      {draft ? (
        <div className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-[#c88719]/60 bg-[#fff9ea] p-2">
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.task")}</span>
            <input className={inputBase} value={task} onChange={(event) => setTask(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.spec")}</span>
            <textarea className="min-h-[52px] w-full resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c88719]/40" value={spec} onChange={(event) => setSpec(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.repoDir")}</span>
            <input className={inputBase} value={repoDir} onChange={(event) => setRepoDir(event.target.value)} />
          </label>
          <button
            className={primaryBtn}
            disabled={busy || !task.trim() || !repoDir.trim()}
            onClick={() => void run(t("groupOverride.savedDraft"), () => patchPipeline(pipeline.id, "update-draft", { task, spec, repoDir }))}
          >
            {t("groupOverride.saveDraft")}
          </button>
        </div>
      ) : null}

      {draft ? (
        <DraftStageCards group={group} busy={busy} run={run} />
      ) : stage ? (
        <>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>{t("groupOverride.nextStage")}</span>
            <select className={inputBase} value={stage.id} onChange={(event) => setStageId(event.target.value)}>
              {editable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.role?.roleId ?? item.id}
                </option>
              ))}
            </select>
          </label>
          {/* Keyed on the stage id so switching stages remounts the form with the
              picked stage's config — no reset-in-effect. */}
          {/* Key on the effective role/runtime + prompt, not just the id, so once
              an override resolves new defaults the form remounts and re-seeds
              instead of holding the previous engine/model/effort (Finding 5). */}
          <StageForm
            key={`${stage.id}:${stage.role?.roleId ?? ""}:${stage.effectiveRole.engine}:${stage.effectiveRole.model ?? ""}:${stage.effectiveRole.effort ?? ""}:${stage.prompt}`}
            group={group}
            stage={stage}
            busy={busy}
            disabled={closed}
            run={run}
          />
        </>
      ) : (
        <span className="text-[11px] font-semibold text-dim">{t("groupOverride.noEditableStage")}</span>
      )}

      {parked ? (
        <div className="flex items-center gap-1.5">
          <button
            className={primaryBtn + " flex-1"}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.retryStage"), () => patchPipeline(pipeline.id, "retry-stage"))}
          >
            {t("pipelineStrip.retryStage")}
          </button>
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.skipStage"), () => patchPipeline(pipeline.id, "skip-stage"))}
          >
            {t("pipelineStrip.skipStage")}
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        {draft ? (
          <button
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1 rounded-full border border-[#9a6410] bg-[#9a6410] px-3 text-[11px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c88719]/50 disabled:opacity-40"
            disabled={busy || pipeline.stages.length < 2}
            title={pipeline.stages.length < 2 ? t("groupOverride.startNeedsStages") : undefined}
            onClick={() => void run(t("pipelineStrip.start"), () => patchPipeline(pipeline.id, "start"))}
          >
            <Play className="h-3.5 w-3.5" aria-hidden /> {t("pipelineStrip.start")}
          </button>
        ) : closed ? null : pipeline.state === "paused" ? (
          <button
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-ok/40 bg-[#eef8f0] px-3 py-1 text-[11px] font-bold text-ok hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.resume"), () => patchPipeline(pipeline.id, "resume"))}
          >
            <Play className="h-3 w-3" aria-hidden /> {t("pipelineStrip.resume")}
          </button>
        ) : (
          <button
            className={ghostBtn}
            disabled={busy}
            onClick={() => void run(t("pipelineStrip.pause"), () => patchPipeline(pipeline.id, "pause"))}
          >
            <Pause className="h-3 w-3" aria-hidden /> {t("pipelineStrip.pause")}
          </button>
        )}
        <button
          className="inline-flex flex-1 items-center justify-center gap-1 rounded-full border border-line bg-bg px-3 py-1 text-[11px] font-bold text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={busy}
          onClick={() => void run(t(draft ? "pipelineStrip.discard" : "pipelineStrip.close"), () => patchPipeline(pipeline.id, draft ? "delete" : "close"))}
        >
          <X className="h-3 w-3" aria-hidden /> {t(draft ? "pipelineStrip.discard" : "pipelineStrip.close")}
        </button>
      </div>
    </>
  );
}
