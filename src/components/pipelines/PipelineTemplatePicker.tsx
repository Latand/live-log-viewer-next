"use client";

import { useEffect, useRef, useState } from "react";

import { X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";
import type { Pipeline, PipelineRepoPreflightErrorCode } from "@/lib/pipelines/types";

import {
  PIPELINE_TEMPLATES,
  preflightPipelineRepository,
  type PipelineClientResult,
  type PipelineTemplate,
} from "./pipelineModel";

type PickerState =
  | { phase: "checking" }
  | { phase: "ready"; repoDir: string }
  | { phase: "creating"; repoDir: string }
  | { phase: "blocked"; code: PipelineRepoPreflightErrorCode; path: string; error?: string };

/**
 * Template-first pipeline entry (issue #196): picking a template drops a DRAFT
 * pipeline on the canvas with the template's WHOLE role chain — every stage
 * lands as a dashed placeholder window before anything spawns. "Blank canvas"
 * keeps the #136 empty-draft path (assemble stages by hand). Bottom sheet on
 * the phone, centered dialog on desktop; every row is a 44px target.
 */
export function PipelineTemplatePicker({
  repoDir,
  onCreate,
  onCreated,
  onClose,
}: {
  repoDir: string;
  onCreate: (template: PipelineTemplate | null, canonicalRepoDir: string) => Promise<PipelineClientResult>;
  onCreated: (pipeline: Pipeline) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [repoInput, setRepoInput] = useState(repoDir);
  const [retry, setRetry] = useState(0);
  // An empty directory mounts already blocked (#404): "checking" — and its
  // spinner — exists only while a preflight request is actually in flight.
  const [state, setState] = useState<PickerState>(() =>
    repoDir.trim() ? { phase: "checking" } : { phase: "blocked", code: "missing", path: "" });
  const generation = useRef(0);

  useEffect(() => {
    const requestedRepo = repoInput.trim();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    if (!requestedRepo) return () => controller.abort();
    void preflightPipelineRepository(requestedRepo, controller.signal).then((result) => {
      if (currentGeneration !== generation.current || controller.signal.aborted) return;
      if (result.ok) setState({ phase: "ready", repoDir: result.repoDir });
      else setState({ phase: "blocked", code: result.code, path: result.path, error: result.error });
    }).catch((error) => {
      if (currentGeneration !== generation.current || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ phase: "blocked", code: "missing", path: requestedRepo, error: t("common.serverUnavailable") });
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale copy is resolved when the request settles; repository generations drive this effect
  }, [repoInput, retry]);

  const creating = state.phase === "creating";
  const ready = state.phase === "ready";
  const shownRepoDir = state.phase === "ready" || state.phase === "creating" ? state.repoDir : repoInput;
  const create = async (template: PipelineTemplate | null) => {
    if (state.phase !== "ready") return;
    const canonicalRepoDir = state.repoDir;
    setState({ phase: "creating", repoDir: canonicalRepoDir });
    const result = await onCreate(template, canonicalRepoDir);
    if (result.pipeline) {
      onCreated(result.pipeline);
      return;
    }
    setState({
      phase: "blocked",
      code: result.code ?? "missing",
      path: result.path ?? canonicalRepoDir,
      error: result.code ? undefined : result.error,
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || creating) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creating, onClose]);
  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  const blockedPath = state.phase === "blocked" ? (state.path || shownRepoDir).trim() : "";
  const blockedMessage = state.phase === "blocked"
    ? state.error ?? (blockedPath
      ? t(`pipelinePreflight.${state.code}`, { path: blockedPath })
      : t("pipelinePreflight.empty"))
    : null;
  return (
    <div
      data-pipeline-picker-state={state.phase}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineTemplates.title")}
        className="w-full max-w-[460px] rounded-t-surface bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 sm:rounded-surface sm:pb-3"
      >
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-title font-bold text-primary">{t("pipelineTemplates.title")}</div>
            <div className="text-ui text-muted">{t("pipelineTemplates.subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <label className="mb-2 flex flex-col gap-1">
          <span className="text-label font-semibold text-secondary">{t("pipelineTemplates.repoDir")}</span>
          <input
            value={shownRepoDir}
            disabled={creating}
            autoFocus={!repoDir.trim()}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setRepoInput(value);
              setState(value.trim()
                ? { phase: "checking" }
                : { phase: "blocked", code: "missing", path: "" });
            }}
            className="h-11 w-full rounded-control border border-border bg-canvas px-3 text-ui font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          />
        </label>
        <div className="mb-2 flex min-h-8 items-center gap-2 text-ui font-semibold text-muted" aria-live="polite">
          {state.phase === "checking" ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />{t("pipelineTemplates.checking")}</> : null}
          {state.phase === "ready" ? <span className="text-success">{t("pipelineTemplates.ready")}</span> : null}
          {state.phase === "creating" ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />{t("pipelineTemplates.creating")}</> : null}
          {state.phase === "blocked" ? (
            <span className="flex w-full items-start gap-2 rounded-control border border-danger/30 bg-danger-soft px-2 py-1.5 text-danger" role="alert">
              <span className="min-w-0 flex-1">{blockedMessage}</span>
              <button
                type="button"
                className="min-h-8 shrink-0 rounded-control border border-danger/30 px-2 text-label font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
                onClick={() => {
                  // Retrying an empty input has no request to wait for (#404):
                  // stay blocked instead of stranding a "checking" spinner.
                  if (repoInput.trim()) setState({ phase: "checking" });
                  setRetry((value) => value + 1);
                }}
              >
                {t("pipelineTemplates.retry")}
              </button>
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={!ready}
              onClick={() => void create(template)}
              className="flex min-h-11 w-full flex-col justify-center gap-1 rounded-control px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            >
              <span className="text-body font-semibold text-primary">{t(template.labelKey)}</span>
              <span className="flex flex-wrap items-center gap-1" aria-hidden>
                {template.stages.map((stage, index) => (
                  <span key={index} className="flex items-center gap-1">
                    {index ? <span className="text-label font-bold text-strong">→</span> : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-caption font-semibold ${
                        stage.kind === "review-loop" ? "bg-accent-soft text-accent" : "bg-sunken text-secondary"
                      }`}
                    >
                      {stage.kind === "review-loop" ? "⟳ " : ""}
                      {stage.roleId || t("pipelineTemplates.noRole")}
                    </span>
                  </span>
                ))}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled={!ready}
            onClick={() => void create(null)}
            className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-control border border-dashed border-strong px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
          >
            <span className="text-body font-semibold text-primary">{t("pipelineTemplates.blank")}</span>
            <span className="text-label text-muted">{t("pipelineTemplates.blankHint")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
