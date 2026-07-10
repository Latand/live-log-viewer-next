"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { CODEX_SOL_MODEL } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { RoleConfig } from "@/lib/roles/types";

import {
  PIPELINE_TEMPLATES,
  createPipeline,
  draftStagesToInput,
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

/** Turns a client template into draft stages, resolving each role's runtime from
    the loaded catalog so the runtime line and access match the +Agent draft. */
function stagesFromTemplate(template: PipelineTemplate, roles: RoleCatalogItem[], runtime: RoleConfig): DraftStage[] {
  return template.stages.map((seed) => {
    const role = seed.roleId ? roles.find((item) => item.id === seed.roleId) ?? null : null;
    const params = role ? defaultRoleParams(role) : {};
    const resolved = role ? roleRuntime(role, params) : runtime;
    return {
      key: nextStageKey(),
      kind: seed.kind,
      roleId: role ? seed.roleId : "",
      engine: resolved.engine,
      model: "",
      effort: "",
      access: seed.kind === "review-loop" ? "read-only" : role ? roleAccess(role) : seed.access,
      prompt: seed.prompt,
      roleParams: params,
    };
  });
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
  const [dirs, setDirs] = useState<string[]>([]);
  const [task, setTask] = useState(() => readDraft(project).task);
  const [spec, setSpec] = useState(() => readDraft(project).spec);
  const [repoDir, setRepoDir] = useState(() => readDraft(project).repoDir || repoPrefill || "");
  const [stages, setStages] = useState<DraftStage[]>(() => {
    const restored = readDraft(project).stages;
    return restored.length >= 2 ? restored.map((stage) => ({ ...stage, key: nextStageKey() })) : [blankStage(FALLBACK_RUNTIME), blankStage(FALLBACK_RUNTIME)];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskRef = useRef<HTMLInputElement>(null);

  const defaultRuntime = useMemo<RoleConfig>(() => roles.find((role) => role.id === "builder")?.config ?? FALLBACK_RUNTIME, [roles]);

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/roles").then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as { roles?: RoleCatalogItem[] };
      if (!cancelled && Array.isArray(body.roles)) setRoles(body.roles);
    }).catch(() => {});
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

  const setStage = (index: number, next: DraftStage) => setStages((prev) => prev.map((stage, i) => (i === index ? next : stage)));
  const removeStage = (index: number) => setStages((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== index)));
  const moveStage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    setStages((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  const addStage = () => setStages((prev) => (prev.length >= 4 ? prev : [...prev, blankStage(defaultRuntime)]));
  const applyTemplate = (template: PipelineTemplate) => setStages(stagesFromTemplate(template, roles, defaultRuntime));

  const validationError = useMemo<string | null>(() => {
    if (!task.trim()) return t("pipelineDialog.errors.taskRequired");
    if (!repoDir.trim()) return t("pipelineDialog.errors.repoRequired");
    if (stages.some((stage) => !stage.prompt.trim())) return t("pipelineDialog.errors.promptRequired");
    return null;
  }, [task, repoDir, stages, t]);

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

  return (
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
            {PIPELINE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className="rounded-full border border-line bg-bg px-2.5 py-1 text-[10.5px] font-semibold text-dim hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => applyTemplate(template)}
              >
                {t(template.labelKey)}
              </button>
            ))}
          </div>
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
}
