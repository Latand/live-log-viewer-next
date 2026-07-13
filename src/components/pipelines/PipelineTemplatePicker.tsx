"use client";

import { useEffect } from "react";

import { X } from "@/components/icons";
import { useLocale } from "@/lib/i18n";

import { PIPELINE_TEMPLATES, type PipelineTemplate } from "./pipelineModel";

/**
 * Template-first pipeline entry (issue #196): picking a template drops a DRAFT
 * pipeline on the canvas with the template's WHOLE role chain — every stage
 * lands as a dashed placeholder window before anything spawns. "Blank canvas"
 * keeps the #136 empty-draft path (assemble stages by hand). Bottom sheet on
 * the phone, centered dialog on desktop; every row is a 44px target.
 */
export function PipelineTemplatePicker({
  busy,
  onPick,
  onClose,
}: {
  busy: boolean;
  /** A template, or null for the empty "blank canvas" draft. */
  onPick: (template: PipelineTemplate | null) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const templates = PIPELINE_TEMPLATES.filter((template) => template.id !== "blank");
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 sm:items-center"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("pipelineTemplates.title")}
        className="w-full max-w-[460px] rounded-t-[16px] bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 sm:rounded-[12px] sm:pb-3"
      >
        <div className="mb-1 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-primary">{t("pipelineTemplates.title")}</div>
            <div className="text-[12px] text-muted">{t("pipelineTemplates.subtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex flex-col gap-1">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(template)}
              className="flex min-h-11 w-full flex-col justify-center gap-1 rounded-[8px] px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
            >
              <span className="text-[13px] font-semibold text-primary">{t(template.labelKey)}</span>
              <span className="flex flex-wrap items-center gap-1" aria-hidden>
                {template.stages.map((stage, index) => (
                  <span key={index} className="flex items-center gap-1">
                    {index ? <span className="text-[11px] font-bold text-strong">→</span> : null}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
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
            disabled={busy}
            onClick={() => onPick(null)}
            className="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-[8px] border border-dashed border-strong px-3 py-2 text-left hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
          >
            <span className="text-[13px] font-semibold text-primary">{t("pipelineTemplates.blank")}</span>
            <span className="text-[11px] text-muted">{t("pipelineTemplates.blankHint")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
