"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { roleDescription, roleName, roleParamDescription, roleParamLabel, roleParamOptionLabel } from "@/components/builderCopy";
import {
  EngineRadioGroup,
  LaunchAccountSelect,
  useAgentLaunchDraft,
} from "@/components/draft/AgentLaunchControls";
import { Play, X } from "@/components/icons";
import { Select } from "@/components/ui/Select";
import { useComposer } from "@/hooks/useComposer";
import { seedLaunchOutbox } from "@/components/conversation/outbox";
import { playCue } from "@/lib/audio/app";
import { codexModelSupportsImages } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { STREAM_RECONNECTED_EVENT } from "@/hooks/runtimeBus";
import { applySpawnedConversationSnapshot } from "@/hooks/useFiles";
import { BUILDER_APPLY_FIXES_CONFIG, BUILDER_FRONTEND_CONFIG } from "@/lib/roles/paramConfig";
import { defaultRoleParameterValues } from "@/lib/roles/parameters";
import type { RoleDefinition } from "@/lib/roles/types";
import type { FileEntry } from "@/lib/types";
import { conversationIdentity, withoutArchivedPredecessors } from "@/lib/accounts/identity";
import type { RuntimeImageCapability } from "@/lib/runtime/structuredContent";

import { ComposerBar } from "./ComposerBar";
import { DirectoryPicker } from "./DirectoryPicker";
import { DraftLaunchStatus } from "./DraftLaunchStatus";
import {
  CONFIRM_ATTENTION_MS,
  SLOW_BOOT_MS,
  type SpawnAttempt,
  type SpawnResponseBody,
  admittedSpawn,
  applySpawnOutcome,
  applySpawnFailure,
  classifySpawnResponse,
  classifyTransportLoss,
  createSpawnAttempt,
  draftSpawnTitle,
  displayPhase,
  hasRecoverableRequest,
  matchSpawnedFile,
  provisionalSpawnFile,
  spawnRequestBody,
  upgradeLegacySpawnAttempt,
} from "./draftSpawn";
import { ReasoningControls } from "./ReasoningControls";
import { cleanTitle, engineTintOf } from "./utils";
import { draftWorkingDirectory } from "./projectModel";

type Engine = "claude" | "codex";

/* Engine/model/effort/account state and the engine chips are SHARED with the
   orchestrator panel and the mobile create sheet (PRD #976 slice A) — they live
   in `@/components/draft/AgentLaunchControls` now. Re-exported here because the
   pipeline stage placeholder has always imported the chips from this module. */
export { EngineRadioGroup };

const STRUCTURED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type SpawnImageNegotiation = {
  spawnTransport: "tmux" | "structured";
  imageInput: Record<Engine, RuntimeImageCapability>;
};
type SpawnImageNegotiationState =
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; value: SpawnImageNegotiation }
  | { status: "error"; requestKey: string };

function runtimeImageCapabilityValue(value: unknown): RuntimeImageCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.supported !== "boolean") return null;
  if (candidate.reason !== null && typeof candidate.reason !== "string") return null;
  if (!Array.isArray(candidate.formats) || candidate.formats.length === 0
    || candidate.formats.some((format) => typeof format !== "string" || !STRUCTURED_IMAGE_MIMES.has(format))) return null;
  if (!Number.isSafeInteger(candidate.maxImages) || Number(candidate.maxImages) <= 0
    || !Number.isSafeInteger(candidate.maxRawBytesPerImage) || Number(candidate.maxRawBytesPerImage) <= 0
    || !Number.isSafeInteger(candidate.maxEncodedBytesPerRequest) || Number(candidate.maxEncodedBytesPerRequest) <= 0) return null;
  return candidate as unknown as RuntimeImageCapability;
}

function spawnImageNegotiationValue(value: unknown): SpawnImageNegotiation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.spawnTransport !== "tmux" && candidate.spawnTransport !== "structured") return null;
  if (!candidate.imageInput || typeof candidate.imageInput !== "object" || Array.isArray(candidate.imageInput)) return null;
  const imageInput = candidate.imageInput as Record<string, unknown>;
  const claude = runtimeImageCapabilityValue(imageInput.claude);
  const codex = runtimeImageCapabilityValue(imageInput.codex);
  if (!claude || !codex) return null;
  return { spawnTransport: candidate.spawnTransport, imageInput: { claude, codex } };
}

const field = (id: string, name: string) => `llvDraftPane:${id}:${name}`;

export type RoleCatalogItem = RoleDefinition & { promptPreview: string };

/* One /api/roles fetch per session, shared by every draft pane and stage
   placeholder — a draft pipeline mounts one placeholder per stage, and each
   used to fire its own catalog request on mount (issue #221 §3 mount cost). */
let roleCatalogCache: RoleCatalogItem[] | null = null;
let roleCatalogRequest: Promise<RoleCatalogItem[] | null> | null = null;

function fetchRoleCatalog(): Promise<RoleCatalogItem[] | null> {
  roleCatalogRequest ??= fetch("/api/roles")
    .then(async (res) => {
      if (!res.ok) return null;
      const body = await res.json() as { roles?: RoleCatalogItem[] };
      return Array.isArray(body.roles) ? body.roles : null;
    })
    .catch(() => null)
    .then((roles) => {
      if (roles) roleCatalogCache = roles;
      else roleCatalogRequest = null; /* transient failure: allow a retry */
      return roles;
    });
  return roleCatalogRequest;
}

/** The shared /api/roles catalog (agent drafts + stage placeholders),
    session-cached: later mounts render the catalog synchronously. */
export function useRoleCatalog(): RoleCatalogItem[] {
  const [roles, setRoles] = useState<RoleCatalogItem[]>(() => roleCatalogCache ?? []);
  useEffect(() => {
    if (roleCatalogCache) return;
    let cancelled = false;
    void fetchRoleCatalog().then((fetched) => {
      if (!cancelled && fetched) setRoles(fetched);
    });
    return () => { cancelled = true; };
  }, []);
  return roles;
}

/**
 * The role block every draft-style window shares: role select, description,
 * typed parameters, and the scaffold + safety-fences preview. `allowedRoleIds`
 * narrows the catalog (a pipeline stage may not use deployer); `children`
 * renders extra fields between the params and the preview (the agent draft's
 * deploy confirm). `compactPreview` caps the scaffold preview's height for
 * fixed-height hosts (stage placeholder windows).
 */
export function RoleSection({
  idPrefix,
  roles,
  roleId,
  roleParams,
  disabled,
  allowedRoleIds,
  compactPreview,
  onSelectRole,
  onSetParam,
  children,
}: {
  idPrefix: string;
  roles: RoleCatalogItem[];
  roleId: string;
  roleParams: Record<string, string | number>;
  disabled?: boolean;
  allowedRoleIds?: ReadonlySet<string>;
  compactPreview?: boolean;
  onSelectRole: (roleId: string) => void;
  onSetParam: (key: string, value: string | number) => void;
  children?: React.ReactNode;
}) {
  const { t } = useLocale();
  const offered = allowedRoleIds ? roles.filter((role) => allowedRoleIds.has(role.id)) : roles;
  const selectedRole = offered.find((role) => role.id === roleId) ?? null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <label className="shrink-0 text-caption font-semibold text-muted" htmlFor={`draft-role-${idPrefix}`}>{t("draft.role")}</label>
        <Select
          id={`draft-role-${idPrefix}`}
          value={roleId}
          disabled={disabled}
          onChange={(event) => onSelectRole(event.target.value)}
          aria-label={t("draft.roleAria")}
          className="flex-1"
        >
          <option value="">{t("draft.noRole")}</option>
          {offered.map((role) => <option key={role.id} value={role.id}>{roleName(t, role)}</option>)}
        </Select>
      </div>
      {selectedRole ? (
        <>
          <p className="text-caption leading-4 text-muted">{roleDescription(t, selectedRole)}</p>
          {selectedRole.parameters.length ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("draft.roleParameters")}>
              {selectedRole.parameters.map((parameter) => {
                const label = roleParamLabel(t, selectedRole.id, parameter);
                return (
                  <label key={parameter.key} className="flex min-w-28 flex-1 flex-col gap-0.5 text-caption text-muted">
                    <span>{label}{parameter.required ? " *" : ""}</span>
                    {parameter.kind === "select" ? (
                      <Select value={String(roleParams[parameter.key] ?? "")} disabled={disabled} onChange={(event) => onSetParam(parameter.key, event.target.value)}>
                        {parameter.options?.map((option) => (
                          <option key={option} value={option}>{roleParamOptionLabel(t, selectedRole.id, parameter.key, option)}</option>
                        ))}
                      </Select>
                    ) : (
                      <input type={parameter.kind === "integer" ? "number" : "text"} min={parameter.kind === "integer" ? parameter.min : undefined} max={parameter.kind === "integer" ? parameter.max : undefined} value={String(roleParams[parameter.key] ?? "")} disabled={disabled} onChange={(event) => onSetParam(parameter.key, parameter.kind === "integer" && event.target.value ? Number(event.target.value) : event.target.value)} aria-label={label} className="h-7 min-w-0 rounded-control border border-border bg-card px-1.5 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60" />
                    )}
                    <span className="leading-3">{roleParamDescription(t, selectedRole.id, parameter)}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {children}
          {/* The full scaffold the agent will receive stays English (it IS the
              prompt) — folded behind a clearly-labeled collapsible so the uk UI
              never shows raw English copy uninvited (issue #221 §1/§5). */}
          <details className="rounded-control border border-border bg-card/60">
            <summary className="min-h-7 cursor-pointer select-none list-item px-2 py-1 text-caption font-semibold text-secondary marker:text-muted hover:text-primary">
              {t("draft.rolePromptToggle")}
            </summary>
            <div className="border-t border-border px-2 py-1.5 text-caption leading-4 text-muted">
              <pre className={`whitespace-pre-wrap font-sans ${compactPreview ? "max-h-24 overflow-y-auto" : ""}`}>{scaffoldPreview(selectedRole.promptPreview, roleParams)}</pre>
              <ul className={`mt-1 list-disc pl-4 ${compactPreview ? "max-h-16 overflow-y-auto" : ""}`} aria-label={t("draft.safetyFences")}>
                {selectedRole.safetyFences.map((fence) => <li key={fence}>{fence}</li>)}
              </ul>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function readField(id: string, name: string): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(field(id, name)) ?? "";
}

function writeField(id: string, name: string, value: string) {
  if (value) sessionStorage.setItem(field(id, name), value);
  else sessionStorage.removeItem(field(id, name));
}

function readRoleParams(id: string): Record<string, string | number> {
  try {
    const value = JSON.parse(readField(id, "roleParams") || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, parameter]) => typeof parameter === "string" || typeof parameter === "number"));
  } catch {
    return {};
  }
}

function scaffoldPreview(scaffold: string, params: Record<string, string | number>): string {
  return scaffold.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_match, key: string) => String(params[key] ?? ""));
}

/** Everything a draft keeps in sessionStorage; called when the draft leaves the scheme. */
export function clearDraftStorage(id: string) {
  for (const name of ["engine", "model", "cwd", "cwdSeed", "text", "boot", "src", "parentConversationId", "effort", "speed", "accountId", "role", "roleParams", "reviews", "confirm"]) sessionStorage.removeItem(field(id, name));
}

/** Source transcript a handoff draft continues; empty for a plain draft. */
export function draftSrc(id: string): string {
  return readField(id, "src");
}

/** Persisted editable directory, used to restore a draft before its pane mounts. */
export function draftCwd(id: string): string {
  return readField(id, "cwd").trim();
}

export function draftParentConversationId(id: string): string {
  return readField(id, "parentConversationId");
}

/** Marks a fresh draft as a handoff of the given transcript, before it mounts. */
export function setDraftSrc(id: string, src: string, parentConversationId?: string) {
  writeField(id, "src", src);
  writeField(id, "parentConversationId", parentConversationId ?? "");
}

/** Seeds a fresh draft's first prompt, before it mounts — the «send a task to
    a brand-new agent» path drops the task text here, launching nothing. */
export function setDraftText(id: string, text: string) {
  writeField(id, "text", text);
}

/** Seeds a draft's editable cwd before its first render, recording it as the
    system's own answer (see {@link draftCwdIsUntouched}). */
export function setDraftCwd(id: string, cwd: string) {
  const next = cwd.trim();
  writeField(id, "cwd", next);
  writeField(id, "cwdSeed", next);
}

/**
 * Whether the draft still holds the directory the system put there — nothing
 * empty, nothing the operator picked. Provenance, not doubt: a better system
 * answer arriving late (the project's canonical root, the source transcript's
 * own cwd) may replace an untouched seed, and must never overwrite a directory
 * the operator chose.
 */
export function draftCwdIsUntouched(id: string): boolean {
  const current = readField(id, "cwd").trim();
  return !current || current === readField(id, "cwdSeed").trim();
}

const DRAFT_CWD_RESOLVED_EVENT = "llv:draft-cwd-resolved";

/** Replaces an untouched seed once better metadata identifies the canonical
    root, and tells a mounted pane to redraw with it. */
export function resolveSystemDraftCwd(id: string, cwd: string): boolean {
  const next = cwd.trim();
  if (!next || !draftCwdIsUntouched(id) || readField(id, "cwd").trim() === next) return false;
  setDraftCwd(id, next);
  window.dispatchEvent(new window.CustomEvent(DRAFT_CWD_RESOLVED_EVENT, { detail: { id, cwd: next } }));
  return true;
}

/** Reads back the durable spawn attempt persisted across reload. Its presence
    means a worker may exist, so the composer stays frozen and send disabled. */
function readAttempt(id: string): SpawnAttempt | null {
  try {
    const raw = JSON.parse(readField(id, "boot") || "null") as SpawnAttempt | null;
  if (!raw || typeof raw.at !== "number" || typeof raw.prompt !== "string" || typeof raw.clientAttemptId !== "string") return null;
  if (raw.phase !== "booting" && raw.phase !== "confirming" && raw.phase !== "attention") return null;
  return { ...raw, request: raw.request && typeof raw.request === "object" ? raw.request : null };
  } catch {
    return null;
  }
}

/** A fresh idempotency key for one launch — a converging re-POST replays onto
    the same server receipt and prevents a duplicate worker. Matches the
    route's `^[A-Za-z0-9_-]{8,128}$` gate. */
function newAttemptId(): string {
  const raw = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128).padEnd(8, "0");
}

/**
 * A conversation that does not exist yet, drawn as a full pane on the scheme:
 * engine picker in the header retints the whole card, the directory rides
 * under it, and the composer at the bottom is the same chat input the real
 * panes have. The first message boots the agent in tmux; once its transcript
 * shows up in the scanner the draft hands over to the real node in place.
 */
export function DraftAgentPane({
  draftId,
  project,
  files,
  onClose,
  onSpawned,
}: {
  draftId: string;
  project: string;
  files: FileEntry[];
  onClose: () => void;
  onSpawned: (file: FileEntry) => void;
}) {
  const { t } = useLocale();
  /* A handoff draft carries the transcript it continues; set by the opener
     before the draft lands on the scheme, immutable for the draft's life. */
  const [src] = useState(() => readField(draftId, "src"));
  const [parentConversationId] = useState(() => readField(draftId, "parentConversationId"));
  const srcFile = src ? (files.find((entry) => entry.path === src) ?? null) : null;
  const [initialCwd] = useState(() => readField(draftId, "cwd"));
  /* A handoff draft opens on a locally guessed directory; the spawn route
     answers with the source transcript's own cwd, which replaces the guess as
     long as the operator has not picked a directory of their own. */
  const awaitingInheritedCwdRef = useRef(Boolean(src && draftCwdIsUntouched(draftId)));
  const [cwd, setCwdState] = useState(() => initialCwd || draftWorkingDirectory(files, project, src));
  const roles = useRoleCatalog();
  const [roleId, setRoleIdState] = useState(() => readField(draftId, "role"));
  const [roleParams, setRoleParamsState] = useState(() => readRoleParams(draftId));
  const [reviews, setReviewsState] = useState(() => readField(draftId, "reviews"));
  const [deployConfirm, setDeployConfirmState] = useState(() => readField(draftId, "confirm"));
  const [dirs, setDirs] = useState<string[]>([]);
  /* The stored key is "" before the first negotiation and after an engine flip;
     the derived value below reads any mismatch as «loading», which is exactly
     what a not-yet-negotiated engine is. */
  const [storedSpawnImageNegotiation, setSpawnImageNegotiation] = useState<SpawnImageNegotiationState>({
    status: "loading",
    requestKey: "",
  });
  /* Engine, model, effort, codex speed and the stored account are the SHARED
     launch parameters (PRD #976 slice A) — the orchestrator panel offers the
     operator the very same set, so the state and its invariants live in one
     module and this pane keeps only its own persistence. */
  const launch = useAgentLaunchDraft({
    storage: {
      read: (name) => readField(draftId, name),
      write: (name, value) => writeField(draftId, name, value),
    },
    initialEngine: srcFile?.engine === "codex" ? "codex" : "claude",
    onEngineChange: (value) => setSpawnImageNegotiation({ status: "loading", requestKey: `${project}\n${src ?? ""}\n${value}` }),
  });
  const { engine, model, effort, speed } = launch;
  const spawnImageNegotiationKey = `${project}\n${src ?? ""}\n${engine}`;
  const [spawnNegotiationAttempt, setSpawnNegotiationAttempt] = useState(0);
  const spawnImageNegotiation: SpawnImageNegotiationState = storedSpawnImageNegotiation.requestKey === spawnImageNegotiationKey
    ? storedSpawnImageNegotiation
    : { status: "loading", requestKey: spawnImageNegotiationKey };
  const [attempt, setAttemptState] = useState<SpawnAttempt | null>(() => readAttempt(draftId));
  const [slowBoot, setSlowBoot] = useState(false);
  /* Watch-window base (issue #919): a stream re-subscribe resets it, because a
     reconnect means everything the tab failed to observe before it may simply
     have been missed — the timers restart instead of the watch giving up. */
  const [watchBase, setWatchBase] = useState<number | null>(null);
  const attentionRef = useRef<HTMLDivElement>(null);
  /* Records launched from this mount are already in flight. Reloaded records
     are replayed once with their own idempotency key to fetch the same receipt. */
  const replayedAttemptIds = useRef(new Set<string>());

  useEffect(() => {
    const applyResolvedCwd = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; cwd?: string }>).detail;
      if (detail?.id !== draftId || typeof detail.cwd !== "string") return;
      awaitingInheritedCwdRef.current = false;
      setCwdState(detail.cwd);
    };
    window.addEventListener(DRAFT_CWD_RESOLVED_EVENT, applyResolvedCwd);
    return () => window.removeEventListener(DRAFT_CWD_RESOLVED_EVENT, applyResolvedCwd);
  }, [draftId]);

  const { setEngine, setModel, setEffort, setSpeed } = launch;
  /* The operator's own pick: it outranks every system answer from here on, so
     the seed is deliberately left behind rather than moved onto the new value. */
  const setCwd = (value: string) => {
    awaitingInheritedCwdRef.current = false;
    setCwdState(value);
    writeField(draftId, "cwd", value);
  };
  const setRoleParams = (value: Record<string, string | number>) => {
    setRoleParamsState(value);
    writeField(draftId, "roleParams", JSON.stringify(value));
  };
  const setRoleParam = (key: string, value: string | number) => {
    const next = { ...roleParams, [key]: value };
    setRoleParams(next);
    const selected = roles.find((role) => role.id === roleId);
    if (selected?.id !== "builder") return;
    if (next.domain === "frontend") {
      setEngine(BUILDER_FRONTEND_CONFIG.engine);
      setModel(BUILDER_FRONTEND_CONFIG.model);
      setEffort(BUILDER_FRONTEND_CONFIG.effort);
      setSpeed("");
      return;
    }
    if (next.mode === "apply-fixes") {
      setEngine(BUILDER_APPLY_FIXES_CONFIG.engine);
      setModel(BUILDER_APPLY_FIXES_CONFIG.model);
      setEffort(BUILDER_APPLY_FIXES_CONFIG.effort);
      return;
    }
    /* Plain/general mode falls back to the server-merged config so a saved
       role override is honored, matching selectRole below. */
    setEngine(selected.config.engine);
    setModel(selected.config.model);
    setEffort(selected.config.effort);
  };
  const setDeployConfirm = (value: string) => {
    setDeployConfirmState(value);
    writeField(draftId, "confirm", value);
  };
  const setReviews = (value: string) => {
    setReviewsState(value);
    writeField(draftId, "reviews", value);
  };
  const selectRole = (nextId: string) => {
    setRoleIdState(nextId);
    writeField(draftId, "role", nextId);
    const selected = roles.find((role) => role.id === nextId);
    if (!selected) {
      setRoleParams({});
      setDeployConfirm("");
      return;
    }
    const params = defaultRoleParameterValues(selected);
    setRoleParams(params);
    setDeployConfirm("");
    setEngine(selected.config.engine);
    setModel(selected.config.model);
    setEffort(selected.config.effort);
    setSpeed("");
  };
  const setAttempt = useCallback((value: SpawnAttempt | null) => {
    setAttemptState(value);
    writeField(draftId, "boot", value ? JSON.stringify(value) : "");
  }, [draftId]);
  const readySpawnImageNegotiation = spawnImageNegotiation.status === "ready" ? spawnImageNegotiation.value : null;
  /* The composer host capability the draft already negotiates (issue #266): a
     structured (pane-less) spawn has no tmux window, so every launch-copy that
     names tmux drops it. The default `tmux` transport keeps the legacy wording,
     as does the pre-negotiation window (the server defaults to tmux too). */
  const structuredSpawn = readySpawnImageNegotiation?.spawnTransport === "structured";
  const negotiatedSpawnImageCapability = readySpawnImageNegotiation?.spawnTransport === "structured"
    ? readySpawnImageNegotiation.imageInput[engine]
    : null;
  const structuredSpawnImageCapability = negotiatedSpawnImageCapability && engine === "codex" && !codexModelSupportsImages(model)
    ? { ...negotiatedSpawnImageCapability, supported: false, reason: t("composer.codexImagesTextOnly") }
    : negotiatedSpawnImageCapability;

  /* While a spawn is in flight the whole draft is frozen (boot set), so the
     composer's fields lock alongside the send/voice flags. */
  const composer = useComposer({
    initialText: () => readField(draftId, "text") || (src ? t("draft.readPrompt", { src }) : ""),
    persistText: (value) => writeField(draftId, "text", value),
    submit: (overrideText) => send(overrideText),
    disabled: Boolean(attempt),
    imageCapability: structuredSpawnImageCapability,
  });
  const { text, setText, setStatus, busy, setBusy, voiceSending, attachments } = composer;

  /* Recent working directories, the current project's first; a handoff draft
     inherits the source transcript's own cwd over everything else. */
  useEffect(() => {
    let cancelled = false;
    const requestKey = spawnImageNegotiationKey;
    fetch("/api/spawn?project=" + encodeURIComponent(project) + (src ? "&src=" + encodeURIComponent(src) : ""))
      .then(async (res) => {
        if (!res.ok) throw new Error("spawn capability request failed");
        return await res.json() as { dirs?: string[]; cwd?: string | null; spawnTransport?: unknown; imageInput?: unknown };
      })
      .then((json) => {
        if (cancelled) return;
        if (Array.isArray(json.dirs)) setDirs(json.dirs);
        const inherited = typeof json.cwd === "string" ? json.cwd.trim() : "";
        const shouldInherit = Boolean(awaitingInheritedCwdRef.current && inherited);
        if (shouldInherit) awaitingInheritedCwdRef.current = false;
        setCwdState((prev) => {
          const next = (shouldInherit && inherited) || prev || inherited || json.dirs?.[0] || "";
          if (next !== prev) setDraftCwd(draftId, next);
          return next;
        });
        const negotiation = spawnImageNegotiationValue(json);
        if (!negotiation) throw new Error("spawn capability response is invalid");
        setSpawnImageNegotiation({ status: "ready", requestKey, value: negotiation });
      })
      .catch(() => {
        if (!cancelled) setSpawnImageNegotiation({ status: "error", requestKey });
      });
    return () => {
      cancelled = true;
    };
  }, [project, draftId, src, engine, spawnImageNegotiationKey, spawnNegotiationAttempt]);

  /* The handover uses the exact receipt path, conversation id, or — when the
     accepted POST's response was lost — the durable projection's exact
     clientAttemptId (finding 3). A nearby transcript can be a simultaneous draft,
     so it cannot establish ownership. */
  useEffect(() => {
    if (!attempt) return;
    const hit = matchSpawnedFile(attempt, files);
    if (!hit) return;
    /* Lost-response recovery: with no response, submitAttempt never seeded the
       launch prompt. Seed it now under the canonical identity, keyed by the
       launch id so the success-path seed (or a reload replay) is a no-op — the
       queued canonical window shows the initial prompt exactly once. */
    const launchId = hit.spawn?.launchId ?? attempt.launchId;
    if (launchId && (attempt.prompt.trim() || attempt.hasImages)) {
      seedLaunchOutbox(conversationIdentity(hit), {
        id: launchId,
        text: attempt.prompt,
        images: attempt.request?.images.length ?? 0,
        at: attempt.at,
      });
    }
    onSpawned(hit);
  }, [files, attempt, onSpawned]);

  /* One bounded timer per attempt: a known-path boot only earns the slow hint
     (its file is deterministic and will still appear), and so does an ADMITTED
     confirming launch (issue #919: the receipt proved the worker, so the watch
     keeps going forever and only admits it is slow). Only a confirming attempt
     with no receipt at all — a genuinely unproven launch — escalates to
     `attention`, where the copy discourages a relaunch. Adoption above can
     still win afterward. */
  useEffect(() => {
    if (!attempt || attempt.phase === "attention") return;
    const bound = attempt.phase === "booting" ? SLOW_BOOT_MS : CONFIRM_ATTENTION_MS;
    const escalate = () => {
      if (attempt.phase === "booting" || admittedSpawn(attempt)) setSlowBoot(true);
      else setAttempt({ ...attempt, phase: "attention" });
    };
    const left = (watchBase ?? attempt.at) + bound - Date.now();
    if (left <= 0) {
      escalate();
      return;
    }
    const timer = window.setTimeout(escalate, left);
    return () => window.clearTimeout(timer);
  }, [attempt, setAttempt, watchBase]);

  /* A stream re-subscribe resets the watch window (issue #919): the tab's SSE /
     files feed reconnected, so the slow admission clears and the timers restart
     from now — the watch survives reconnects instead of aging through them. */
  useEffect(() => {
    const resetWatch = () => {
      setSlowBoot(false);
      setWatchBase(Date.now());
    };
    window.addEventListener(STREAM_RECONNECTED_EVENT, resetWatch);
    return () => window.removeEventListener(STREAM_RECONNECTED_EVENT, resetWatch);
  }, []);

  /* When recovery gives up, move focus to the assertive attention notice so a
     keyboard/screen-reader user lands on the "don't relaunch" guidance. */
  useEffect(() => {
    if (attempt?.phase === "attention") attentionRef.current?.focus();
  }, [attempt?.phase]);

  const submitAttempt = useCallback(async (candidate: SpawnAttempt & { request: NonNullable<SpawnAttempt["request"]> }) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spawnRequestBody(candidate)),
      });
      let json: SpawnResponseBody | null = null;
      try {
        json = (await res.json()) as SpawnResponseBody;
      } catch {
        json = null;
      }
      const outcome = classifySpawnResponse(res.status, res.ok, json);
      /* The server's own launch receipt is the event, and its id is the event's
         identity: a reload that re-POSTs the identical idempotency key gets the
         same launchId back, so the replay is silent. `clientAttemptId` covers a
         receipt that named no launch — it is durable across the same reload. */
      const launchEventId = outcome.kind === "launched" || outcome.kind === "failed-launch"
        ? outcome.launchId ?? candidate.clientAttemptId
        : null;
      if (launchEventId) {
        playCue(
          outcome.kind === "launched"
            ? { cue: "launch", eventId: `launch:${launchEventId}` }
            : { cue: "failure", eventId: `launch-failed:${launchEventId}` },
        );
      }
      if (typeof json?.launchId === "string" && typeof json.conversationId === "string") requestFilesRefresh();
      if (outcome.kind === "launched") {
        /* Seed the operator's launch prompt as the conversation's first
           optimistic user bubble (round-1 P1#2): the SPAWN delivers it, so the
           queued launch window shows the message immediately instead of an empty
           feed under status chips. Keyed on the durable conversation identity
           (the same identity the spawn placeholder and the materialized
           transcript share) and by the launch id, so a reload-replay is a no-op.
           When only the launch id is known yet, seed under the `spawn:` route so
           the window's composer adopts it forward onto the conversation. */
        const outboxCardId = outcome.conversationId ?? (outcome.launchId ? `spawn:${outcome.launchId}` : null);
        if (outboxCardId && outcome.launchId) {
          seedLaunchOutbox(outboxCardId, {
            id: outcome.launchId,
            text: candidate.prompt,
            images: candidate.request.images.length,
            at: candidate.at,
          });
        }
        setAttempt(applySpawnOutcome(candidate, outcome));
        /* Instant receipt-keyed attach (issue #919): a structured receipt names
           the durable conversation id, which IS the identity the live window
           keys its stream subscription on — so the panel hands over to the
           conversation window now. The overlay makes every mounted board render
           the same `spawn:<launchId>` card the server projects; the files feed
           later confirms and replaces it, never gates the attach. */
        const provisional = provisionalSpawnFile(candidate, outcome, project);
        if (provisional) {
          applySpawnedConversationSnapshot(provisional);
          onSpawned(provisional);
        }
      } else if (outcome.kind === "failed-launch") {
        setAttempt(applySpawnFailure(candidate, outcome));
      } else if (outcome.kind === "failed-preflight") {
        const upgraded = upgradeLegacySpawnAttempt(candidate, outcome);
        if (upgraded) {
          replayedAttemptIds.current.delete(candidate.clientAttemptId);
          setAttempt(upgraded);
          return;
        }
        /* The server released worker ownership. Restore the exact durable
           payload so editing and retrying cannot lose an attachment. */
        setAttempt(null);
        setText(candidate.request.prompt);
        const restored = attachments.replace(candidate.request.images.map((image) => ({
          ...image,
          preview: `data:${image.mime};base64,${image.base64}`,
        })));
        if (restored) setStatus({ kind: "err", text: outcome.message ?? t("draft.launchFailed") });
      }
      /* Ambiguous outcomes keep the persisted request and frozen card. A
         future reload can re-POST the identical idempotency key. */
    } catch {
      classifyTransportLoss();
      /* Transport loss leaves the persisted attempt unchanged. */
    } finally {
      setBusy(false);
    }
  }, [attachments, onSpawned, project, setAttempt, setBusy, setStatus, setText, t]);

  /* A reload during POST has the original payload already in session storage.
     Replaying that exact body returns its server receipt and never starts a
     second worker because clientAttemptId is stable. */
  useEffect(() => {
    if (!attempt || !hasRecoverableRequest(attempt) || replayedAttemptIds.current.has(attempt.clientAttemptId)) return;
    replayedAttemptIds.current.add(attempt.clientAttemptId);
    void submitAttempt(attempt);
  }, [attempt, submitAttempt]);

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;
  const spawnImagesDisabled = spawnImageNegotiation.status !== "ready"
    || (readySpawnImageNegotiation?.spawnTransport === "structured" && !structuredSpawnImageCapability?.supported);
  const spawnImagesReason = spawnImageNegotiation.status === "loading"
    ? t("composer.imageCapabilityLoading")
    : spawnImageNegotiation.status === "error"
      ? t("composer.imageCapabilityError")
      : readySpawnImageNegotiation?.spawnTransport === "structured" && engine === "codex" && !codexModelSupportsImages(model)
        ? t("composer.codexImagesTextOnly")
        : readySpawnImageNegotiation?.spawnTransport === "structured" && !structuredSpawnImageCapability?.supported
        ? t("composer.structuredImagesProtocol")
        : undefined;

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending || attempt) return;
    if (attachments.images.length && spawnImagesDisabled) {
      setStatus({ kind: "err", text: spawnImagesReason ?? t("composer.structuredImagesUnavailable") });
      return;
    }
    if (attachments.images.length && !attachments.validate()) return;
    if (!cwd.trim()) {
      setStatus({ kind: "err", text: t("draft.needDir") });
      return;
    }
    if (selectedRole) {
      const missing = selectedRole.parameters.find((parameter) => {
        if (!parameter.required) return false;
        const value = roleParams[parameter.key];
        return value === undefined || (typeof value === "string" && !value.trim());
      });
      if (missing) {
        setStatus({ kind: "err", text: t("draft.roleNeedsParams") });
        return;
      }
      if (selectedRole.id === "deployer" && deployConfirm !== "deploy") {
        setStatus({ kind: "err", text: t("draft.deployConfirm") });
        return;
      }
      if (selectedRole.id === "reviewer" && !reviews) {
        setStatus({ kind: "err", text: t("draft.reviewerNeedsConversation") });
        return;
      }
    }
    if (!payloadText.trim() && !attachments.images.length) return;
    const candidate = createSpawnAttempt(newAttemptId(), Date.now(), {
      title: draftSpawnTitle(engine, roleId, payloadText, attachments.images.length),
      engine,
      model,
      cwd: cwd.trim(),
      effort,
      fast: engine === "codex" && speed ? speed === "fast" : null,
      accountId: launch.launchAccountId,
      "prompt": payloadText,
      images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
      src,
      ...(parentConversationId ? { parentConversationId } : {}),
      ...(roleId ? {
        role: roleId,
        roleParams,
        ...(roleId === "reviewer" && reviews ? { reviews } : {}),
        ...(deployConfirm ? { confirm: deployConfirm } : {}),
      } : {}),
    });
    /* Persist before POST: a navigation now has the launch id, timestamp, and
       exact recoverable payload needed to reconcile the original request. */
    replayedAttemptIds.current.add(candidate.clientAttemptId);
    setSlowBoot(false);
    setWatchBase(null);
    setAttempt(candidate);
    setText("");
    attachments.clear();
    await submitAttempt(candidate);
  };

  const tint = engineTintOf(engine);
  const fieldsDisabled = composer.fieldsDisabled;
  const dirPickerId = "draft-dirs-" + draftId;
  /* Display phase drives the frozen-card copy. `busy` (POST in flight) shows as
     `launching`; a durable attempt shows booting/booting-slow/confirming/attention. */
  const phase = displayPhase(attempt, busy, slowBoot);
  const target = attempt?.target ?? "";
  const reviewCandidates = withoutArchivedPredecessors(files).filter((file) =>
    (file.engine === "claude" || file.engine === "codex")
    && Boolean(file.conversationId || file.path));

  return (
    <section
      data-pan-ignore
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-1"
      aria-label={t("draft.paneAria")}
    >
      <span aria-hidden className="h-1 w-full shrink-0" style={{ backgroundColor: tint.color }} />
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5" style={{ backgroundColor: tint.soft }}>
        <LaunchAccountSelect draft={launch} disabled={fieldsDisabled} className="max-w-28" />
        <span className="h-2 w-2 shrink-0 rounded-full bg-strong" title={t("draft.notStarted")} />
        <EngineRadioGroup engine={engine} disabled={fieldsDisabled} onChange={setEngine} />
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-semibold text-muted"
          title={srcFile ? cleanTitle(srcFile.title) : undefined}
        >
          {src ? t("draft.handoffLabel", { title: srcFile ? cleanTitle(srcFile.title, 60) : t("draft.conversation") }) : t("draft.newConvo")}
        </span>
        <button
          className="inline-flex shrink-0 items-center rounded-[8px] border border-border bg-canvas px-1.5 py-0.5 text-muted hover:border-danger/40 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("draft.dismiss")}
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </header>

      {/* The picker's popup hangs out of this strip, so the strip cannot clip
          its own overflow — the pane below it scrolls, the strip does not. */}
      <div className="relative z-20 flex shrink-0 items-center gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-muted">{t("draft.directory")}</span>
        <DirectoryPicker
          id={dirPickerId}
          value={cwd}
          dirs={dirs}
          disabled={fieldsDisabled}
          ariaLabel={t("draft.dirAria")}
          onChange={setCwd}
        />
      </div>

      <RoleSection
        idPrefix={draftId}
        roles={roles}
        roleId={roleId}
        roleParams={roleParams}
        disabled={fieldsDisabled}
        onSelectRole={selectRole}
        onSetParam={setRoleParam}
      >
        {selectedRole?.id === "reviewer" ? (
          <label className="flex max-w-full flex-col gap-0.5 text-caption text-muted">
            <span>{t("draft.reviews")}</span>
            <Select
              value={reviews}
              disabled={fieldsDisabled}
              onChange={(event) => setReviews(event.target.value)}
              aria-label={t("draft.reviewsAria")}
            >
              <option value="">{t("draft.reviewsPlaceholder")}</option>
              {reviews && !reviewCandidates.some((file) => (file.conversationId ?? file.path) === reviews) ? (
                <option value={reviews}>{reviews}</option>
              ) : null}
              {reviewCandidates.map((file) => {
                const value = file.conversationId ?? file.path;
                return <option key={value} value={value}>{cleanTitle(file.title, 80)}</option>;
              })}
            </Select>
          </label>
        ) : null}
        {selectedRole?.id === "deployer" ? (
          <label className="flex max-w-52 flex-col gap-0.5 text-[10px] text-muted">
            <span>{t("draft.deployConfirm")}</span>
            <input value={deployConfirm} disabled={fieldsDisabled} onChange={(event) => setDeployConfirm(event.target.value)} aria-label={t("draft.deployConfirm")} placeholder="deploy" className="h-7 rounded-[7px] border border-border bg-card px-1.5 text-[11px] text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60" />
          </label>
        ) : null}
      </RoleSection>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-sunken px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-muted">{t("draft.reasoning")}</span>
        <ReasoningControls
          engine={engine}
          model={model}
          effort={effort}
          speed={speed}
          disabled={fieldsDisabled}
          onModel={setModel}
          onEffort={setEffort}
          onSpeed={setSpeed}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {attempt ? (
          <div className="flex flex-1 flex-col justify-end gap-3">
            <div className="flex justify-end">
              <span className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-accent-soft px-2.5 py-1.5 text-[12px] text-secondary">
                {attempt.prompt || t("draft.imagesOnly")}
              </span>
            </div>
            <DraftLaunchStatus ref={attentionRef} phase={phase} target={target} structured={structuredSpawn} error={attempt.error ?? null} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ backgroundColor: tint.soft, color: tint.color }}>
              {engine === "claude" ? "Claude" : "Codex"}
            </span>
            <div className="max-w-[360px] text-[12px] text-muted">
              {src ? t("draft.hintRelay") : structuredSpawn ? t("draft.hintNewStructured") : t("draft.hintNew")}
            </div>
            {src ? (
              <div className="max-w-[420px] truncate font-mono text-[10px] text-muted" title={src}>
                {src}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="flex shrink-0 flex-col gap-1.5 border-t border-border bg-card px-2.5 py-2"
        aria-label={t("draft.promptAria")}
      >
        {spawnImageNegotiation.status === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-2 rounded-control bg-danger-soft px-2 py-1 text-caption text-danger">
            <span>{t("composer.imageCapabilityError")}</span>
            <button
              type="button"
              className="shrink-0 rounded-control border border-danger/30 bg-card px-2 py-1 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/30"
              onClick={() => {
                setSpawnImageNegotiation({ status: "loading", requestKey: spawnImageNegotiationKey });
                setSpawnNegotiationAttempt((attempt) => attempt + 1);
              }}
            >
              {t("composer.imageCapabilityRetry")}
            </button>
          </div>
        ) : null}
        <ComposerBar
          composer={composer}
          placeholder={structuredSpawn ? t("draft.placeholderStructured") : t("draft.placeholder")}
          textareaAriaLabel={t("draft.promptTextAria")}
          imageAriaLabel={t("draft.addImages")}
          sendLabelIdle={t("composer.launchAgent")}
          sendLabelRecording={t("draft.stopAndLaunch")}
          sendIdleClassName="hover:opacity-90"
          sendIdleStyle={{ backgroundColor: tint.color, borderColor: tint.color }}
          imageDisabled={spawnImagesDisabled}
          imageDisabledReason={spawnImagesReason}
          leftSlot={
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-control bg-sunken px-1.5 py-1 text-caption font-semibold text-secondary"
              title={structuredSpawn ? t("draft.newWindowTitleStructured") : t("draft.newWindowTitle")}
            >
              <Play className="h-3 w-3 shrink-0" aria-hidden /> {t("draft.newAgent")}
            </span>
          }
        />
      </form>
    </section>
  );
}
