"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Zap } from "@/components/icons";
import { useIsMobile } from "@/hooks/useIsMobile";
import { conversationIdentity } from "@/lib/accounts/identity";
import { effortScale } from "@/lib/agent/efforts";
import { ENGINE_MODELS, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { RuntimeSettingsCapability } from "@/lib/runtime/contracts";
import type { FileEntry } from "@/lib/types";

import type { StripSurface } from "./agentCapabilities";
import type { RuntimeSession } from "./runtime/runtimeModel";
import { pushTaskToast } from "./tasks/taskToast";
import {
  adoptRuntimeProfile,
  defaults,
  effectiveProfile,
  phaseKey,
  readDraft,
  readResumeDraft,
  storageKey,
  writeProfile,
  writeResumeProfile,
  type RuntimeDraft,
} from "./runtimeProfile";

/** The three conversation surfaces the pill mounts on; every other surface hides
    the runtime control (capability matrix), so the pill never reaches them. */
type PillSurface = "structured" | "resume" | "live-root";

type ApplyState = "idle" | "saving" | "pending" | "confirming" | "applied" | "error";

const REASONING_TIER_KEYS: Record<string, MessageKey> = {
  minimal: "reasoningTier.minimal",
  low: "reasoningTier.low",
  medium: "reasoningTier.medium",
  high: "reasoningTier.high",
  xhigh: "reasoningTier.xhigh",
  max: "reasoningTier.max",
  ultra: "reasoningTier.ultra",
};

/** Standalone menu label for a reasoning tier (Light/Medium/…); falls back to
    the raw CLI token for an unknown tier so it stays visible. */
export function reasoningTierLabel(t: TFunction, tier: string): string {
  const key = REASONING_TIER_KEYS[tier];
  return key ? t(key) : tier;
}

function modelShortLabel(engine: "claude" | "codex", modelId: string): string {
  return ENGINE_MODELS[engine].find((m) => m.id === modelId)?.shortLabel ?? modelId;
}

function modelLabel(engine: "claude" | "codex", modelId: string): string {
  return ENGINE_MODELS[engine].find((m) => m.id === modelId)?.label ?? modelId;
}

/**
 * The compact model/reasoning pill in the composer's quiet bottom row (issue
 * #390). One face — `⚡ 5.6-Sol · Light ▾` — opens a Codex-desktop-style popover
 * (desktop) or a stacked bottom sheet (390px). Every selection auto-applies:
 * structured persists the per-conversation profile that rides the next send,
 * resume persists the on-resume profile, and live-tmux drives the existing
 * reconfigure lifecycle. There is no Apply, no draft-pending dot, and no Full
 * access control anywhere.
 */
export function RuntimePill({
  file,
  surface,
  runtimeSettings,
  runtimeSession,
}: {
  file: FileEntry;
  /** The strip surface for this conversation; the pill renders on exactly the
      three that keep the runtime control visible. */
  surface: StripSurface;
  /** The structured host's negotiated per-turn capability. Launch-level
      changes use durable turn-boundary reconfiguration. */
  runtimeSettings?: RuntimeSettingsCapability | null;
  runtimeSession?: RuntimeSession | null;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const engine = file.engine === "claude" || file.engine === "codex" ? file.engine : null;
  const pillSurface: PillSurface | null =
    surface === "structured" ? "structured"
    : surface === "resume" ? "resume"
    : surface === "live-root" ? "live-root"
    : null;

  // ---- durable reconfigure lifecycle (live tmux and structured hosts) --------
  // The initializer must not synthesize defaults for an engine outside the
  // catalog — the component renders null for those below, after the hooks.
  const [liveDraft, setLiveDraft] = useState<RuntimeDraft>(() =>
    engine ? defaults(file) : { model: "", effort: "", fast: false });
  const [applyState, setApplyState] = useState<ApplyState>("idle");
  const [error, setError] = useState("");
  const revisionRef = useRef(0);
  const operationRef = useRef<string | null>(null);

  // ---- persisted-profile face (structured / resume) -------------------------
  // Bumped on every commit to re-read the identity-scoped profile so the pill,
  // the popover checks and the sheet checks read one source of truth.
  const [version, setVersion] = useState(0);

  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"root" | "model" | "speed">("root");
  const [announce, setAnnounce] = useState("");
  const pillRef = useRef<HTMLButtonElement>(null);

  const cardId = conversationIdentity(file);

  /* eslint-disable react-hooks/set-state-in-effect -- reloading the persisted
     draft/phase from localStorage when the conversation identity changes is a
     sync-from-external-store, same pattern as the composer's draft reload. */
  useEffect(() => {
    if (!engine) return;
    if (pillSurface !== "live-root" && pillSurface !== "structured") return;
    const stored = readDraft(file);
    setLiveDraft(stored);
    const phase = localStorage.getItem(phaseKey(file));
    setApplyState(phase === "pending" || phase === "confirming" ? phase : "idle");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, file.path, pillSurface]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!engine) return;
    if (pillSurface !== "live-root" && pillSurface !== "structured") return;
    localStorage.setItem(storageKey(file), JSON.stringify(liveDraft));
  }, [engine, liveDraft, file, pillSurface]);

  // A poll can adopt a provisional identity to the canonical one while mounted;
  // carry the persisted selection along so it is never silently orphaned.
  const identityRef = useRef(cardId);
  const runtimeConversationId = runtimeSession?.conversationId;
  useEffect(() => {
    if (identityRef.current !== cardId) {
      adoptRuntimeProfile(identityRef.current, cardId);
      identityRef.current = cardId;
      setVersion((v) => v + 1);
    }
  }, [cardId]);

  const applyReconfigure = useCallback(async (draft: RuntimeDraft) => {
    const revision = revisionRef.current;
    setApplyState("saving");
    setError("");
    try {
      const response = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reconfigure",
          path: file.path,
          conversationId: runtimeConversationId,
          ...draft,
          fast: engine === "codex" ? draft.fast : undefined,
        }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        outcome?: string;
        operationId?: string;
        receipt?: { operationId: string; status: string };
        error?: string;
      };
      if (revision !== revisionRef.current) return;
      if (!response.ok || !body.ok) throw new Error(body.error ?? t("runtimeConfig.failed"));
      operationRef.current = body.operationId ?? body.receipt?.operationId ?? null;
      const phase = pillSurface === "structured" || body.outcome === "pending" ? "pending" : "confirming";
      localStorage.setItem(phaseKey(file), phase);
      setApplyState(phase);
    } catch (cause) {
      if (revision !== revisionRef.current) return;
      setError(cause instanceof Error ? cause.message : t("runtimeConfig.failed"));
      setApplyState("error");
    }
  }, [engine, file, pillSurface, runtimeConversationId, t]);

  // Pending re-apply loop and confirm-by-observation, ported from the retired
  // AgentRuntimeControls lifecycle (the trigger is now a selection, not Apply).
  useEffect(() => {
    if (pillSurface !== "live-root" || applyState !== "pending") return;
    const id = window.setInterval(() => void applyReconfigure(liveDraft), 1500);
    return () => window.clearInterval(id);
  }, [pillSurface, applyState, applyReconfigure, liveDraft]);

  useEffect(() => {
    if (pillSurface !== "structured") return;
    const operationId = operationRef.current;
    if (!operationId) return;
    const receipt = runtimeSession?.recentReceipts.find((candidate) =>
      candidate.operationId === operationId && candidate.kind === "reconfigure");
    if (!receipt) return;
    if (receipt.status === "applied") {
      operationRef.current = null;
      setApplyState("applied");
      pushTaskToast("ok", t("runtimeConfig.applied"));
    } else if (receipt.status === "failed" || receipt.status === "rejected") {
      operationRef.current = null;
      setApplyState("error");
      setError(receipt.reason ?? t("runtimeConfig.failed"));
      pushTaskToast("err", receipt.reason ?? t("runtimeConfig.failed"));
    }
  }, [pillSurface, runtimeSession, t]);

  /* eslint-disable react-hooks/set-state-in-effect -- confirm-by-observation:
     the poll updates `file`, and matching observed runtime settles the phase
     (ported verbatim from the retired AgentRuntimeControls lifecycle). */
  useEffect(() => {
    if (pillSurface !== "live-root" || applyState !== "confirming") return;
    const observedModel = engine === "claude" ? normalizeClaudeLaunchModel(file.launchModel ?? file.model) : file.model;
    const modelMatches = observedModel === liveDraft.model;
    const effortMatches = file.effort === liveDraft.effort;
    const speedMatches = engine === "claude" || file.fast === liveDraft.fast;
    if (!modelMatches || !effortMatches || !speedMatches) return;
    localStorage.removeItem(phaseKey(file));
    setApplyState("applied");
  }, [applyState, engine, file, liveDraft, pillSurface]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const applying = applyState === "saving"
    || applyState === "pending"
    || applyState === "confirming"
    || Boolean(pillSurface === "structured" && runtimeSession?.pendingReconfigure);

  // ---- the effective face (single source of truth) --------------------------
  const face: RuntimeDraft = useMemo(() => {
    if (!engine) return { model: "", effort: "", fast: false };
    // A failed live reconfigure reverts the face to the observed runtime (§6) —
    // the pill never keeps advertising a draft the pane rejected.
    if (pillSurface === "live-root" || pillSurface === "structured") return applyState === "error" ? defaults(file) : liveDraft;
    if (pillSurface === "resume") return readResumeDraft(file);
    return effectiveProfile(file);
    // version re-reads the persisted profile after a commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, pillSurface, applyState, liveDraft, file, version]);

  const efforts = useMemo(() => (engine ? effortScale(engine, face.model) ?? [] : []), [engine, face.model]);
  const speedShown = engine === "codex";

  // Structured reconfigure restarts at an idle boundary, so every launch-level
  // setting remains available while a turn is running. Per-turn capabilities
  // still describe message-scoped overrides elsewhere in the composer.
  void runtimeSettings;
  const effortLocked = false;
  const modelLocked = false;
  const speedLocked = false;
  const lockReason = t("composer.settingsNextResume");

  const announceCommit = useCallback((next: RuntimeDraft) => {
    setAnnounce(t("composer.nextMessageUses", {
      model: engine ? modelLabel(engine, next.model) : next.model,
      effort: reasoningTierLabel(t, next.effort),
    }));
  }, [engine, t]);

  const commit = useCallback((patch: Partial<RuntimeDraft>) => {
    if (!engine) return;
    if (pillSurface === "live-root" || pillSurface === "structured") {
      revisionRef.current += 1;
      localStorage.removeItem(phaseKey(file));
      setLiveDraft((current) => {
        const scale = patch.model ? effortScale(engine, patch.model) ?? [] : effortScale(engine, current.model) ?? [];
        const next: RuntimeDraft = {
          ...current,
          ...patch,
          effort: patch.effort ?? (scale.includes(current.effort) ? current.effort : scale[0] ?? current.effort),
        };
        announceCommit(next);
        if (pillSurface === "structured") writeProfile(file, patch);
        void applyReconfigure(next);
        return next;
      });
      return;
    }
    // Resume keeps a client-side profile that the next host launch consumes.
    if (pillSurface === "resume") {
      announceCommit(writeResumeProfile(file, patch));
    } else {
      writeProfile(file, patch);
      announceCommit(effectiveProfile(file));
    }
    setVersion((v) => v + 1);
  }, [engine, pillSurface, file, announceCommit, applyReconfigure]);

  const closePopover = useCallback(() => {
    setOpen(false);
    setPanel("root");
    pillRef.current?.focus();
  }, []);

  const selectEffort = (tier: string) => {
    if (effortLocked) return;
    commit({ effort: tier });
    if (!isMobile) closePopover();
  };
  const selectModel = (id: string) => {
    if (modelLocked) return;
    commit({ model: id });
    if (!isMobile) closePopover();
  };
  const selectFast = (fast: boolean) => {
    if (speedLocked) return;
    commit({ fast });
    if (!isMobile) closePopover();
  };

  if (!engine || !pillSurface) return null;

  const faceModelShort = modelShortLabel(engine, face.model);
  const faceTier = reasoningTierLabel(t, face.effort);
  const faceLabel = `${t("composer.runtimePill")} — ${modelLabel(engine, face.model)}, ${faceTier}`;

  return (
    <span className="relative inline-flex" onPointerDown={(event) => event.stopPropagation()}>
      <button
        ref={pillRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={applying || undefined}
        aria-label={faceLabel}
        data-runtime-pill
        onClick={() => (open ? closePopover() : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-control px-1.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 motion-reduce:transition-none ${
          isMobile ? "relative min-h-11 before:absolute before:-inset-x-1 before:-inset-y-2 before:content-['']" : ""
        } ${
          applyState === "error" ? "text-danger" : "text-secondary hover:bg-sunken hover:text-primary"
        } ${open ? "bg-sunken text-primary" : ""}`}
      >
        <Zap className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
        <span className="max-w-[52vw] truncate md:max-w-[16rem]">
          {faceModelShort} · {faceTier}
        </span>
        {applying ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        )}
      </button>
      {applying ? (
        <span className="ml-1 self-center text-[10px] font-semibold text-accent" data-runtime-switch-pending>
          {t("runtimeConfig.pending")}
        </span>
      ) : null}

      {open && !isMobile ? (
        <RuntimePopover
          t={t}
          engine={engine}
          face={face}
          efforts={efforts}
          speedShown={speedShown}
          panel={panel}
          setPanel={setPanel}
          effortLocked={effortLocked}
          modelLocked={modelLocked}
          speedLocked={speedLocked}
          lockReason={lockReason}
          onSelectEffort={selectEffort}
          onSelectModel={selectModel}
          onSelectFast={selectFast}
          onClose={closePopover}
        />
      ) : null}

      {open && isMobile ? (
        <RuntimeSheet
          t={t}
          engine={engine}
          face={face}
          efforts={efforts}
          speedShown={speedShown}
          effortLocked={effortLocked}
          modelLocked={modelLocked}
          speedLocked={speedLocked}
          lockReason={lockReason}
          onSelectEffort={selectEffort}
          onSelectModel={selectModel}
          onSelectFast={selectFast}
          onClose={() => {
            setOpen(false);
            pillRef.current?.focus();
          }}
        />
      ) : null}

      {/* Commit announcements (§9): a polite region every selection updates. */}
      <span className="sr-only" role="status" aria-live="polite" data-runtime-pill-status>
        {announce}
      </span>
      {applyState === "error" && error ? (
        <span className="sr-only" role="status" aria-live="assertive">{error}</span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Desktop popover — a WAI-APG menu with an in-place Model/Speed drill-down.
// ---------------------------------------------------------------------------

interface PanelProps {
  t: TFunction;
  engine: "claude" | "codex";
  face: RuntimeDraft;
  efforts: readonly string[];
  speedShown: boolean;
  effortLocked: boolean;
  modelLocked: boolean;
  speedLocked: boolean;
  lockReason: string;
  onSelectEffort: (tier: string) => void;
  onSelectModel: (id: string) => void;
  onSelectFast: (fast: boolean) => void;
  onClose: () => void;
}

function RuntimePopover({
  t, engine, face, efforts, speedShown, panel, setPanel,
  effortLocked, modelLocked, speedLocked, lockReason,
  onSelectEffort, onSelectModel, onSelectFast, onClose,
}: PanelProps & { panel: "root" | "model" | "speed"; setPanel: (p: "root" | "model" | "speed") => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Rows for the current panel (document order), each with an enabled flag.
  const rows = useMemo(() => buildRows({
    t, engine, face, efforts, speedShown, panel, effortLocked, modelLocked, speedLocked, lockReason,
    onSelectEffort, onSelectModel, onSelectFast, onOpenPanel: setPanel,
  }), [t, engine, face, efforts, speedShown, panel, effortLocked, modelLocked, speedLocked, lockReason,
    onSelectEffort, onSelectModel, onSelectFast, setPanel]);

  const focusableIndexes = useMemo(
    () => rows.map((row, index) => (row.enabled ? index : -1)).filter((index) => index >= 0),
    [rows],
  );

  // On panel change, land focus on the checked row (or the first enabled row).
  /* eslint-disable react-hooks/set-state-in-effect -- roving-tabindex reset on
     panel swap must land together with the imperative focus move. */
  useEffect(() => {
    const checked = rows.findIndex((row) => row.checked && row.enabled);
    const first = checked >= 0 ? checked : focusableIndexes[0] ?? 0;
    setActiveIndex(first);
    rowRefs.current[first]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);

  const moveTo = (index: number) => {
    setActiveIndex(index);
    rowRefs.current[index]?.focus();
  };
  const step = (delta: number) => {
    if (!focusableIndexes.length) return;
    const pos = focusableIndexes.indexOf(activeIndex);
    const nextPos = pos < 0 ? 0 : (pos + delta + focusableIndexes.length) % focusableIndexes.length;
    moveTo(focusableIndexes[nextPos]!);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); step(1); break;
      case "ArrowUp": event.preventDefault(); step(-1); break;
      case "Home": event.preventDefault(); if (focusableIndexes.length) moveTo(focusableIndexes[0]!); break;
      case "End": event.preventDefault(); if (focusableIndexes.length) moveTo(focusableIndexes.at(-1)!); break;
      case "ArrowRight": {
        const row = rows[activeIndex];
        if (row?.submenu) { event.preventDefault(); setPanel(row.submenu); }
        break;
      }
      case "ArrowLeft": if (panel !== "root") { event.preventDefault(); setPanel("root"); } break;
      case "Escape": event.preventDefault(); onClose(); break;
      case "Enter":
      case " ": event.preventDefault(); rows[activeIndex]?.activate(); break;
      // WAI-APG menu: Tab closes and lets focus move on (the handler refocuses
      // the pill, so the un-prevented default advances past it).
      case "Tab": onClose(); break;
      default: break;
    }
  };

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={t("composer.runtimePill")}
      data-runtime-popover
      onKeyDown={onKeyDown}
      className="absolute bottom-[calc(100%+6px)] left-0 z-40 w-[240px] rounded-surface border border-border bg-raised p-1.5 shadow-2 motion-reduce:transition-none"
    >
      {panel === "root" ? (
        <>
          <RowGroup label={t("composer.reasoningGroup")}>
            {rows.filter((row) => row.kind === "tier").map((row) => (
              <MenuRow key={row.key} row={row} active={rows.indexOf(row) === activeIndex} refFor={(el) => { rowRefs.current[rows.indexOf(row)] = el; }} />
            ))}
          </RowGroup>
          <div className="mx-2 my-1 border-t border-border/70" role="separator" />
          {rows.filter((row) => row.kind === "submenu").map((row) => (
            <MenuRow key={row.key} row={row} active={rows.indexOf(row) === activeIndex} refFor={(el) => { rowRefs.current[rows.indexOf(row)] = el; }} />
          ))}
        </>
      ) : (
        <div role="group" aria-label={panel === "model" ? t("composer.modelGroup") : t("composer.speedGroup")}>
          {rows.map((row, index) => (
            <MenuRow key={row.key} row={row} active={index === activeIndex} refFor={(el) => { rowRefs.current[index] = el; }} />
          ))}
        </div>
      )}
    </div>
  );
}

function RowGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      {/* §3.6 sentence-case group label, no uppercase. */}
      <div className="px-2 pb-1 pt-1.5 text-label font-semibold text-secondary">{label}</div>
      <div role="group" aria-label={label}>{children}</div>
    </>
  );
}

interface Row {
  key: string;
  kind: "tier" | "submenu" | "back" | "model" | "speed";
  label: string;
  /** Accessible name when it must differ from the visible label (the back row:
      "Back — Model", so it never collides with the submenu row's name). */
  ariaLabel?: string;
  detail?: string;
  checked: boolean;
  enabled: boolean;
  reason?: string;
  submenu?: "model" | "speed";
  role: "menuitemradio" | "menuitem";
  activate: () => void;
}

function buildRows({
  t, engine, face, efforts, speedShown, panel, effortLocked, modelLocked, speedLocked, lockReason,
  onSelectEffort, onSelectModel, onSelectFast, onOpenPanel,
}: Omit<PanelProps, "onClose"> & {
  panel: "root" | "model" | "speed";
  onOpenPanel: (panel: "root" | "model" | "speed") => void;
}): Row[] {
  const back = (label: string): Row => ({
    key: "back", kind: "back", label, checked: false, enabled: true, role: "menuitem",
    // "Back — Model" / «Назад — Модель»: the visible row shows the panel name
    // (‹ Model), the accessible name says what activating it does (§9).
    ariaLabel: `${t("composer.backTo")} — ${label}`,
    activate: () => onOpenPanel("root"),
  });
  if (panel === "model") {
    return [
      back(t("composer.modelGroup")),
      ...ENGINE_MODELS[engine].map((model): Row => ({
        key: model.id,
        kind: "model",
        label: model.label,
        checked: face.model === model.id,
        enabled: !modelLocked,
        reason: modelLocked ? lockReason : undefined,
        role: "menuitemradio",
        activate: () => onSelectModel(model.id),
      })),
    ];
  }
  if (panel === "speed") {
    return [
      back(t("composer.speedGroup")),
      { key: "standard", kind: "speed", label: t("composer.speedStandard"), checked: !face.fast, enabled: !speedLocked, reason: speedLocked ? lockReason : undefined, role: "menuitemradio", activate: () => onSelectFast(false) },
      { key: "fast", kind: "speed", label: t("composer.speedFastTier"), checked: face.fast, enabled: !speedLocked, reason: speedLocked ? lockReason : undefined, role: "menuitemradio", activate: () => onSelectFast(true) },
    ];
  }
  const tiers = efforts.map((tier): Row => ({
    key: `tier-${tier}`,
    kind: "tier",
    label: reasoningTierLabel(t, tier),
    checked: face.effort === tier,
    enabled: !effortLocked,
    reason: effortLocked ? lockReason : undefined,
    role: "menuitemradio",
    activate: () => onSelectEffort(tier),
  }));
  const submenus: Row[] = [
    {
      key: "model", kind: "submenu", label: t("composer.modelGroup"),
      detail: ENGINE_MODELS[engine].find((m) => m.id === face.model)?.shortLabel ?? face.model,
      checked: false, enabled: true, submenu: "model", role: "menuitem", activate: () => onOpenPanel("model"),
    },
  ];
  if (speedShown) {
    submenus.push({
      key: "speed", kind: "submenu", label: t("composer.speedGroup"),
      detail: face.fast ? t("composer.speedFastTier") : t("composer.speedStandard"),
      checked: false, enabled: true, submenu: "speed", role: "menuitem", activate: () => onOpenPanel("speed"),
    });
  }
  return [...tiers, ...submenus];
}

/** A single popover row; the container wires `activate` and the roving-focus
    ref through props so this stays purely presentational and testable. */
function MenuRow({
  row, active, refFor,
}: {
  row: Row;
  active: boolean;
  refFor: (el: HTMLButtonElement | null) => void;
}) {
  const accessibleName = row.reason ? `${row.label} — ${row.reason}` : row.label;
  if (row.kind === "back") {
    return (
      <button
        ref={refFor}
        type="button"
        role="menuitem"
        tabIndex={active ? 0 : -1}
        aria-label={row.ariaLabel}
        onClick={row.activate}
        data-runtime-row="back"
        className="flex w-full items-center gap-1 rounded-control px-2 py-1.5 text-left text-ui font-semibold text-secondary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        {row.label}
      </button>
    );
  }
  const isSubmenu = row.kind === "submenu";
  return (
    <button
      ref={refFor}
      type="button"
      role={row.role}
      aria-checked={row.role === "menuitemradio" ? row.checked : undefined}
      aria-haspopup={isSubmenu ? "menu" : undefined}
      aria-disabled={!row.enabled || undefined}
      disabled={!row.enabled}
      tabIndex={active ? 0 : -1}
      aria-label={row.reason ? accessibleName : undefined}
      title={row.reason}
      onClick={row.activate}
      data-runtime-row={row.kind}
      data-runtime-value={row.key}
      className={`flex min-h-[28px] w-full items-center gap-2 rounded-control px-2 py-1 text-left text-ui hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 ${
        row.checked ? "text-primary" : "text-secondary"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.detail ? <span className="shrink-0 text-caption text-muted">{row.detail}</span> : null}
      {row.checked ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden /> : null}
      {isSubmenu ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden /> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile bottom sheet — stacked radio sections, no submenu, stays open on select.
// ---------------------------------------------------------------------------

function RuntimeSheet({
  t, engine, face, efforts, speedShown,
  effortLocked, modelLocked, speedLocked, lockReason,
  onSelectEffort, onSelectModel, onSelectFast, onClose,
}: PanelProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheetRef.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("composer.runtimePill")}
        tabIndex={-1}
        data-runtime-sheet
        className="max-h-[80vh] w-full max-w-[440px] overflow-y-auto rounded-t-[16px] bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2 focus-visible:outline-none"
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border" aria-hidden />

        <SheetSection label={t("composer.reasoningGroup")}>
          {efforts.map((tier) => (
            <SheetRow
              key={tier}
              label={reasoningTierLabel(t, tier)}
              checked={face.effort === tier}
              disabled={effortLocked}
              reason={effortLocked ? lockReason : undefined}
              onSelect={() => onSelectEffort(tier)}
            />
          ))}
        </SheetSection>

        <SheetSection label={t("composer.modelGroup")}>
          {ENGINE_MODELS[engine].map((model) => (
            <SheetRow
              key={model.id}
              label={model.label}
              checked={face.model === model.id}
              disabled={modelLocked}
              reason={modelLocked ? lockReason : undefined}
              onSelect={() => onSelectModel(model.id)}
            />
          ))}
        </SheetSection>

        {speedShown ? (
          <SheetSection label={t("composer.speedGroup")}>
            <SheetRow label={t("composer.speedStandard")} checked={!face.fast} disabled={speedLocked} reason={speedLocked ? lockReason : undefined} onSelect={() => onSelectFast(false)} />
            <SheetRow label={t("composer.speedFastTier")} checked={face.fast} disabled={speedLocked} reason={speedLocked ? lockReason : undefined} onSelect={() => onSelectFast(true)} />
          </SheetSection>
        ) : null}
      </div>
    </div>
  );
}

function SheetSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2" role="radiogroup" aria-label={label}>
      <div className="mb-1 px-1 text-label font-semibold text-secondary">{label}</div>
      {children}
    </div>
  );
}

function SheetRow({
  label, checked, disabled = false, reason, onSelect,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      aria-label={reason ? `${label} — ${reason}` : undefined}
      title={reason}
      onClick={onSelect}
      data-runtime-sheet-row
      className={`flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-left text-body hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
        checked ? "text-primary" : "text-secondary"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden /> : null}
    </button>
  );
}
