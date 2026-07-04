"use client";

import { useEffect, useRef, useState } from "react";

import { ArrowRight, ArrowUpToLine, ImageIcon, Loader2, Play, SquareTerminal, X } from "@/components/icons";
import { useTmuxTarget } from "@/hooks/useTmuxTarget";
import type { FileEntry } from "@/lib/types";

import { MicButton } from "./MicButton";

interface PendingImage {
  base64: string;
  mime: string;
  preview: string;
}

interface SentEntry {
  id: number;
  text: string;
  at: number;
  /** How the message left: into an existing pane or by booting a new window. */
  via: "pane" | "spawn";
}

const SENT_LIMIT = 8;
const SPAWN_TTL_MS = 90_000;
const PANE_TTL_MS = 10 * 60_000;
const sentKey = (path: string) => "llvSent:" + path;

function readSent(path: string): SentEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(sentKey(path)) ?? "[]") as SentEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      resolve({ base64, mime: file.type || "image/png", preview: dataUrl });
    };
    reader.onerror = () => reject(reader.error ?? new Error("не вдалося прочитати картинку"));
    reader.readAsDataURL(file);
  });
}

/** Conversations that accept a message without a live pane: root sessions
    reopen through resume; subagents relay through their root conversation. */
function canMessageWithoutPane(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "сесія" || file.kind === "субагент";
  return file.root === "codex-sessions";
}

const draftKey = (path: string) => "llvDraft:" + path;

const hhmm = (at: number) => new Date(at).toLocaleTimeString("uk", { hour12: false, hour: "2-digit", minute: "2-digit" });

/**
 * Chat-style composer pinned under the feed. A live pane gets the text typed
 * straight into its tmux pane; a finished resumable conversation boots a new
 * agent window in the current tmux session with the text as the first prompt.
 * Sent messages stay visible as a queue above the input until dismissed.
 */
export function TmuxComposer({ file }: { file: FileEntry }) {
  const target = useTmuxTarget(file.pid);
  /* Column reshuffles can remount the composer mid-typing; the draft lives in
     sessionStorage so the text survives the remount. */
  const [text, setTextState] = useState(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(draftKey(file.path)) ?? "";
  });
  const setText = (value: string) => {
    setTextState(value);
    if (value) sessionStorage.setItem(draftKey(file.path), value);
    else sessionStorage.removeItem(draftKey(file.path));
  };
  const [images, setImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [sent, setSent] = useState<SentEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* eslint-disable-next-line react-hooks/set-state-in-effect */
  useEffect(() => setSent(readSent(file.path)), [file.path]);

  /* The queue drains itself: a pane message is delivered once the transcript
     grew after the send moment; a spawn prompt lands in a fresh window whose
     transcript is a different file, so it expires by time instead. A pane
     relay into a subagent that has since finished never grows its transcript
     again, so pane entries also fall back to a TTL, just a longer one than
     spawn entries since a live pane can legitimately go quiet for a while. */
  useEffect(() => {
    const prune = () =>
      setSent((prev) => {
        const next = prev.filter((entry) => {
          if (entry.via === "pane") return file.mtime * 1000 < entry.at + 2_000 && Date.now() - entry.at < PANE_TTL_MS;
          return Date.now() - entry.at < SPAWN_TTL_MS;
        });
        if (next.length !== prev.length) sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
        return next.length !== prev.length ? next : prev;
      });
    prune();
    const timer = setInterval(prune, 5_000);
    return () => clearInterval(timer);
  }, [file.mtime, file.path]);

  const resumable = canMessageWithoutPane(file);
  if (target === null && !resumable) return null;
  const spawnMode = target === null;
  const relayMode = spawnMode && file.root === "claude-projects" && file.kind === "субагент";

  const persistSent = (next: SentEntry[]) => {
    setSent(next);
    sessionStorage.setItem(sentKey(file.path), JSON.stringify(next));
  };

  const addFiles = (files: File[]) => {
    const picks = files.filter((entry) => entry.type.startsWith("image/"));
    if (!picks.length) return;
    Promise.all(picks.map(readImage))
      .then((pending) => {
        setImages((prev) => [...prev, ...pending]);
        setStatus(null);
      })
      .catch((error: unknown) => {
        setStatus({ kind: "err", text: error instanceof Error ? error.message : "помилка картинки" });
      });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const picks = Array.from(event.clipboardData.items)
      .filter((entry) => entry.type.startsWith("image/"))
      .map((entry) => entry.getAsFile())
      .filter((entry): entry is File => entry !== null);
    if (!picks.length) return;
    event.preventDefault();
    addFiles(picks);
  };

  const send = async () => {
    if (sending || (!text.trim() && !images.length)) return;
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pid: file.pid ?? undefined,
          path: file.path,
          text,
          images: images.map((image) => ({ base64: image.base64, mime: image.mime })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; imagePaths?: string[]; target?: string; spawned?: boolean };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося надіслати" });
        return;
      }
      const imgCount = images.length;
      const entry: SentEntry = {
        id: Date.now(),
        text: text.trim() || (imgCount ? `${imgCount} ${imgCount === 1 ? "картинка" : "картинки"}` : ""),
        at: Date.now(),
        via: json.spawned ? "spawn" : "pane",
      };
      persistSent([...sent, entry].slice(-SENT_LIMIT));
      setText("");
      setImages([]);
      setStatus({
        kind: "ok",
        text: json.spawned
          ? `запущено агента в tmux ${json.target ?? ""}`
          : json.imagePaths?.length
            ? `надіслано ${json.imagePaths.length} шлях(и)`
            : "надіслано",
      });
      inputRef.current?.focus();
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send();
  };

  const canSend = !sending && (Boolean(text.trim()) || images.length > 0);

  return (
    <form
      onSubmit={handleSubmit}
      className="flex shrink-0 flex-col gap-1 border-t border-line bg-[#fbfbfd] px-2.5 py-1.5"
      aria-label={spawnMode ? "Запустити агента з промптом у tmux" : `Надіслати повідомлення агенту в tmux ${target}`}
    >
      {sent.length ? (
        <div className="flex flex-col gap-0.5" aria-label="Черга надісланих повідомлень">
          {sent.map((entry) => (
            <div key={entry.id} className="flex items-center justify-end gap-1.5">
              <span
                className="min-w-0 max-w-[85%] truncate rounded-[10px] rounded-br-[3px] bg-[#ecebfb] px-2 py-0.5 text-[11px] text-[#333]"
                title={entry.text}
              >
                {entry.text}
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[9.5px] text-dim">
                {entry.via === "spawn" ? <Play className="h-2.5 w-2.5" aria-hidden /> : <ArrowRight className="h-2.5 w-2.5" aria-hidden />}
                {hhmm(entry.at)}
              </span>
              <button
                type="button"
                aria-label="Прибрати з черги"
                className="inline-flex shrink-0 items-center rounded px-0.5 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                onClick={() => persistSent(sent.filter((item) => item.id !== entry.id))}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-chip px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-[#555]"
          title={relayMode ? "передасться через кореневу сесію гілки" : spawnMode ? "нове tmux-вікно з відновленим агентом" : `tmux ${target}`}
        >
          {relayMode ? (
            <>
              <ArrowUpToLine className="h-3 w-3" aria-hidden /> корінь
            </>
          ) : spawnMode ? (
            <>
              <Play className="h-3 w-3" aria-hidden /> resume
            </>
          ) : (
            <>
              <SquareTerminal className="h-3 w-3" aria-hidden /> {target}
            </>
          )}
        </span>
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={handlePaste}
          placeholder={relayMode ? "написати — передам через кореневу сесію…" : spawnMode ? "промпт — агент запуститься в tmux…" : "написати агенту…"}
          aria-label="Текст для агента"
          disabled={sending}
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-panel px-2 py-1 text-[12px] text-[#222] placeholder:text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <MicButton
          onText={(spoken) => {
            setText(text ? text.trimEnd() + " " + spoken : spoken);
            setStatus(null);
            inputRef.current?.focus();
          }}
          onError={(message) => setStatus({ kind: "err", text: message })}
        />
        <button
          type="button"
          aria-label="Додати картинки"
          onClick={() => fileRef.current?.click()}
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-panel px-2 py-1 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <ImageIcon className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="submit"
          disabled={!canSend}
          aria-label={spawnMode ? "Запустити агента" : "Надіслати агенту"}
          className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-accent px-2.5 py-1 text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {images.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {images.map((image, idx) => (
            <div key={idx} className="group/img relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.preview} alt={`прев'ю картинки ${idx + 1}`} className="h-10 w-10 rounded border border-line object-cover" />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, i) => i !== idx))}
                aria-label={`Прибрати картинку ${idx + 1}`}
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-line bg-panel text-dim shadow-card hover:text-err group-hover/img:flex focus-visible:flex focus-visible:outline-none"
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            </div>
          ))}
          <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-dim">
            {images.length} {images.length === 1 ? "картинка" : "картинки"} <ArrowRight className="h-3 w-3" aria-hidden /> шляхами до файлів
          </span>
        </div>
      ) : null}
      {status ? (
        <span className={`truncate text-[10.5px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
          {status.text}
        </span>
      ) : null}
    </form>
  );
}
