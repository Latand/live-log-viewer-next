"use client";

import { useEffect, useId, useState } from "react";

import { ENGINE_EFFORTS } from "@/lib/agent/efforts";
import { ENGINE_MODELS } from "@/lib/agent/models";
import type { FlowPreset, FlowsResponse, RoleConfig } from "@/lib/flows/types";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const FALLBACK_ROLES: Record<"implementer" | "reviewer", RoleConfig> = {
  implementer: { engine: "claude", model: null, effort: null },
  reviewer: { engine: "codex", model: null, effort: "xhigh" },
};

function RoleEditor({
  label,
  role,
  onChange,
}: {
  label: string;
  role: RoleConfig;
  onChange: (next: RoleConfig) => void;
}) {
  const { t } = useLocale();
  const modelListId = useId();
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-[86px] shrink-0 text-[10.5px] font-semibold text-muted">{label}</span>
      <select
        value={role.engine}
        aria-label={t("flowDialog.engine", { label })}
        className="h-7 rounded-[8px] border border-border bg-canvas px-1.5 text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onChange={(event) => onChange({ ...role, engine: event.target.value as RoleConfig["engine"], effort: null })}
      >
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <input
        value={role.model ?? ""}
        list={modelListId}
        placeholder={t("flowDialog.modelPlaceholder")}
        aria-label={t("flowDialog.model", { label })}
        className="h-7 w-0 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-1.5 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onChange={(event) => onChange({ ...role, model: event.target.value.trim() || null })}
      />
      <datalist id={modelListId}>
        {ENGINE_MODELS[role.engine].map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </datalist>
      <select
        value={role.effort ?? ""}
        aria-label={`Reasoning effort: ${label}`}
        className="h-7 rounded-[8px] border border-border bg-canvas px-1.5 text-[11.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        onChange={(event) => onChange({ ...role, effort: event.target.value || null })}
      >
        <option value="">{t("flowDialog.effortDefault")}</option>
        {ENGINE_EFFORTS[role.engine].map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Flow creation panel for a conversation node: preset, per-role overrides,
 * base ref mode, auto/manual, reviewer mode, round limit. POSTs /api/flows;
 * the strip and the deck appear with the next files poll.
 */
export function FlowDialog({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  const { t } = useLocale();
  const [presets, setPresets] = useState<FlowPreset[]>([]);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [roles, setRoles] = useState(FALLBACK_ROLES);
  const [custom, setCustom] = useState(false);
  const [baseMode, setBaseMode] = useState<"head" | "merge-base">("head");
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [reviewerMode, setReviewerMode] = useState<"headless" | "pane">("headless");
  const [roundLimit, setRoundLimit] = useState(5);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/flows")
      .then((res) => res.json() as Promise<FlowsResponse>)
      .then((json) => {
        if (cancelled || !Array.isArray(json.presets) || !json.presets.length) return;
        setPresets(json.presets);
        setPresetName((prev) => prev ?? json.presets[0]!.name);
        setRoles({ implementer: json.presets[0]!.implementer, reviewer: json.presets[0]!.reviewer });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const pickPreset = (name: string) => {
    setPresetName(name);
    const preset = presets.find((item) => item.name === name);
    if (preset) setRoles({ implementer: preset.implementer, reviewer: preset.reviewer });
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          implementerPath: file.path,
          ...(custom || !presetName ? { roles } : { preset: presetName }),
          baseMode,
          mode,
          reviewerMode,
          roundLimit,
          ...(spec.trim() ? { spec: spec.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? t("flowDialog.createFailed", { status: res.status }));
        return;
      }
      onClose();
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-scheme-ui
      className="flex w-[420px] flex-col gap-2.5 rounded-[12px] border border-border bg-card p-3 shadow-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-bold">{t("flowDialog.title")}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">{t("flowDialog.subtitle")}</span>
      </div>

      {presets.length ? (
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
          {t("flowDialog.preset")}
          <select
            value={presetName ?? ""}
            className="h-8 rounded-[8px] border border-border bg-canvas px-2 text-[12px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => pickPreset(event.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset.name} value={preset.name}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <button
        className="self-start text-[10.5px] font-semibold text-muted hover:text-accent focus-visible:outline-none"
        aria-expanded={custom}
        onClick={() => setCustom((value) => !value)}
      >
        {custom ? t("flowDialog.rolesManualOpen") : t("flowDialog.rolesManual")}
      </button>
      {custom ? (
        <div className="flex flex-col gap-1.5 rounded-[10px] border border-dashed border-border bg-canvas/50 p-2">
          <RoleEditor label={t("flowDialog.implementer")} role={roles.implementer} onChange={(next) => setRoles((prev) => ({ ...prev, implementer: next }))} />
          <RoleEditor label={t("flowDialog.reviewer")} role={roles.reviewer} onChange={(next) => setRoles((prev) => ({ ...prev, reviewer: next }))} />
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
        {t("flowDialog.spec")}
        <textarea
          value={spec}
          rows={4}
          placeholder={t("flowDialog.specPlaceholder")}
          className="resize-y rounded-[8px] border border-border bg-canvas px-2 py-1.5 text-[11.5px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onChange={(event) => setSpec(event.target.value)}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
          {t("flowDialog.diffBase")}
          <select
            value={baseMode}
            className="h-8 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setBaseMode(event.target.value as "head" | "merge-base")}
          >
            <option value="head">{t("flowDialog.fromHead")}</option>
            <option value="merge-base">{t("flowDialog.fromMergeBase")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
          {t("flowDialog.reviewer")}
          <select
            value={reviewerMode}
            className="h-8 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setReviewerMode(event.target.value as "headless" | "pane")}
          >
            <option value="headless">{t("flowDialog.headless")}</option>
            <option value="pane">{t("flowDialog.tmuxPane")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
          {t("flowDialog.transitions")}
          <select
            value={mode}
            className="h-8 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setMode(event.target.value as "auto" | "manual")}
          >
            <option value="auto">{t("flowDialog.auto")}</option>
            <option value="manual">{t("flowDialog.manual")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-muted">
          {t("flowDialog.roundLimit")}
          <input
            type="number"
            min={1}
            max={20}
            value={roundLimit}
            className="h-8 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] font-normal text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onChange={(event) => setRoundLimit(Math.max(1, Math.min(20, Number(event.target.value) || 5)))}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        {error ? <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-danger">{error}</span> : <span className="flex-1" />}
        <button
          className="rounded-[8px] border border-border bg-canvas px-2.5 py-1.5 text-[11.5px] font-semibold text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={onClose}
        >
          {t("common.cancel")}
        </button>
        <button
          className="rounded-[8px] border border-accent bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
          disabled={busy}
          onClick={() => void create()}
        >
          {busy ? t("flowDialog.creating") : t("flowDialog.start")}
        </button>
      </div>
    </div>
  );
}
