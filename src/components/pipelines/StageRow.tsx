"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { MAX_ROLE_PARAM_TEXT_LENGTH, MAX_STAGE_PROMPT_LENGTH } from "@/lib/pipelines/limits";
import type { FlowEngine } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import { BUILDER_APPLY_FIXES_CONFIG, BUILDER_FRONTEND_CONFIG } from "@/lib/roles/paramConfig";
import type { RoleConfig, RoleDefinition } from "@/lib/roles/types";
import type { PipelineAccess } from "@/lib/pipelines/types";

import type { DraftStage } from "./pipelineModel";

export type RoleCatalogItem = RoleDefinition & { promptPreview: string };

/** The runtime a role resolves to, mirroring DraftAgentPane's role/param wiring
    (Builder frontend → Opus, apply-fixes → Terra) so the builder autofills the
    same values the +Agent draft would. */
export function roleRuntime(role: RoleCatalogItem, params: Record<string, string | number>): RoleConfig {
  if (role.id === "builder") {
    if (params.domain === "frontend") return BUILDER_FRONTEND_CONFIG;
    if (params.mode === "apply-fixes") return BUILDER_APPLY_FIXES_CONFIG;
  }
  return role.config;
}

export function roleAccess(role: RoleCatalogItem): PipelineAccess {
  return role.capabilities.includes("read-only") ? "read-only" : "read-write";
}

/**
 * The runtime a role-param change should apply. Builder's domain=frontend /
 * mode=apply-fixes shift the autofilled runtime — but only while the operator
 * hasn't pinned engine/model/effort by hand. An explicit override wins over
 * param autofill (design §1.3), so this returns null (leave the runtime as-is)
 * once `runtimeOverridden` is set, and for any non-Builder role.
 */
export function paramChangeRuntime(role: RoleCatalogItem | null, params: Record<string, string | number>, runtimeOverridden: boolean): RoleConfig | null {
  if (role?.id !== "builder" || runtimeOverridden) return null;
  return roleRuntime(role, params);
}

export function defaultRoleParams(role: RoleCatalogItem): Record<string, string | number> {
  return Object.fromEntries(
    role.parameters.map((parameter) => [parameter.key, parameter.kind === "integer" ? parameter.min ?? 1 : parameter.options?.[0] ?? ""]),
  );
}

/**
 * One editable pipeline stage: kind toggle, role select with typed params,
 * a collapsed runtime line, access radios, and the prompt with placeholder
 * chips. Maps 1:1 to a {@link DraftStage}; the dialog owns id/next derivation.
 */
export function StageRow({
  index,
  total,
  stage,
  roles,
  defaultRuntime,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  stage: DraftStage;
  roles: RoleCatalogItem[];
  defaultRuntime: RoleConfig;
  onChange: (next: DraftStage) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const { t } = useLocale();
  const modelListId = useId();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const runKindRef = useRef<HTMLButtonElement>(null);
  const reviewKindRef = useRef<HTMLButtonElement>(null);
  const n = index + 1;
  const selectedRole = roles.find((role) => role.id === stage.roleId) ?? null;
  const canReviewLoop = index > 0;
  const isReview = stage.kind === "review-loop";

  const patch = (partial: Partial<DraftStage>) => onChange({ ...stage, ...partial });

  const selectKind = (kind: DraftStage["kind"]) => {
    if (kind === "review-loop" && !canReviewLoop) return;
    /* Review-loop pins read-only reviewer semantics; the flow engine owns the pair. */
    patch(kind === "review-loop" ? { kind, access: "read-only" } : { kind });
  };

  /* WAI-ARIA radiogroup keyboard contract: one option is tabbable (the checked
     one, via roving tabIndex below) and arrow keys move selection between the
     enabled options, moving focus with it. With two options every arrow toggles
     to the other enabled kind (Review-loop is skipped on stage 1). */
  const onKindArrow = (event: React.KeyboardEvent) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    if (isReview) {
      selectKind("run");
      runKindRef.current?.focus();
    } else if (canReviewLoop) {
      selectKind("review-loop");
      reviewKindRef.current?.focus();
    }
  };

  const selectRole = (roleId: string) => {
    const role = roles.find((item) => item.id === roleId) ?? null;
    if (!role) {
      /* "No role" returns the stage to the raw-prompt pipeline default: clear the
         prior role's runtime overrides (engine/model/effort) too, otherwise an
         Architect → No role stage keeps submitting Claude/Fable while the runtime
         line claims the default. Blank model/effort serialize as no override, so
         the server resolves the Builder default the line shows. */
      patch({ roleId: "", roleParams: {}, engine: defaultRuntime.engine, model: "", effort: "", runtimeOverridden: false });
      return;
    }
    const params = defaultRoleParams(role);
    const access = isReview ? "read-only" : roleAccess(role);
    if (stage.runtimeOverridden) {
      /* The operator pinned engine/model/effort by hand, and those edits win over
         role autofill (design §1.3). A role (re)selection refreshes the role, its
         params, and access, and the pinned runtime survives. */
      patch({ roleId, roleParams: params, access });
      return;
    }
    const runtime = roleRuntime(role, params);
    patch({
      roleId,
      roleParams: params,
      engine: runtime.engine,
      model: runtime.model,
      effort: runtime.effort,
      access,
      runtimeOverridden: false,
    });
  };

  const setRoleParam = (key: string, value: string | number) => {
    const params = { ...stage.roleParams, [key]: value };
    /* A param change must not silently relaunch the stage on a different runtime
       once the operator has pinned one — paramChangeRuntime honors that override. */
    const runtime = paramChangeRuntime(selectedRole, params, Boolean(stage.runtimeOverridden));
    if (runtime) {
      patch({ roleParams: params, engine: runtime.engine, model: runtime.model, effort: runtime.effort });
      return;
    }
    patch({ roleParams: params });
  };

  const setEngine = (engine: FlowEngine) => {
    /* Switch to a model the new engine actually accepts. Clearing it to "" would
       serialize no override and let the server fall back to the role/Builder
       default — a codex model (gpt-5.6-sol) under a Claude stage, i.e. a 400. */
    patch({ engine, model: ENGINE_MODELS[engine][0]?.id ?? "", effort: ENGINE_EFFORTS[engine].includes(stage.effort) ? stage.effort : "", runtimeOverridden: true });
  };

  const insertPlaceholder = (token: string) => {
    const area = promptRef.current;
    if (!area) {
      patch({ prompt: stage.prompt + token });
      return;
    }
    const start = area.selectionStart ?? stage.prompt.length;
    const end = area.selectionEnd ?? stage.prompt.length;
    const next = stage.prompt.slice(0, start) + token + stage.prompt.slice(end);
    patch({ prompt: next });
    requestAnimationFrame(() => {
      area.focus();
      const caret = start + token.length;
      area.setSelectionRange(caret, caret);
    });
  };

  /* A blank override resolves server-side through the selected role's
     parameter-aware runtime (Architect → claude · fable · high). The collapsed
     summary and the model placeholder fall back through that same runtime; the
     Builder default applies only to role-less rows. Skipping this would show a
     launch config the API won't use (e.g. gpt-5.6-sol under a Claude role). */
  const roleRuntimeConfig = selectedRole ? roleRuntime(selectedRole, stage.roleParams) : null;
  const fallbackModel = roleRuntimeConfig?.model || defaultRuntime.model;
  const fallbackEffort = roleRuntimeConfig?.effort || defaultRuntime.effort;
  const runtimeSummary = [stage.engine, stage.model.trim() || fallbackModel || t("pipelineDialog.modelPlaceholder"), stage.effort || fallbackEffort || t("pipelineDialog.effortDefault")]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-bg/50 p-2" role="group" aria-label={t("pipelineDialog.stageLabel", { n })}>
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-[10.5px] font-bold text-dim">{t("pipelineDialog.stageLabel", { n })}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[7px] border border-line bg-panel text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
          aria-label={t("pipelineDialog.moveUp", { n })}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[7px] border border-line bg-panel text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
          aria-label={t("pipelineDialog.moveDown", { n })}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[7px] border border-line bg-panel text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-30"
          aria-label={t("pipelineDialog.removeStage", { n })}
          disabled={total <= 2}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-dim">{t("pipelineDialog.kind")}</span>
        <div className="inline-flex overflow-hidden rounded-[8px] border border-line" role="radiogroup" aria-label={t("pipelineDialog.kind")} onKeyDown={onKindArrow}>
          <button
            ref={runKindRef}
            type="button"
            role="radio"
            aria-checked={!isReview}
            tabIndex={isReview ? -1 : 0}
            onClick={() => selectKind("run")}
            className={`px-2.5 py-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${!isReview ? "bg-accent text-white" : "bg-panel text-dim hover:text-ink"}`}
          >
            {t("pipelineDialog.kindRun")}
          </button>
          <button
            ref={reviewKindRef}
            type="button"
            role="radio"
            aria-checked={isReview}
            aria-disabled={!canReviewLoop}
            tabIndex={isReview ? 0 : -1}
            aria-describedby={!canReviewLoop ? `${modelListId}-rev` : undefined}
            onClick={() => selectKind("review-loop")}
            className={`px-2.5 py-1 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isReview ? "bg-accent text-white" : "bg-panel text-dim hover:text-ink"} ${!canReviewLoop ? "cursor-not-allowed opacity-40" : ""}`}
          >
            {t("pipelineDialog.kindReviewLoop")}
          </button>
        </div>
        {!canReviewLoop ? <span id={`${modelListId}-rev`} className="text-[9.5px] text-dim">{t("pipelineDialog.reviewNeedsRun")}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <label className="shrink-0 text-[10px] font-semibold text-dim" htmlFor={`${modelListId}-role`}>{t("pipelineDialog.role")}</label>
        <select
          id={`${modelListId}-role`}
          value={stage.roleId}
          aria-label={t("pipelineDialog.roleAria", { n })}
          className="h-7 min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onChange={(event) => selectRole(event.target.value)}
        >
          <option value="">{t("pipelineDialog.noRole")}</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
      </div>
      {selectedRole ? (
        <p className="text-[10px] leading-4 text-dim">{selectedRole.description}</p>
      ) : (
        <p className="text-[10px] leading-4 text-dim">{t("pipelineDialog.noRoleHint")}</p>
      )}
      {selectedRole?.parameters.length ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("draft.roleParameters")}>
          {selectedRole.parameters.map((parameter) => (
            <label key={parameter.key} className="flex min-w-24 flex-1 flex-col gap-0.5 text-[10px] text-dim">
              <span>{parameter.label}{parameter.required ? " *" : ""}</span>
              {parameter.kind === "select" ? (
                <select value={String(stage.roleParams[parameter.key] ?? "")} onChange={(event) => setRoleParam(parameter.key, event.target.value)} className="h-7 rounded-[7px] border border-line bg-panel px-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  {parameter.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input type={parameter.kind === "integer" ? "number" : "text"} min={parameter.min} max={parameter.max} maxLength={parameter.kind === "text" ? MAX_ROLE_PARAM_TEXT_LENGTH : undefined} value={String(stage.roleParams[parameter.key] ?? "")} aria-label={parameter.label} onChange={(event) => setRoleParam(parameter.key, parameter.kind === "integer" && event.target.value ? Number(event.target.value) : event.target.value)} className="h-7 min-w-0 rounded-[7px] border border-line bg-panel px-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" />
              )}
            </label>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-dim">{t("pipelineDialog.runtime")}</span>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-ink" title={runtimeSummary}>{runtimeSummary}</span>
        <button
          type="button"
          className="shrink-0 text-[10px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={runtimeOpen}
          aria-label={t("pipelineDialog.editRuntime", { n })}
          onClick={() => setRuntimeOpen((value) => !value)}
        >
          [{t("common.edit")}]
        </button>
      </div>
      {runtimeOpen ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-[8px] border border-dashed border-line bg-panel/60 p-1.5">
          <select
            value={stage.engine}
            aria-label={t("flowDialog.engine", { label: t("pipelineDialog.stageLabel", { n }) })}
            className="h-7 rounded-[8px] border border-line bg-bg px-1.5 text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setEngine(event.target.value as FlowEngine)}
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <input
            value={stage.model}
            list={modelListId}
            placeholder={fallbackModel || t("pipelineDialog.modelPlaceholder")}
            aria-label={t("pipelineDialog.model")}
            className="h-7 w-0 min-w-24 flex-1 rounded-[8px] border border-line bg-bg px-1.5 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => patch({ model: event.target.value.trim(), runtimeOverridden: true })}
          />
          <datalist id={modelListId}>
            {ENGINE_MODELS[stage.engine].map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </datalist>
          <select
            value={stage.effort}
            aria-label={t("pipelineDialog.effort")}
            className="h-7 rounded-[8px] border border-line bg-bg px-1.5 text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => patch({ effort: event.target.value, runtimeOverridden: true })}
          >
            <option value="">{t("pipelineDialog.effortDefault")}</option>
            {ENGINE_EFFORTS[stage.engine].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
      ) : null}

      {isReview ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-[10px] font-semibold text-dim">{t("pipelineDialog.access")}</span>
          <div className="inline-flex items-center gap-2" role="radiogroup" aria-label={t("pipelineDialog.access")}>
            {(["read-only", "read-write"] as const).map((value) => (
              <label key={value} className="flex items-center gap-1 text-[10.5px] text-ink">
                <input type="radio" name={`${modelListId}-access`} checked={stage.access === value} onChange={() => patch({ access: value })} className="accent-accent" />
                {t(value === "read-only" ? "pipelineDialog.accessRo" : "pipelineDialog.accessRw")}
              </label>
            ))}
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1 text-[10px] font-semibold text-dim">
        {t("pipelineDialog.prompt")}
        <textarea
          ref={promptRef}
          value={stage.prompt}
          rows={isReview ? 2 : 3}
          maxLength={MAX_STAGE_PROMPT_LENGTH}
          placeholder={t(isReview ? "pipelineDialog.reviewNotePlaceholder" : "pipelineDialog.promptPlaceholder")}
          className="resize-y rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="rounded-full border border-line bg-chip px-2 py-0.5 font-mono text-[10px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => insertPlaceholder("{{task}}")}
        >
          {t("pipelineDialog.insertTask")}
        </button>
        <button
          type="button"
          className="rounded-full border border-line bg-chip px-2 py-0.5 font-mono text-[10px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={index === 0}
          title={index === 0 ? t("pipelineDialog.prevOutputUnavailable") : undefined}
          onClick={() => insertPlaceholder("{{prev.output}}")}
        >
          {t("pipelineDialog.insertPrevOutput")}
        </button>
        {index === 0 ? <span className="text-[9.5px] text-dim">{t("pipelineDialog.prevOutputUnavailable")}</span> : null}
      </div>
    </div>
  );
}
