"use client";

import { effortTierLabel } from "@/components/builderCopy";
import { Select } from "@/components/ui/Select";
import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

/** Codex speed choice: empty string keeps the user's config.toml default. */
export type SpeedChoice = "" | "fast" | "standard";

/**
 * Reasoning-effort select plus the codex-only speed (fast/standard) select —
 * the shared control strip for every "start a new agent" surface. The tier
 * list follows the engine; an empty value leaves the CLI on its own default.
 * All three ride the design system's one select recipe (issue #221 §6), and
 * tier/speed labels localize while the submitted values stay the CLI tokens.
 */
export function ReasoningControls({
  engine,
  model,
  effort,
  speed,
  disabled,
  onModel,
  onEffort,
  onSpeed,
}: {
  engine: "claude" | "codex";
  model: string;
  effort: string;
  speed: SpeedChoice;
  disabled?: boolean;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onSpeed: (value: SpeedChoice) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <Select
        value={model}
        disabled={disabled}
        aria-label={t("draft.modelAria")}
        title={t("draft.modelAria")}
        onChange={(event) => onModel(event.target.value)}
      >
        <option value="">{t("draft.modelDefault")}</option>
        {ENGINE_MODELS[engine].map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      <Select
        value={effort}
        disabled={disabled}
        aria-label={t("draft.reasoningAria")}
        title={t("draft.reasoningAria")}
        onChange={(event) => onEffort(event.target.value)}
      >
        <option value="">{t("draft.effortDefault")}</option>
        {ENGINE_EFFORTS[engine].map((tier) => (
          <option key={tier} value={tier}>
            {effortTierLabel(t, tier)}
          </option>
        ))}
      </Select>
      {engine === "codex" ? (
        <Select
          value={speed}
          disabled={disabled}
          aria-label={t("draft.speedAria")}
          title={t("draft.speedTitle")}
          onChange={(event) => onSpeed(event.target.value as SpeedChoice)}
        >
          <option value="">{t("draft.speedDefault")}</option>
          <option value="fast">{t("draft.speedFast")}</option>
          <option value="standard">{t("draft.speedStandard")}</option>
        </Select>
      ) : null}
    </>
  );
}
