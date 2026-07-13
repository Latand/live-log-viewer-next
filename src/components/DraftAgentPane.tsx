"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Play, X } from "@/components/icons";
import { useComposer } from "@/hooks/useComposer";
import { isEngineEffort } from "@/lib/agent/efforts";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import { BUILDER_APPLY_FIXES_CONFIG, BUILDER_FRONTEND_CONFIG } from "@/lib/roles/paramConfig";
import type { RoleDefinition } from "@/lib/roles/types";
import type { FileEntry } from "@/lib/types";

import { ComposerBar } from "./ComposerBar";
import { DraftLaunchStatus } from "./DraftLaunchStatus";
import {
  CONFIRM_ATTENTION_MS,
  SLOW_BOOT_MS,
  type SpawnAttempt,
  type SpawnResponseBody,
  applySpawnOutcome,
  classifySpawnResponse,
  classifyTransportLoss,
  createSpawnAttempt,
  displayPhase,
  hasRecoverableRequest,
  matchSpawnedFile,
  spawnRequestBody,
} from "./draftSpawn";
import { ReasoningControls, type SpeedChoice } from "./ReasoningControls";
import { cleanTitle, engineTintOf } from "./utils";

type Engine = "claude" | "codex";

const ENGINES: { key: Engine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

const field = (id: string, name: string) => `llvDraftPane:${id}:${name}`;

type RoleCatalogItem = RoleDefinition & { promptPreview: string };

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
  for (const name of ["engine", "model", "cwd", "text", "boot", "src", "parentConversationId", "effort", "speed", "accountId", "role", "roleParams", "confirm"]) sessionStorage.removeItem(field(id, name));
}

/** Source transcript a handoff draft continues; empty for a plain draft. */
export function draftSrc(id: string): string {
  return readField(id, "src");
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
  const [engine, setEngineState] = useState<Engine>(() => {
    const stored = readField(draftId, "engine");
    if (stored === "codex" || stored === "claude") return stored;
    return srcFile?.engine === "codex" ? "codex" : "claude";
  });
  const [cwd, setCwdState] = useState(() => readField(draftId, "cwd"));
  const [model, setModelState] = useState(() => readField(draftId, "model") || defaultModelFor(engine));
  const [effort, setEffortState] = useState(() => readField(draftId, "effort"));
  const [speed, setSpeedState] = useState<SpeedChoice>(() => {
    const stored = readField(draftId, "speed");
    return stored === "fast" || stored === "standard" ? stored : "";
  });
  const [accountId, setAccountIdState] = useState(() => readField(draftId, "accountId"));
  const [roles, setRoles] = useState<RoleCatalogItem[]>([]);
  const [roleId, setRoleIdState] = useState(() => readField(draftId, "role"));
  const [roleParams, setRoleParamsState] = useState(() => readRoleParams(draftId));
  const [deployConfirm, setDeployConfirmState] = useState(() => readField(draftId, "confirm"));
  const [accounts, setAccounts] = useState<{ id: string; label: string }[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [attempt, setAttemptState] = useState<SpawnAttempt | null>(() => readAttempt(draftId));
  const [slowBoot, setSlowBoot] = useState(false);
  const attentionRef = useRef<HTMLDivElement>(null);
  /* Records launched from this mount are already in flight. Reloaded records
     are replayed once with their own idempotency key to fetch the same receipt. */
  const replayedAttemptIds = useRef(new Set<string>());

  const setModel = (value: string) => {
    setModelState(value);
    writeField(draftId, "model", value);
  };
  const setEffort = (value: string) => {
    setEffortState(value);
    writeField(draftId, "effort", value);
  };
  const setSpeed = (value: SpeedChoice) => {
    setSpeedState(value);
    writeField(draftId, "speed", value);
  };
  const setEngine = (value: Engine) => {
    setEngineState(value);
    writeField(draftId, "engine", value);
    setModel(defaultModelFor(value));
    /* Tier lists differ per engine (claude has "max", codex does not) — a
       carried-over invalid tier falls back to the CLI default. */
    if (effort && !isEngineEffort(value, effort)) setEffort("");
  };
  const setCwd = (value: string) => {
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
  const selectRole = (nextId: string) => {
    setRoleIdState(nextId);
    writeField(draftId, "role", nextId);
    const selected = roles.find((role) => role.id === nextId);
    if (!selected) {
      setRoleParams({});
      setDeployConfirm("");
      return;
    }
    const params = Object.fromEntries(selected.parameters.map((parameter) => [
      parameter.key,
      parameter.kind === "integer" ? parameter.min ?? 1 : parameter.options?.[0] ?? "",
    ]));
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

  /* While a spawn is in flight the whole draft is frozen (boot set), so the
     composer's fields lock alongside the send/voice flags. */
  const composer = useComposer({
    initialText: () => readField(draftId, "text") || (src ? t("draft.readPrompt", { src }) : ""),
    persistText: (value) => writeField(draftId, "text", value),
    submit: (overrideText) => send(overrideText),
    disabled: Boolean(attempt),
  });
  const { text, setText, setStatus, busy, setBusy, voiceSending, attachments } = composer;

  /* Recent working directories, the current project's first; a handoff draft
     inherits the source transcript's own cwd over everything else. */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/spawn?project=" + encodeURIComponent(project) + (src ? "&src=" + encodeURIComponent(src) : ""))
      .then((res) => res.json() as Promise<{ dirs?: string[]; cwd?: string | null }>)
      .then((json) => {
        if (cancelled) return;
        if (Array.isArray(json.dirs)) setDirs(json.dirs);
        setCwdState((prev) => {
          const inherited = typeof json.cwd === "string" ? json.cwd : "";
          const next = prev || inherited || json.dirs?.[0] || "";
          if (next !== prev) writeField(draftId, "cwd", next);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, draftId, src]);

  useEffect(() => {
    void fetch("/api/accounts").then(async (res) => {
      if (!res.ok) return;
      const body = await res.json() as { codex: { active: string; accounts: { id: string; label: string }[] } };
      setAccounts(body.codex.accounts);
      setAccountIdState((value) => value || body.codex.active);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/roles").then(async (res) => {
      if (!res.ok) return;
      const body = await res.json() as { roles?: RoleCatalogItem[] };
      if (!cancelled && Array.isArray(body.roles)) setRoles(body.roles);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /* The handover uses the exact receipt path or conversation id. A nearby
     transcript can be a simultaneous draft, so it cannot establish ownership. */
  useEffect(() => {
    if (!attempt) return;
    const hit = matchSpawnedFile(attempt, files);
    if (hit) onSpawned(hit);
  }, [files, attempt, onSpawned]);

  /* One bounded timer per attempt: a known-path boot only earns the slow hint
     (its file is deterministic and will still appear); a path-unknown confirm
     escalates to `attention` after the bound, where the copy discourages a
     relaunch. Adoption above can still win afterward. */
  useEffect(() => {
    if (!attempt || attempt.phase === "attention") return;
    const bound = attempt.phase === "booting" ? SLOW_BOOT_MS : CONFIRM_ATTENTION_MS;
    const escalate = () => {
      if (attempt.phase === "booting") setSlowBoot(true);
      else setAttempt({ ...attempt, phase: "attention" });
    };
    const left = attempt.at + bound - Date.now();
    if (left <= 0) {
      escalate();
      return;
    }
    const timer = window.setTimeout(escalate, left);
    return () => window.clearTimeout(timer);
  }, [attempt, setAttempt]);

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
      if (outcome.kind === "launched") {
        setAttempt(applySpawnOutcome(candidate, outcome));
      } else if (outcome.kind === "failed-preflight") {
        /* The server proved that no pane opened. Restore the exact durable
           payload so editing and retrying cannot lose an attachment. */
        setAttempt(null);
        setText(candidate.request.prompt);
        attachments.replace(candidate.request.images.map((image) => ({
          ...image,
          preview: `data:${image.mime};base64,${image.base64}`,
        })));
        setStatus({ kind: "err", text: outcome.message ?? t("draft.launchFailed") });
      }
      /* Ambiguous outcomes keep the persisted request and frozen card. A
         future reload can re-POST the identical idempotency key. */
    } catch {
      classifyTransportLoss();
      /* Transport loss leaves the persisted attempt unchanged. */
    } finally {
      setBusy(false);
    }
  }, [attachments, setAttempt, setBusy, setStatus, setText, t]);

  /* A reload during POST has the original payload already in session storage.
     Replaying that exact body returns its server receipt and never starts a
     second worker because clientAttemptId is stable. */
  useEffect(() => {
    if (!attempt || !hasRecoverableRequest(attempt) || replayedAttemptIds.current.has(attempt.clientAttemptId)) return;
    replayedAttemptIds.current.add(attempt.clientAttemptId);
    void submitAttempt(attempt);
  }, [attempt, submitAttempt]);

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending || attempt) return;
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
    }
    if (!payloadText.trim() && !attachments.images.length) return;
    /* eslint-disable-next-line react-hooks/purity -- `send` only runs from
       user events (submit/keydown), never during render; the id and timestamp
       must be minted at click time. */
    const candidate = createSpawnAttempt(newAttemptId(), Date.now(), {
      engine,
      model,
      cwd: cwd.trim(),
      effort,
      fast: engine === "codex" && speed ? speed === "fast" : null,
      accountId: engine === "codex" ? accountId : "",
      prompt: payloadText,
      images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
      src,
      ...(parentConversationId ? { parentConversationId } : {}),
      ...(roleId ? { role: roleId, roleParams, ...(deployConfirm ? { confirm: deployConfirm } : {}) } : {}),
    });
    /* Persist before POST: a navigation now has the launch id, timestamp, and
       exact recoverable payload needed to reconcile the original request. */
    replayedAttemptIds.current.add(candidate.clientAttemptId);
    setAttempt(candidate);
    setText("");
    attachments.clear();
    await submitAttempt(candidate);
  };

  const tint = engineTintOf(engine);
  const fieldsDisabled = composer.fieldsDisabled;
  const dirListId = "draft-dirs-" + draftId;
  /* Display phase drives the frozen-card copy. `busy` (POST in flight) shows as
     `launching`; a durable attempt shows booting/booting-slow/confirming/attention. */
  const phase = displayPhase(attempt, busy, slowBoot);
  const target = attempt?.target ?? "";

  return (
    <section
      data-pan-ignore
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-card"
      aria-label={t("draft.paneAria")}
    >
      <span aria-hidden className="h-1 w-full shrink-0" style={{ backgroundColor: tint.color }} />
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2.5" style={{ backgroundColor: tint.soft }}>
        {engine === "codex" && accounts.length ? <select value={accountId} onChange={(event) => { setAccountIdState(event.target.value); writeField(draftId, "accountId", event.target.value); }} className="h-6 max-w-28 rounded border border-line bg-bg px-1 text-[10px] font-semibold" aria-label={t("accounts.activeAria")}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</select> : null}
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#c9c9d1]" title={t("draft.notStarted")} />
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
                disabled={fieldsDisabled}
                onClick={() => setEngine(key)}
                style={active ? { backgroundColor: "#fff", color: chip.color, borderColor: chip.color } : undefined}
                className={`rounded-full border px-2 py-0.5 text-[10.5px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                  active ? "" : "border-transparent bg-transparent text-dim hover:text-ink"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-semibold text-dim"
          title={srcFile ? cleanTitle(srcFile.title) : undefined}
        >
          {src ? t("draft.handoffLabel", { title: srcFile ? cleanTitle(srcFile.title, 60) : t("draft.conversation") }) : t("draft.newConvo")}
        </span>
        <button
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label={t("draft.dismiss")}
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-[#fbfbfd] px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-dim">{t("draft.directory")}</span>
        <input
          value={cwd}
          disabled={fieldsDisabled}
          onChange={(event) => setCwd(event.target.value)}
          list={dirListId}
          placeholder="/home/…/Projects/…"
          aria-label={t("draft.dirAria")}
          className="min-w-0 flex-1 rounded-[6px] border border-line bg-panel px-2 py-1 font-mono text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <datalist id={dirListId}>
          {dirs.map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-[#fbfbfd] px-2.5 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <label className="shrink-0 text-[10px] font-semibold text-dim" htmlFor={`draft-role-${draftId}`}>{t("draft.role")}</label>
          <select
            id={`draft-role-${draftId}`}
            value={roleId}
            disabled={fieldsDisabled}
            onChange={(event) => selectRole(event.target.value)}
            aria-label={t("draft.roleAria")}
            className="h-7 min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-1.5 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
          >
            <option value="">{t("draft.noRole")}</option>
            {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
        </div>
        {selectedRole ? (
          <>
            <p className="text-[10px] leading-4 text-dim">{selectedRole.description}</p>
            {selectedRole.parameters.length ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("draft.roleParameters")}>
                {selectedRole.parameters.map((parameter) => (
                  <label key={parameter.key} className="flex min-w-28 flex-1 flex-col gap-0.5 text-[10px] text-dim">
                    <span>{parameter.label}{parameter.required ? " *" : ""}</span>
                    {parameter.kind === "select" ? (
                      <select value={String(roleParams[parameter.key] ?? "")} disabled={fieldsDisabled} onChange={(event) => setRoleParam(parameter.key, event.target.value)} className="h-7 rounded-[7px] border border-line bg-panel px-1 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60">
                        {parameter.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input type={parameter.kind === "integer" ? "number" : "text"} min={parameter.min} max={parameter.max} value={String(roleParams[parameter.key] ?? "")} disabled={fieldsDisabled} onChange={(event) => setRoleParam(parameter.key, parameter.kind === "integer" && event.target.value ? Number(event.target.value) : event.target.value)} aria-label={parameter.label} className="h-7 min-w-0 rounded-[7px] border border-line bg-panel px-1.5 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60" />
                    )}
                    <span className="leading-3">{parameter.description}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {selectedRole.id === "deployer" ? (
              <label className="flex max-w-52 flex-col gap-0.5 text-[10px] text-dim">
                <span>{t("draft.deployConfirm")}</span>
                <input value={deployConfirm} disabled={fieldsDisabled} onChange={(event) => setDeployConfirm(event.target.value)} aria-label={t("draft.deployConfirm")} placeholder="deploy" className="h-7 rounded-[7px] border border-line bg-panel px-1.5 text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60" />
              </label>
            ) : null}
            <div className="rounded-[7px] border border-line bg-chip px-2 py-1.5 text-[10px] leading-4 text-dim">
              <span className="font-semibold text-ink">{t("draft.scaffoldPreview")}</span>
              <pre className="mt-1 whitespace-pre-wrap font-sans">{scaffoldPreview(selectedRole.promptPreview, roleParams)}</pre>
              <ul className="mt-1 list-disc pl-4" aria-label={t("draft.safetyFences")}>
                {selectedRole.safetyFences.map((fence) => <li key={fence}>{fence}</li>)}
              </ul>
            </div>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-[#fbfbfd] px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-dim">{t("draft.reasoning")}</span>
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
              <span className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2.5 py-1.5 text-[12px] text-[#333]">
                {attempt.prompt || t("draft.imagesOnly")}
              </span>
            </div>
            <DraftLaunchStatus ref={attentionRef} phase={phase} target={target} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ backgroundColor: tint.soft, color: tint.color }}>
              {engine === "claude" ? "Claude" : "Codex"}
            </span>
            <div className="max-w-[360px] text-[12px] text-dim">
              {src ? t("draft.hintRelay") : t("draft.hintNew")}
            </div>
            {src ? (
              <div className="max-w-[420px] truncate font-mono text-[10px] text-dim" title={src}>
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
        <ComposerBar
          composer={composer}
          placeholder={t("draft.placeholder")}
          textareaAriaLabel={t("draft.promptTextAria")}
          imageAriaLabel={t("draft.addImages")}
          sendLabelIdle={t("composer.launchAgent")}
          sendLabelRecording={t("draft.stopAndLaunch")}
          sendIdleClassName="hover:opacity-90"
          sendIdleStyle={{ backgroundColor: tint.color, borderColor: tint.color }}
          leftSlot={
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-control bg-sunken px-1.5 py-1 text-caption font-semibold text-secondary"
              title={t("draft.newWindowTitle")}
            >
              <Play className="h-3 w-3 shrink-0" aria-hidden /> {t("draft.newAgent")}
            </span>
          }
        />
      </form>
    </section>
  );
}
