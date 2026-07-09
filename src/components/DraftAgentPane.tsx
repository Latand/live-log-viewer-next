"use client";

import { useEffect, useRef, useState } from "react";

import { Loader2, Play, X } from "@/components/icons";
import { useComposer } from "@/hooks/useComposer";
import { isEngineEffort } from "@/lib/agent/efforts";
import { defaultModelFor } from "@/lib/agent/models";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { ComposerBar } from "./ComposerBar";
import { ReasoningControls, type SpeedChoice } from "./ReasoningControls";
import { cleanTitle, engineTintOf } from "./utils";

type Engine = "claude" | "codex";

const ENGINES: { key: Engine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

/* After this long without a matched transcript the draft admits something is
   off and points at the tmux window instead of spinning forever. */
const SLOW_BOOT_MS = 90_000;

/** A spawn already fired from this draft: the moment, the tmux window and —
    for claude — the exact transcript path the fresh session will write. */
interface Boot {
  at: number;
  target: string;
  path: string | null;
  prompt: string;
}

const field = (id: string, name: string) => `llvDraftPane:${id}:${name}`;

function readField(id: string, name: string): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(field(id, name)) ?? "";
}

function writeField(id: string, name: string, value: string) {
  if (value) sessionStorage.setItem(field(id, name), value);
  else sessionStorage.removeItem(field(id, name));
}

/** Everything a draft keeps in sessionStorage; called when the draft leaves the scheme. */
export function clearDraftStorage(id: string) {
  for (const name of ["engine", "model", "cwd", "text", "boot", "src", "effort", "speed", "accountId"]) sessionStorage.removeItem(field(id, name));
}

/** Source transcript a handoff draft continues; empty for a plain draft. */
export function draftSrc(id: string): string {
  return readField(id, "src");
}

/** Marks a fresh draft as a handoff of the given transcript, before it mounts. */
export function setDraftSrc(id: string, src: string) {
  writeField(id, "src", src);
}

/** Seeds a fresh draft's first prompt, before it mounts — the «send a task to
    a brand-new agent» path drops the task text here, launching nothing. */
export function setDraftText(id: string, text: string) {
  writeField(id, "text", text);
}

function readBoot(id: string): Boot | null {
  try {
    const raw = JSON.parse(readField(id, "boot") || "null") as Boot | null;
    return raw && typeof raw.at === "number" && typeof raw.prompt === "string" ? raw : null;
  } catch {
    return null;
  }
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
  const [accounts, setAccounts] = useState<{ id: string; label: string }[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [boot, setBootState] = useState<Boot | null>(() => readBoot(draftId));
  const [slowBoot, setSlowBoot] = useState(false);
  /* Transcripts that existed before the spawn: the codex match below must
     never grab a conversation that was already on disk. Not persisted — after
     a reload the mtime cutoff alone carries the match. */
  const knownRef = useRef<Set<string> | null>(null);

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
  const setBoot = (value: Boot | null) => {
    setBootState(value);
    writeField(draftId, "boot", value ? JSON.stringify(value) : "");
  };

  /* While a spawn is in flight the whole draft is frozen (boot set), so the
     composer's fields lock alongside the send/voice flags. */
  const composer = useComposer({
    initialText: () => readField(draftId, "text") || (src ? t("draft.readPrompt", { src }) : ""),
    persistText: (value) => writeField(draftId, "text", value),
    submit: (overrideText) => send(overrideText),
    disabled: Boolean(boot),
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

  /* The handover: a claude spawn knows its transcript path up front and waits
     for exactly that file; a codex rollout has no knowable path, so the first
     fresh root conversation in codex-sessions after the spawn moment is ours. */
  useEffect(() => {
    if (!boot) return;
    const known = knownRef.current;
    const hit = boot.path
      ? files.find((file) => file.path === boot.path)
      : files.find(
          (file) =>
            file.engine === "codex" &&
            file.root === "codex-sessions" &&
            /* A handoff spawn gets linked under its source by the scanner, so
               the fresh rollout may already carry a parent — accept that too. */
            (src ? file.parent === src || !file.parent : !file.parent) &&
            file.mtime >= boot.at / 1000 - 30 &&
            (!known || !known.has(file.path)),
        );
    if (hit) onSpawned(hit);
  }, [files, boot, onSpawned, src]);

  useEffect(() => {
    if (!boot) return;
    const left = boot.at + SLOW_BOOT_MS - Date.now();
    if (left <= 0) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setSlowBoot(true);
      return;
    }
    const timer = window.setTimeout(() => setSlowBoot(true), left);
    return () => window.clearTimeout(timer);
  }, [boot]);

  const send = async (overrideText?: string) => {
    const payloadText = overrideText ?? text;
    if (busy || voiceSending || boot) return;
    if (!cwd.trim()) {
      setStatus({ kind: "err", text: t("draft.needDir") });
      return;
    }
    if (!payloadText.trim() && !attachments.images.length) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine,
          ...(model ? { model } : {}),
          cwd: cwd.trim(),
          ...(effort ? { effort } : {}),
          ...(engine === "codex" && speed ? { fast: speed === "fast" } : {}),
          ...(engine === "codex" && accountId ? { accountId } : {}),
          prompt: payloadText,
          images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
          /* Ties the fresh agent to the source conversation: the scanner links
             its transcript as a handoff branch next to the parent's node. */
          ...(src ? { src } : {}),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; target?: string; path?: string | null; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? t("draft.launchFailed") });
        return;
      }
      knownRef.current = new Set(files.map((file) => file.path));
      setBoot({ at: Date.now(), target: json.target ?? "", path: json.path ?? null, prompt: payloadText.trim() });
      setText("");
      attachments.clear();
    } catch {
      setStatus({ kind: "err", text: t("common.serverUnavailable") });
    } finally {
      setBusy(false);
    }
  };

  const tint = engineTintOf(engine);
  const fieldsDisabled = composer.fieldsDisabled;
  const dirListId = "draft-dirs-" + draftId;

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
        {boot ? (
          <div className="flex flex-1 flex-col justify-end gap-3">
            <div className="flex justify-end">
              <span className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2.5 py-1.5 text-[12px] text-[#333]">
                {boot.prompt || t("draft.imagesOnly")}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11.5px] font-semibold text-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              <span>
                {t("draft.launched", { target: boot.target })}
              </span>
            </div>
            {slowBoot ? (
              <div className="text-[11px] text-dim">
                {t("draft.slow", { target: boot.target })}
              </div>
            ) : null}
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
        className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-[#fbfbfd] px-2.5 py-2"
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
              className="inline-flex min-w-0 items-center gap-1 rounded-full bg-chip px-1.5 py-1 font-mono text-[9.5px] font-semibold text-[#555]"
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
