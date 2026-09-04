"use client";

import { useEffect, useState } from "react";

import { ReasoningControls, type SpeedChoice } from "@/components/ReasoningControls";
import { Select } from "@/components/ui/Select";
import { engineTintOf } from "@/components/utils";
import { effortScale } from "@/lib/agent/efforts";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";

/**
 * THE shared «which agent am I launching» control set (PRD #976 slice A).
 *
 * Engine, model, reasoning effort, codex speed and stored account were the
 * board draft pane's private state; the orchestrator panel (#977), its rotate
 * flow (#978) and the mobile create sheet (#979) all offer the operator the
 * exact same choices, so the choices live here — once — and every surface
 * mounts this module instead of growing a lookalike.
 *
 * The API is deliberately split so a host can bring its own layout:
 *
 *  - {@link useAgentLaunchDraft} owns the STATE and the invariants that tie the
 *    fields together (switching engines re-defaults the model, drops an account
 *    id that belongs to the other engine's catalog, and drops a tier the new
 *    engine does not have). It renders nothing.
 *  - {@link AgentLaunchControls} is one LAYOUT of those fields; a host that
 *    wants a different arrangement composes {@link EngineRadioGroup},
 *    {@link LaunchAccountSelect} and `ReasoningControls` itself from the same
 *    draft object.
 *
 * Persistence is injected ({@link LaunchDraftStorage}), so the board draft keeps
 * its per-draft sessionStorage keys and a transient surface keeps nothing.
 */

export type LaunchEngine = "claude" | "codex";
export type { SpeedChoice };

/** Secret-free slice of one stored account that a launch selector needs. */
export interface LaunchAccountOption {
  id: string;
  label: string;
  authPresent: boolean;
}

export type LaunchAccountCatalog = Record<LaunchEngine, { active: string; accounts: LaunchAccountOption[] }>;

const ENGINES: { key: LaunchEngine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

/** Crash-safe read of one engine section of `/api/accounts`: a malformed body
    yields an empty section, which simply hides that engine's selector. */
export function launchAccountSection(raw: unknown): LaunchAccountCatalog[LaunchEngine] {
  const section = raw as { active?: unknown; accounts?: unknown } | null;
  const accounts = Array.isArray(section?.accounts)
    ? section.accounts.flatMap((entry): LaunchAccountOption[] => {
        const account = entry as { id?: unknown; label?: unknown; authPresent?: unknown };
        return typeof account.id === "string" && typeof account.label === "string"
          ? [{ id: account.id, label: account.label, authPresent: account.authPresent !== false }]
          : [];
      })
    : [];
  return { active: typeof section?.active === "string" ? section.active : "", accounts };
}

/** Both engine sections of one `/api/accounts` body. */
export function launchAccountCatalogOf(body: unknown): LaunchAccountCatalog {
  const raw = body as { claude?: unknown; codex?: unknown } | null;
  return { claude: launchAccountSection(raw?.claude), codex: launchAccountSection(raw?.codex) };
}

/**
 * The account a launch will actually run on (issue #40): a stored id from the
 * other engine's catalog — or from an account that has been removed — falls back
 * to the engine's active account, so the value shown is always the value sent.
 */
export function resolveLaunchAccountId(
  catalog: LaunchAccountCatalog | null,
  engine: LaunchEngine,
  accountId: string,
): string {
  const section = catalog?.[engine] ?? null;
  if (!section) return "";
  return section.accounts.some((account) => account.id === accountId) ? accountId : section.active;
}

/** The stored-account catalog for both engines; null until `/api/accounts`
    answers, and null forever if it never does (the selector simply stays out
    of the way, exactly as the board draft has always behaved). */
export function useLaunchAccountCatalog(): LaunchAccountCatalog | null {
  const [catalog, setCatalog] = useState<LaunchAccountCatalog | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/accounts")
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        setCatalog(launchAccountCatalogOf(await res.json()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

/** Where a host keeps the draft between mounts. Absent: memory only. */
export interface LaunchDraftStorage {
  read(name: string): string;
  write(name: string, value: string): void;
}

export interface AgentLaunchDraft {
  engine: LaunchEngine;
  model: string;
  effort: string;
  speed: SpeedChoice;
  /** The operator's explicit pick, "" while they have made none. */
  accountId: string;
  /** The id a launch would actually carry — see {@link resolveLaunchAccountId}. */
  launchAccountId: string;
  catalog: LaunchAccountCatalog | null;
  accounts: LaunchAccountOption[];
  activeAccountId: string;
  setEngine(engine: LaunchEngine): void;
  setModel(model: string): void;
  setEffort(effort: string): void;
  setSpeed(speed: SpeedChoice): void;
  setAccountId(accountId: string): void;
}

/**
 * The draft's launch parameters, with their invariants. Switching engines is
 * the one compound move: the account id belongs to ONE engine's catalog, the
 * model default differs, and the tier lists differ (claude has «max», codex
 * does not), so a carried-over invalid tier falls back to the CLI default.
 */
export function useAgentLaunchDraft(options: {
  storage?: LaunchDraftStorage;
  /** Engine to start on when storage holds none. */
  initialEngine?: LaunchEngine;
  /** Model/tier to start on when storage holds none — a surface with a canonical
      configuration (the orchestrator's own spawn config) opens on it instead of
      the engine's generic default. Switching engines re-defaults the model, as
      everywhere else: a model belongs to one engine. */
  initialModel?: string;
  initialEffort?: string;
  catalog?: LaunchAccountCatalog | null;
  /** Fires with the NEW engine before the state moves, for hosts that
      renegotiate engine-scoped capabilities (the board draft's image
      negotiation). */
  onEngineChange?: (engine: LaunchEngine) => void;
} = {}): AgentLaunchDraft {
  const { storage, onEngineChange } = options;
  const read = (name: string) => storage?.read(name) ?? "";
  const write = (name: string, value: string) => storage?.write(name, value);
  const fetched = useLaunchAccountCatalog();
  const catalog = options.catalog !== undefined ? options.catalog : fetched;

  const [engine, setEngineState] = useState<LaunchEngine>(() => {
    const stored = read("engine");
    if (stored === "codex" || stored === "claude") return stored;
    return options.initialEngine ?? "claude";
  });
  const [model, setModelState] = useState(() => read("model") || options.initialModel || defaultModelFor(engine));
  const [effort, setEffortState] = useState(() => read("effort") || options.initialEffort || "");
  const [speed, setSpeedState] = useState<SpeedChoice>(() => {
    const stored = read("speed");
    return stored === "fast" || stored === "standard" ? stored : "";
  });
  const [accountId, setAccountIdState] = useState(() => read("accountId"));

  const setModel = (value: string) => {
    setModelState(value);
    write("model", value);
  };
  const setEffort = (value: string) => {
    setEffortState(value);
    write("effort", value);
  };
  const setSpeed = (value: SpeedChoice) => {
    setSpeedState(value);
    write("speed", value);
  };
  const setAccountId = (value: string) => {
    setAccountIdState(value);
    write("accountId", value);
  };
  const setEngine = (value: LaunchEngine) => {
    onEngineChange?.(value);
    setEngineState(value);
    write("engine", value);
    /* An account id belongs to one engine's catalog; flipping engines drops the
       explicit choice so the new engine launches on its own active account. */
    setAccountId("");
    setModel(defaultModelFor(value));
    if (effort && !effortScale(value, defaultModelFor(value))!.includes(effort)) setEffort("");
  };

  const section = catalog?.[engine] ?? null;
  return {
    engine,
    model,
    effort,
    speed,
    accountId,
    launchAccountId: resolveLaunchAccountId(catalog, engine, accountId),
    catalog,
    accounts: section?.accounts ?? [],
    activeAccountId: section?.active ?? "",
    setEngine,
    setModel,
    setEffort,
    setSpeed,
    setAccountId,
  };
}

/**
 * The engine picker chips every draft-style window shares — the agent draft
 * pane, the pipeline stage placeholders and the orchestrator panel render the
 * exact same control (issue #196: one window recipe, no lookalikes).
 */
export function EngineRadioGroup({
  engine,
  disabled,
  roomy,
  onChange,
}: {
  engine: LaunchEngine;
  disabled?: boolean;
  /** The 32px control step for surfaces that give the draft its own column. */
  roomy?: boolean;
  onChange: (engine: LaunchEngine) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label={t("draft.engineAria")}>
      {ENGINES.map(({ key, label }) => {
        const active = engine === key;
        const chip = engineTintOf(key);
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(key)}
            style={active ? { backgroundColor: "var(--color-card)", color: chip.color, borderColor: chip.color } : undefined}
            className={`rounded-full border font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
              roomy ? "px-3 py-1 text-ui" : "px-2 py-0.5 text-[10.5px]"
            } ${active ? "" : "border-transparent bg-transparent text-muted hover:text-primary"}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The stored-account picker (issue #40). Renders nothing while the engine has
 * no catalog: the launch then runs on whatever the CLI's own active profile is,
 * which is what every surface did before accounts existed.
 */
export function LaunchAccountSelect({
  draft,
  disabled,
  roomy,
  className,
}: {
  draft: AgentLaunchDraft;
  disabled?: boolean;
  roomy?: boolean;
  className?: string;
}) {
  const { t } = useLocale();
  if (!draft.accounts.length) return null;
  return (
    <Select
      value={draft.launchAccountId}
      disabled={disabled}
      roomy={roomy}
      className={className}
      onChange={(event) => draft.setAccountId(event.target.value)}
      aria-label={t("draft.accountAria", { engine: draft.engine === "codex" ? "Codex" : "Claude" })}
    >
      {draft.accounts.map((account) => (
        /* The engine's active account is the default for future launches; a
           signed-out profile stays listed (history preserved) but can't be
           picked until it signs back in via Accounts. */
        <option key={account.id} value={account.id} disabled={!account.authPresent}>
          {account.id === draft.activeAccountId
            ? t("draft.accountDefault", { label: account.label })
            : account.authPresent
              ? account.label
              : t("draft.accountNeedsLogin", { label: account.label })}
        </option>
      ))}
    </Select>
  );
}

/**
 * One layout of the whole set: engine chips, account, model, effort, speed.
 * `stacked` gives each control a label above it — the shape a full-height dock
 * column wants; the default packs them into one wrapping strip, the shape a
 * dense board card wants.
 */
export function AgentLaunchControls({
  draft,
  disabled,
  stacked,
}: {
  draft: AgentLaunchDraft;
  disabled?: boolean;
  stacked?: boolean;
}) {
  const { t } = useLocale();
  if (!stacked) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <EngineRadioGroup engine={draft.engine} disabled={disabled} onChange={draft.setEngine} />
        <LaunchAccountSelect draft={draft} disabled={disabled} />
        <ReasoningControls
          engine={draft.engine}
          model={draft.model}
          effort={draft.effort}
          speed={draft.speed}
          disabled={disabled}
          onModel={draft.setModel}
          onEffort={draft.setEffort}
          onSpeed={draft.setSpeed}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      <Field label={t("draft.engineAria")}>
        <EngineRadioGroup engine={draft.engine} disabled={disabled} roomy onChange={draft.setEngine} />
      </Field>
      {draft.accounts.length ? (
        <Field label={t("launch.account")}>
          <LaunchAccountSelect draft={draft} disabled={disabled} roomy className="w-full" />
        </Field>
      ) : null}
      <Field label={t("launch.reasoning")}>
        <div className="flex flex-wrap items-center gap-2 [&>select]:min-w-28 [&>select]:flex-1">
          <ReasoningControls
            engine={draft.engine}
            model={draft.model}
            effort={draft.effort}
            speed={draft.speed}
            disabled={disabled}
            roomy
            onModel={draft.setModel}
            onEffort={draft.setEffort}
            onSpeed={draft.setSpeed}
          />
        </div>
      </Field>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="text-label font-semibold text-muted">{label}</span>
      {children}
    </div>
  );
}
