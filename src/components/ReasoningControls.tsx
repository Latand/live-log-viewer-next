"use client";

import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

/** Codex speed choice: empty string keeps the user's config.toml default. */
export type SpeedChoice = "" | "fast" | "standard";

/**
 * Reasoning-effort select plus the codex-only speed (fast/standard) select —
 * the shared control strip for every "start a new agent" surface. The tier
 * list follows the engine; an empty value leaves the CLI on its own default.
 * `size="tall"` renders the same controls at the 44px touch recipe for
 * surfaces that need full-size pickers (pipeline stage placeholders, #196).
 */
export function ReasoningControls({
  engine,
  model,
  effort,
  speed,
  disabled,
  size = "compact",
  onModel,
  onEffort,
  onSpeed,
}: {
  engine: "claude" | "codex";
  model: string;
  effort: string;
  speed: SpeedChoice;
  disabled?: boolean;
  size?: "compact" | "tall";
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onSpeed: (value: SpeedChoice) => void;
}) {
  const { t } = useLocale();
  const selectClass =
    size === "tall"
      ? "min-h-11 min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-2.5 text-[12px] font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
      : "h-7 min-w-0 rounded-[8px] border border-line bg-panel px-1.5 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60";
  return (
    <>
      <select
        value={model}
        disabled={disabled}
        aria-label={t("draft.modelAria")}
        title={t("draft.modelAria")}
        className={selectClass}
        onChange={(event) => onModel(event.target.value)}
      >
        <option value="">{t("draft.modelDefault")}</option>
        {ENGINE_MODELS[engine].map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <select
        value={effort}
        disabled={disabled}
        aria-label={t("draft.reasoningAria")}
        title={t("draft.reasoningAria")}
        className={selectClass}
        onChange={(event) => onEffort(event.target.value)}
      >
        <option value="">{t("draft.effortDefault")}</option>
        {ENGINE_EFFORTS[engine].map((tier) => (
          <option key={tier} value={tier}>
            {tier}
          </option>
        ))}
      </select>
      {engine === "codex" ? (
        <select
          value={speed}
          disabled={disabled}
          aria-label={t("draft.speedAria")}
          title={t("draft.speedTitle")}
          className={selectClass}
          onChange={(event) => onSpeed(event.target.value as SpeedChoice)}
        >
          <option value="">{t("draft.speedDefault")}</option>
          <option value="fast">fast</option>
          <option value="standard">standard</option>
        </select>
      ) : null}
    </>
  );
}
