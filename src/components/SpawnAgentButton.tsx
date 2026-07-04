"use client";

import { useEffect, useRef, useState } from "react";

import { ImagePickerButton, ImagePreviewStrip, useImageAttachments } from "./imageAttachments";
import { MicButton } from "./MicButton";
import { engineTintOf } from "./utils";

type Engine = "claude" | "codex";

const ENGINES: { key: Engine; label: string }[] = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

function engineStyle(engine: Engine): React.CSSProperties {
  const tint = engineTintOf(engine);
  return { backgroundColor: tint.soft, color: tint.color, borderColor: tint.color };
}

/**
 * Header control that boots a brand-new agent (Claude or Codex) in a fresh
 * tmux window of the user's active session, in a chosen directory, optionally
 * with a first prompt. The new transcript shows up in the tree on its own.
 */
export function SpawnAgentButton({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState<Engine>("claude");
  const [cwd, setCwd] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useImageAttachments({
    onError: (message) => setStatus({ kind: "err", text: message }),
    onAdded: () => setStatus(null),
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/spawn?project=" + encodeURIComponent(project))
      .then((res) => res.json() as Promise<{ dirs?: string[] }>)
      .then((json) => {
        const fetched = json.dirs;
        if (cancelled || !Array.isArray(fetched)) return;
        setDirs(fetched);
        setCwd((prev) => prev || fetched[0] || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const spawn = async () => {
    if (busy || !cwd.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine,
          cwd: cwd.trim(),
          prompt,
          images: attachments.images.map((image) => ({ base64: image.base64, mime: image.mime })),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; target?: string; error?: string };
      if (!res.ok || !json.ok) {
        setStatus({ kind: "err", text: json.error ?? "не вдалося запустити" });
        return;
      }
      setStatus({ kind: "ok", text: `запущено в tmux ${json.target ?? ""} — скоро з'явиться в списку` });
      setPrompt("");
      attachments.clear();
    } catch {
      setStatus({ kind: "err", text: "сервер недоступний" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={panelRef} className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Запустити нового агента"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[11.5px] font-bold text-ink shadow-card hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span className="text-[13px] leading-none text-accent">+</span> Агент
      </button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 flex w-[360px] flex-col gap-2.5 rounded-[12px] border border-line bg-panel p-3 shadow-[0_8px_28px_rgba(20,20,30,0.14)]"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void spawn();
            }
          }}
        >
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Двигун агента">
            {ENGINES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={engine === key}
                onClick={() => setEngine(key)}
                style={engine === key ? engineStyle(key) : undefined}
                className={`flex-1 rounded-[8px] border px-2 py-1.5 text-[12px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  engine === key ? "" : "border-line bg-bg text-dim hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
            директорія
            <input
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              list="spawn-dirs"
              placeholder="/home/…/Projects/…"
              aria-label="Робоча директорія агента"
              className="rounded-[8px] border border-line bg-bg px-2 py-1.5 font-mono text-[11.5px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <datalist id="spawn-dirs">
              {dirs.map((dir) => (
                <option key={dir} value={dir} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-[10.5px] font-semibold text-dim">
            перший промпт (опційно)
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={attachments.handlePaste}
              rows={3}
              placeholder="що зробити… (Ctrl+Enter — запустити)"
              aria-label="Перший промпт для агента"
              className="resize-y rounded-[8px] border border-line bg-bg px-2 py-1.5 text-[12px] font-normal text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </label>
          <ImagePreviewStrip images={attachments.images} onRemove={attachments.removeAt} />
          <div className="flex items-center gap-1.5">
            <MicButton
              onText={(spoken) => {
                setPrompt((prev) => (prev ? prev.trimEnd() + " " + spoken : spoken));
                setStatus(null);
                promptRef.current?.focus();
              }}
              onError={(message) => setStatus({ kind: "err", text: message })}
            />
            <ImagePickerButton
              ariaLabel="Додати картинки до промпта"
              className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-panel px-2 py-1.5 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onFiles={attachments.addFiles}
            />
            <button
              type="button"
              disabled={busy || !cwd.trim()}
              onClick={() => void spawn()}
              className="ml-auto rounded-[8px] border border-accent bg-accent px-3 py-1.5 text-[12px] font-bold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            >
              {busy ? "запускаю…" : "▶ Запустити"}
            </button>
          </div>
          {busy ? <span className="text-[10.5px] text-dim">чекаю, поки CLI підніметься (до хвилини)…</span> : null}
          {status ? (
            <span className={`text-[11px] font-semibold ${status.kind === "ok" ? "text-ok" : "text-err"}`}>{status.text}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
