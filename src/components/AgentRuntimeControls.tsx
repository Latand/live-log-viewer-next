"use client";

import { Check, Loader2 } from "lucide-react";
import { useMemo } from "react";

import { effortTierLabel } from "@/components/builderCopy";
import { Select } from "@/components/ui/Select";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

import type { RuntimeDraft } from "./runtimeProfile";

export type { RuntimeDraft } from "./runtimeProfile";
export type RuntimeApplyState = "idle" | "saving" | "pending" | "confirming" | "applied" | "error";

/**
 * The explicit model · effort · Apply picker a pipeline stage placeholder
 * mounts (issue #196). The live/resume/structured conversation surfaces moved
 * to the composer's RuntimePill (issue #390) — launch surfaces like this one
 * keep their selects and the explicit Apply, because a stage override is a
 * deliberate PATCH, not a next-message setting.
 *
 * Intended compact behavior (issue #405): below `md` the SAME selects stay in
 * place — a stage pane is a full-width surface, not a cramped strip, so
 * nothing folds behind a sheet — but the row wraps and every control inflates
 * to the 44px touch target (design rule 8), so the pickers remain usable at
 * 390px.
 * `withDefaults` prepends a "default" choice for model/effort (a stage may
 * leave both to its role's defaults); `showSpeed` gates the codex-only speed
 * control off for surfaces without a speed concept.
 */
export function RuntimeControlsView({
  engine,
  draft,
  state,
  error,
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
  /** Observed-runtime face values, kept in the contract for the stage pane's
      call site; the desktop selects render the draft directly. */
  observedModelLabel?: string;
  observedEffort?: string;
  draftPending?: boolean;
  showSpeed?: boolean;
  withDefaults?: boolean;
  /** Frozen surfaces (a pipeline stage that already ran) disable the pickers;
      live windows never pass this. */
  disabled?: boolean;
  onEdit: (update: (current: RuntimeDraft) => RuntimeDraft) => void;
  onApply: () => void;
}) {
  const { t } = useLocale();
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

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" onPointerDown={(event) => event.stopPropagation()} title={error || undefined}>
      <Select
        aria-label={t("runtimeConfig.model")}
        value={draft.model}
        disabled={disabled}
        className="max-md:min-h-11"
        onChange={(event) => editModel(event.target.value)}
      >
        {withDefaults ? <option value="">{t("draft.modelDefault")}</option> : null}
        {ENGINE_MODELS[engine].map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </Select>
      <Select
        aria-label={t("runtimeConfig.effort")}
        value={draft.effort}
        disabled={disabled}
        className="max-md:min-h-11"
        onChange={(event) => onEdit((current) => ({ ...current, effort: event.target.value }))}
      >
        {withDefaults ? <option value="">{t("draft.effortDefault")}</option> : null}
        {efforts.map((effort) => <option key={effort} value={effort}>{effortTierLabel(t, effort)}</option>)}
      </Select>
      {speedShown ? (
        <label className="inline-flex h-7 items-center gap-1 rounded-control border border-border bg-card px-1.5 text-ui font-semibold text-secondary max-md:min-h-11 max-md:px-2.5" title={t("runtimeConfig.speedTitle")}>
          <input type="checkbox" checked={draft.fast} onChange={(event) => onEdit((current) => ({ ...current, fast: event.target.checked }))} /> {t("draft.speedFast")}
        </label>
      ) : null}
      <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-canvas px-1.5 text-[9.5px] font-semibold text-muted hover:border-accent/45 hover:text-accent disabled:opacity-60 max-md:min-h-11 max-md:px-2.5 max-md:text-label" disabled={disabled || state === "saving"} onClick={onApply} aria-label={t("runtimeConfig.apply")}>
        {applyBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Check className="h-3 w-3" aria-hidden />}
        {t("runtimeConfig.apply")}
      </button>
    </div>
  );
}
