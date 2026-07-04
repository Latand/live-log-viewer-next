"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Loader2, Play, X } from "@/components/icons";
import { useDictation } from "@/hooks/useDictation";
import type { FileEntry } from "@/lib/types";

import { ImagePickerButton, ImagePreviewStrip, useImageAttachments } from "./imageAttachments";
import { MicButtonView } from "./MicButton";
import { engineTintOf } from "./utils";

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
  for (const name of ["engine", "cwd", "text", "boot"]) sessionStorage.removeItem(field(id, name));
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
  const [engine, setEngineState] = useState<Engine>(() => (readField(draftId, "engine") === "codex" ? "codex" : "claude"));
  const [cwd, setCwdState] = useState(() => readField(draftId, "cwd"));
  const [dirs, setDirs] = useState<string[]>([]);
  const [text, setTextState] = useState(() => readField(draftId, "text"));
  const [boot, setBootState] = useState<Boot | null>(() => readBoot(draftId));
  const [busy, setBusy] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [slowBoot, setSlowBoot] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /* Transcripts that existed before the spawn: the codex match below must
     never grab a conversation that was already on disk. Not persisted — after
     a reload the mtime cutoff alone carries the match. */
  const knownRef = useRef<Set<string> | null>(null);
  /* Async dictation callbacks land after the render they closed over. */
  const textRef = useRef(text);

  const setEngine = (value: Engine) => {
    setEngineState(value);
    writeField(draftId, "engine", value);
  };
  const setCwd = (value: string) => {
    setCwdState(value);
    writeField(draftId, "cwd", value);
  };
  const setText = (value: string | ((prev: string) => string)) => {
    const next = typeof value === "function" ? value(textRef.current) : value;
    textRef.current = next;
    setTextState(next);
    writeField(draftId, "text", next);
  };
  const setBoot = (value: Boot | null) => {
    setBootState(value);
    writeField(draftId, "boot", value ? JSON.stringify(value) : "");
  };

  const attachments = useImageAttachments({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onAdded: () => setStatus(null),
  });
  const insertSpoken = (spoken: string) => {
    setText((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken));
    setStatus(null);
    inputRef.current?.focus();
  };
  const dictation = useDictation({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onUnclaimedText: insertSpoken,
  });

  /* Recent working directories, the current project's first. */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/spawn?project=" + encodeURIComponent(project))
      .then((res) => res.json() as Promise<{ dirs?: string[] }>)
      .then((json) => {
        if (cancelled || !Array.isArray(json.dirs)) return;
        setDirs(json.dirs);
        setCwdState((prev) => {
          const next = prev || json.dirs?.[0] || "";
          if (next !== prev) writeField(draftId, "cwd", next);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project, draftId]);

  /* The field grows with its content up to ~6 rows, then scrolls inside itself. */
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight + 2, 160) + "px";
  }, [text]);

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
            !file.parent &&
            file.mtime >= boot.at / 1000 - 30 &&
            (!known || !known.has(file.path)),
        );
    if (hit) onSpawned(hit);
  }, [files, boot, onSpawned]);

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
      setStatus({ kind: "err", text: "вкажи робочу директорію" });
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
          cwd: cwd.trim(),
          prompt: payloadText,
          images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; target?: string; path?: string | null; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося запустити" });
        return;
      }
      knownRef.current = new Set(files.map((file) => file.path));
      setBoot({ at: Date.now(), target: json.target ?? "", path: json.path ?? null, prompt: payloadText.trim() });
      setText("");
      attachments.clear();
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setBusy(false);
    }
  };

  /* One-tap voice send, same contract as the pane composer. */
  const stopAndSend = async () => {
    if (busy || voiceSending) return;
    setVoiceSending(true);
    try {
      const spoken = await dictation.stop();
      if (spoken === null) return;
      const combined = textRef.current ? textRef.current.trimEnd() + " " + spoken : spoken;
      setText(combined);
      await send(combined);
    } finally {
      setVoiceSending(false);
    }
  };

  const tint = engineTintOf(engine);
  const dictationRecording = dictation.phase === "rec";
  const dictationBusy = dictation.phase === "busy";
  const fieldsDisabled = busy || voiceSending || Boolean(boot);
  const canSend =
    !fieldsDisabled && !dictationBusy && (dictationRecording || Boolean(text.trim()) || attachments.images.length > 0);
  const dirListId = "draft-dirs-" + draftId;

  return (
    <section
      data-pan-ignore
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-t-4 border-line bg-panel shadow-card"
      style={{ borderTopColor: tint.color }}
      aria-label="Чернетка нової розмови з агентом"
    >
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-2.5" style={{ backgroundColor: tint.soft }}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#c9c9d1]" title="агент ще не запущений" />
        <div className="flex shrink-0 items-center gap-1" role="radiogroup" aria-label="Двигун агента">
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
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-dim">нова розмова</span>
        <button
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-bg px-1.5 py-0.5 text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Прибрати чернетку розмови"
          onClick={onClose}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-[#fbfbfd] px-2.5 py-1.5">
        <span className="shrink-0 text-[10px] font-semibold text-dim">директорія</span>
        <input
          value={cwd}
          disabled={fieldsDisabled}
          onChange={(event) => setCwd(event.target.value)}
          list={dirListId}
          placeholder="/home/…/Projects/…"
          aria-label="Робоча директорія агента"
          className="min-w-0 flex-1 rounded-[6px] border border-line bg-panel px-2 py-1 font-mono text-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <datalist id={dirListId}>
          {dirs.map((dir) => (
            <option key={dir} value={dir} />
          ))}
        </datalist>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        {boot ? (
          <div className="flex flex-1 flex-col justify-end gap-3">
            <div className="flex justify-end">
              <span className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2.5 py-1.5 text-[12px] text-[#333]">
                {boot.prompt || "(картинки)"}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[11.5px] font-semibold text-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              <span>
                агент запущений у tmux {boot.target} — чекаю, поки розмова з&apos;явиться тут…
              </span>
            </div>
            {slowBoot ? (
              <div className="text-[11px] text-dim">
                Щось довго. Перевір вікно tmux {boot.target} — щойно транскрипт з&apos;явиться, панель підхопить його сама.
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ backgroundColor: tint.soft, color: tint.color }}>
              {engine === "claude" ? "Claude" : "Codex"}
            </span>
            <div className="max-w-[360px] text-[12px] text-dim">
              Обери двигун і директорію, напиши перший промпт — агент запуститься в tmux, і розмова продовжиться в цій самій
              панелі.
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="flex shrink-0 flex-col gap-1.5 border-t border-line bg-[#fbfbfd] px-2.5 py-2"
        aria-label="Перший промпт для нового агента"
      >
        <textarea
          ref={inputRef}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onPaste={attachments.handlePaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (dictation.phase === "rec") void stopAndSend();
              else void send();
            }
          }}
          placeholder="перший промпт — агент запуститься в tmux…"
          aria-label="Текст першого промпта"
          disabled={fieldsDisabled}
          className="w-full resize-none overflow-y-auto rounded-[10px] border border-line bg-panel px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[#222] placeholder:text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-1.5">
          <span
            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-chip px-1.5 py-1 font-mono text-[9.5px] font-semibold text-[#555]"
            title="нове tmux-вікно зі свіжим агентом"
          >
            <Play className="h-3 w-3 shrink-0" aria-hidden /> новий агент
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <MicButtonView {...dictation} busy={voiceSending} onText={insertSpoken} />
            <ImagePickerButton
              ariaLabel="Додати картинки до промпта"
              className="inline-flex shrink-0 items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onFiles={attachments.addFiles}
            />
            <button
              type={dictationRecording ? "button" : "submit"}
              onClick={dictationRecording ? () => void stopAndSend() : undefined}
              disabled={!canSend}
              aria-label={dictationRecording ? "Зупинити запис і запустити агента" : "Запустити агента"}
              style={dictationRecording ? undefined : { backgroundColor: tint.color, borderColor: tint.color }}
              className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border p-2 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40 ${
                dictationRecording ? "border-err bg-err hover:opacity-90" : "hover:opacity-90"
              }`}
            >
              {busy || voiceSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        </div>
        <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />
        {status ? (
          <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>{status.text}</span>
        ) : null}
      </form>
    </section>
  );
}
