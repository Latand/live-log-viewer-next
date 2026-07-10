"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { CODEX_SOL_MODEL, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import { MAX_ROLE_PARAM_TEXT_LENGTH, MAX_SPEC_LENGTH, MAX_STAGE_PROMPT_LENGTH, MAX_TASK_LENGTH } from "@/lib/pipelines/limits";
import { PIPELINE_DISALLOWED_ROLE_IDS, type PipelineRoleId } from "@/lib/pipelines/types";
import type { RoleConfig, RoleParameter } from "@/lib/roles/types";

import {
  PIPELINE_TEMPLATES,
  createPipeline,
  draftStagesToInput,
  normalizeStageOrder,
  type DraftStage,
  type PipelineTemplate,
} from "./pipelineModel";
import { StageRow, type RoleCatalogItem, defaultRoleParams, roleAccess, roleRuntime } from "./StageRow";

const FALLBACK_RUNTIME: RoleConfig = { engine: "codex", model: CODEX_SOL_MODEL, effort: "medium" };

let stageKeySeq = 0;
function nextStageKey(): string {
  stageKeySeq += 1;
  return `stage-${stageKeySeq}`;
}

function draftKey(project: string): string {
  return `llvPipelineDraft:${project}`;
}

type DraftSnapshot = { task: string; spec: string; repoDir: string; stages: DraftStage[] };

function readDraft(project: string): DraftSnapshot {
  const empty: DraftSnapshot = { task: "", spec: "", repoDir: "", stages: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = sessionStorage.getItem(draftKey(project));
    const parsed = raw ? (JSON.parse(raw) as DraftSnapshot) : null;
    if (parsed && Array.isArray(parsed.stages)) return parsed;
  } catch {
    /* private mode / malformed draft: start clean */
  }
  return empty;
}

function blankStage(runtime: RoleConfig): DraftStage {
  return { key: nextStageKey(), kind: "run", roleId: "", engine: runtime.engine, model: "", effort: "", access: "read-write", prompt: "", roleParams: {} };
}

/* Client detection without a setState-in-effect: the server snapshot is false
   (so SSR / static-render tests render the overlay inline, where portals are
   unsupported), the client snapshot is true (so the modal portals to body). */
const noopSubscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Client mirror of the registry's per-parameter value checks. Absent/blank
    resolves to a registry default (not required here, matching the API), so only
    supplied values are checked. Returns an i18n key on failure, else null. */
export function roleParamError(parameter: RoleParameter, value: string | number | undefined): MessageKey | null {
  if (parameter.kind === "integer") {
    if (value === "" || value === undefined) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || (parameter.min !== undefined && n < parameter.min) || (parameter.max !== undefined && n > parameter.max)) {
      return "pipelineDialog.errors.paramInvalid";
    }
    return null;
  }
  /* Trim before every check: the server's boundedText trims too, so a
     whitespace-only value resolves to the registry default (absent), and a
     real value is length-checked on its trimmed form. */
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (parameter.kind === "select") {
    return parameter.options?.includes(text) ? null : "pipelineDialog.errors.paramInvalid";
  }
  return text.length > MAX_ROLE_PARAM_TEXT_LENGTH ? "pipelineDialog.errors.paramInvalid" : null;
}

/** Turns a client template into draft stages, resolving each role's runtime from
    the loaded catalog so the runtime line and access match the +Agent draft.
    Seeds carry concrete model/effort exactly as {@link StageRow.selectRole}
    would, so an architect stage shows its own runtime, not the Builder fallback.
    Callers gate role-bearing templates on a loaded catalog (see below), so a
    seeded roleId always resolves here. */
export function stagesFromTemplate(template: PipelineTemplate, roles: RoleCatalogItem[], runtime: RoleConfig): DraftStage[] {
  return template.stages.map((seed) => {
    const role = seed.roleId ? roles.find((item) => item.id === seed.roleId) ?? null : null;
    const params = role ? defaultRoleParams(role) : {};
    const resolved = role ? roleRuntime(role, params) : runtime;
    return {
      key: nextStageKey(),
      kind: seed.kind,
      roleId: role ? seed.roleId : "",
      engine: resolved.engine,
      model: role ? resolved.model : "",
      effort: role ? resolved.effort : "",
      access: seed.kind === "review-loop" ? "read-only" : role ? roleAccess(role) : seed.access,
      prompt: seed.prompt,
      roleParams: params,
    };
  });
}

/** A template that seeds any role can only be applied once the role catalog has
    loaded — otherwise every seeded roleId would strip to a raw stage. */
export function templateReady(template: PipelineTemplate, roles: RoleCatalogItem[]): boolean {
  return roles.length > 0 || template.stages.every((seed) => !seed.roleId);
}

/** Inline validation that mirrors the create API, so a completed dialog does not
    bounce off a 400: required fields, size limits, cross-engine model
    compatibility, and canonical role-param value checks. A module function (not
    an inline useMemo) so the React compiler can memoize it. Returns the first
    error message, or null when the request would be accepted. */
export function pipelineValidationError(
  t: TFunction,
  { task, spec, repoDir, stages, roles, defaultRuntime }: { task: string; spec: string; repoDir: string; stages: DraftStage[]; roles: RoleCatalogItem[]; defaultRuntime: RoleConfig },
): string | null {
  if (!task.trim()) return t("pipelineDialog.errors.taskRequired");
  if (!repoDir.trim()) return t("pipelineDialog.errors.repoRequired");
  if (stages.some((stage) => !stage.prompt.trim())) return t("pipelineDialog.errors.promptRequired");
  if (task.trim().length > MAX_TASK_LENGTH) return t("pipelineDialog.errors.tooLong", { field: t("pipelineDialog.task"), max: MAX_TASK_LENGTH });
  if (spec.trim().length > MAX_SPEC_LENGTH) return t("pipelineDialog.errors.tooLong", { field: t("pipelineDialog.spec"), max: MAX_SPEC_LENGTH });
  if (stages.some((stage) => stage.prompt.trim().length > MAX_STAGE_PROMPT_LENGTH)) {
    return t("pipelineDialog.errors.tooLong", { field: t("pipelineDialog.prompt"), max: MAX_STAGE_PROMPT_LENGTH });
  }
  for (const stage of stages) {
    const role = stage.roleId ? roles.find((item) => item.id === stage.roleId) ?? null : null;
    /* The model that will actually resolve server-side: an explicit override,
       else the role's runtime, else the Builder default. Mirror the API's
       cross-engine check so a Claude stage never ships a codex model (400). */
    const effModel = stage.model.trim() || (role ? roleRuntime(role, stage.roleParams).model : "") || defaultRuntime.model;
    if (stage.engine === "claude" && effModel && !normalizeClaudeLaunchModel(effModel)) return t("pipelineDialog.errors.modelEngineMismatch", { engine: "Claude" });
    if (stage.engine === "codex" && effModel && !effModel.startsWith("gpt-")) return t("pipelineDialog.errors.modelEngineMismatch", { engine: "Codex" });
    if (!role) continue;
    /* Absent/blank params resolve to registry defaults server-side, so — like
       the API — they are not required; only supplied values are checked. */
    for (const parameter of role.parameters) {
      const invalid = roleParamError(parameter, stage.roleParams[parameter.key]);
      if (invalid) return t(invalid, { label: parameter.label });
    }
  }
  return null;
}

/**
 * The pipeline chain builder (#93 §1): a modal that composes 2–4 stages — role
 * preset or raw prompt, ordered, with a task and optional pinned spec — and
 * POSTs them to /api/pipelines. Patterned on FlowDialog; the dashboard strip and
 * board chain materialize as stage sessions appear.
 */
export function PipelineDialog({
  project,
  repoPrefill,
  src,
  srcLabel,
  onClose,
  onCreated,
}: {
  project: string;
  repoPrefill?: string;
  /** Transcript path stage 0 descends from, when opened from a node. */
  src?: string;
  srcLabel?: string;
  onClose: () => void;
  onCreated?: (pipelineId: string) => void;
}) {
  const { t } = useLocale();
  const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
  const [rolesError, setRolesError] = useState(false);
  const [rolesReload, setRolesReload] = useState(0);
  const [dirs, setDirs] = useState<string[]>([]);
  const [task, setTask] = useState(() => readDraft(project).task);
  const [spec, setSpec] = useState(() => readDraft(project).spec);
  const [repoDir, setRepoDir] = useState(() => readDraft(project).repoDir || repoPrefill || "");
  const [stages, setStages] = useState<DraftStage[]>(() => {
    const restored = readDraft(project).stages;
    return restored.length >= 2 ? normalizeStageOrder(restored.map((stage) => ({ ...stage, key: nextStageKey() }))) : [blankStage(FALLBACK_RUNTIME), blankStage(FALLBACK_RUNTIME)];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClient = useSyncExternalStore(noopSubscribe, clientSnapshot, serverSnapshot);
  const taskRef = useRef<HTMLInputElement>(null);

  const defaultRuntime = useMemo<RoleConfig>(() => roles.find((role) => role.id === "builder")?.config ?? FALLBACK_RUNTIME, [roles]);

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  /* Role catalog fetch, retryable via the rolesReload bump. A non-2xx, network
     error, or malformed body surfaces `rolesError` instead of failing silently —
     otherwise the templates stay disabled under a permanent loading tooltip and
     the role picker only ever offers "No role". */
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/roles")
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { roles?: RoleCatalogItem[] };
        if (!Array.isArray(body.roles)) throw new Error("malformed");
        if (cancelled) return;
        /* Deployer needs an interactive deploy confirmation a pipeline can't give,
           so it never enters the picker (the API rejects it too). */
        setRoles(body.roles.filter((role) => !PIPELINE_DISALLOWED_ROLE_IDS.includes(role.id as PipelineRoleId)));
        setRolesError(false);
      })
      .catch(() => {
        if (!cancelled) setRolesError(true);
      });
    return () => { cancelled = true; };
  }, [rolesReload]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/spawn?project=" + encodeURIComponent(project) + (src ? "&src=" + encodeURIComponent(src) : ""))
      .then((res) => res.json() as Promise<{ dirs?: string[]; cwd?: string | null }>)
      .then((json) => {
        if (cancelled) return;
        if (Array.isArray(json.dirs)) setDirs(json.dirs);
        setRepoDir((prev) => prev || (typeof json.cwd === "string" ? json.cwd : "") || json.dirs?.[0] || "");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project, src]);

  /* Draft survives an accidental close, mirroring DraftAgentPane field persistence. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(draftKey(project), JSON.stringify({ task, spec, repoDir, stages }));
    } catch {
      /* private mode / quota: the draft simply is not preserved */
    }
  }, [project, task, spec, repoDir, stages]);

  const setStage = (index: number, next: DraftStage) => setStages((prev) => normalizeStageOrder(prev.map((stage, i) => (i === index ? next : stage))));
  const removeStage = (index: number) => setStages((prev) => (prev.length <= 2 ? prev : normalizeStageOrder(prev.filter((_, i) => i !== index))));
  const moveStage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    setStages((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return normalizeStageOrder(next);
    });
  };
  const addStage = () => setStages((prev) => (prev.length >= 4 ? prev : [...prev, blankStage(defaultRuntime)]));
  const applyTemplate = (template: PipelineTemplate) => setStages(stagesFromTemplate(template, roles, defaultRuntime));

  const validationError = pipelineValidationError(t, { task, spec, repoDir, stages, roles, defaultRuntime });

  const submit = async () => {
    if (busy) return;
    setError(validationError);
    if (validationError) return;
    setBusy(true);
    const result = await createPipeline({
      task: task.trim(),
      ...(spec.trim() ? { spec: spec.trim() } : {}),
      repoDir: repoDir.trim(),
      stages: draftStagesToInput(stages),
      ...(src ? { src } : {}),
    });
    setBusy(false);
    if (result.pipeline) {
      try {
        sessionStorage.removeItem(draftKey(project));
      } catch {
        /* ignore storage failure */
      }
      onCreated?.(result.pipeline.id);
      onClose();
      return;
    }
    setError(result.error ?? t("pipelineModel.failed", { status: 0 }));
  };

  const overlay = (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        data-scheme-ui
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineDialog.title")}
        className="my-auto flex w-full max-w-[680px] flex-col gap-2.5 rounded-[14px] border border-line bg-panel p-4 shadow-[0_18px_60px_rgb(20_20_30/0.28)]"
      >
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-col">
            <span className="text-[14px] font-bold">{t("pipelineDialog.title")}</span>
            <span className="text-[11px] text-dim">{t("pipelineDialog.subtitle")}</span>
          </div>
          <button
            type="button"
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-line bg-bg text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={t("common.cancel")}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("pipelineDialog.task")}
          <input
            ref={taskRef}
            value={task}
            maxLength={MAX_TASK_LENGTH}
            placeholder={t("pipelineDialog.taskPlaceholder")}
            className="h-9 rounded-[8px] border border-line bg-bg px-2.5 text-[12.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setTask(event.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("pipelineDialog.spec")}
          <textarea
            value={spec}
            rows={3}
            maxLength={MAX_SPEC_LENGTH}
            placeholder={t("pipelineDialog.specPlaceholder")}
            className="resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setSpec(event.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
          {t("pipelineDialog.repo")}
          <input
            value={repoDir}
            list="pipeline-dialog-dirs"
            placeholder={t("pipelineDialog.repoPlaceholder")}
            className="h-9 rounded-[8px] border border-line bg-bg px-2.5 font-mono text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setRepoDir(event.target.value)}
          />
          <datalist id="pipeline-dialog-dirs">
            {dirs.map((dir) => <option key={dir} value={dir} />)}
          </datalist>
        </label>

        {src ? (
          <span className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10.5px] font-semibold text-accent">
            <span className="min-w-0 truncate" title={src}>{t("pipelineDialog.fromSession", { node: srcLabel ?? src })}</span>
          </span>
        ) : null}

        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-semibold text-dim">{t("pipelineDialog.templatesLabel")}</span>
          <div className="flex flex-wrap gap-1.5">
            {PIPELINE_TEMPLATES.map((template) => {
              const ready = templateReady(template, roles);
              return (
                <button
                  key={template.id}
                  type="button"
                  disabled={!ready}
                  title={ready ? undefined : rolesError ? t("pipelineDialog.templatesUnavailable") : t("pipelineDialog.templatesLoading")}
                  className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-semibold text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => applyTemplate(template)}
                >
                  {t(template.labelKey)}
                </button>
              );
            })}
          </div>
          {rolesError ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[#e0ae45]/50 bg-[#fdf6ec] px-2.5 py-1.5" role="alert">
              <span className="min-w-0 flex-1 text-[10.5px] font-semibold text-[#8a5b00]">{t("pipelineDialog.rolesError")}</span>
              <button
                type="button"
                className="shrink-0 rounded-full border border-[#e0ae45]/60 bg-panel px-2.5 py-0.5 text-[10.5px] font-bold text-[#8a5b00] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => setRolesReload((n) => n + 1)}
              >
                {t("pipelineDialog.rolesRetry")}
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-bold tracking-[0.06em] text-dim">{t("pipelineDialog.stagesLabel", { count: stages.length })}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {stages.map((stage, index) => (
            <StageRow
              key={stage.key}
              index={index}
              total={stages.length}
              stage={stage}
              roles={roles}
              defaultRuntime={defaultRuntime}
              onChange={(next) => setStage(index, next)}
              onRemove={() => removeStage(index)}
              onMove={(direction) => moveStage(index, direction)}
            />
          ))}
        </div>
        <button
          type="button"
          className="self-start rounded-[8px] border border-dashed border-line bg-bg px-3 py-1.5 text-[11px] font-semibold text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          disabled={stages.length >= 4}
          onClick={addStage}
        >
          <Plus className="mr-1 inline h-3.5 w-3.5" aria-hidden /> {t("pipelineDialog.addStage")}
        </button>

        <div className="mt-1 flex items-center gap-2 border-t border-line pt-2.5">
          {error ? <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-err" title={error}>{error}</span> : <span className="flex-1" />}
          <button
            type="button"
            className="rounded-[8px] border border-line bg-bg px-3 py-1.5 text-[11.5px] font-semibold text-dim hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="rounded-[8px] border border-accent bg-accent px-3.5 py-1.5 text-[12px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? t("pipelineDialog.starting") : t("pipelineDialog.start")}
          </button>
        </div>
      </div>
    </div>
  );

  /* Portal to the body: node-launched dialogs otherwise mount inside the board's
     scaled/translated world, which becomes the containing block for the fixed
     backdrop and makes the modal pan and clip with the canvas. Before mount (SSR
     / static render) there are no portals, so render inline. */
  return isClient && typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
}
