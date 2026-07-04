"use client";

import { useEffect, useState } from "react";

import { Command, Play } from "@/components/icons";
import type { FileEntry } from "@/lib/types";

function activityText(file: FileEntry): string {
  if (file.activity === "live") return ", працює";
  if (file.activity === "stalled") return ", перервано";
  if (file.activity === "recent") return ", закінчив";
  return "";
}

export function ProcessStatusChip({ file }: { file: FileEntry }) {
  if (file.proc === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#e5f6ea] px-2 py-0.5 text-[11px] font-bold text-ok">
        <Play className="h-3 w-3" aria-hidden /> PID {file.pid}
      </span>
    );
  }
  if (file.proc === "killed" || file.activity === "stalled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#f7e8e8] px-2 py-0.5 text-[11px] font-bold text-err">
        перервано
      </span>
    );
  }
  if (file.proc === "done") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[11px] font-bold text-dim">
        завершено
      </span>
    );
  }
  return null;
}

export function ProcessStatusControls({ file, compact = false }: { file: FileEntry; compact?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [killing, setKilling] = useState(false);
  const [message, setMessage] = useState("");
  const [forceNext, setForceNext] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const chip = <ProcessStatusChip file={file} />;
  const kill = async () => {
    setKilling(true);
    setMessage("");
    try {
      const res = await fetch("/api/proc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: file.path, force: forceNext }),
      });
      const json = (await res.json()) as { ok?: boolean; pid?: number; error?: string };
      if (!res.ok || !json.ok) {
        setMessage(json.error ?? "помилка зупинки");
        setForceNext(true);
        return;
      }
      setMessage(`надіслано ${forceNext ? "SIGKILL" : "SIGTERM"} PID ${json.pid}`);
      setConfirming(false);
    } catch {
      setMessage("сервер недоступний");
      setForceNext(true);
    } finally {
      setKilling(false);
    }
  };

  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-1.5 ${compact ? "text-[10.5px]" : "text-xs"}`}>
      {chip}
      {file.proc === "running" ? (
        confirming ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-[10px] border border-err/30 bg-[#fff5f5] px-1.5 py-0.5">
            {compact ? null : (
              <span className="truncate px-1 text-[11px] font-semibold text-err">Точно вбити PID {file.pid}?</span>
            )}
            <button
              className="rounded-lg bg-err px-2 py-0.5 text-[11px] font-bold text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/50"
              disabled={killing}
              onClick={kill}
            >
              {forceNext ? "SIGKILL" : compact ? `Вбити ${file.pid}` : "Так, вбити"}
            </button>
            <button
              className="rounded-lg border border-line bg-panel px-2 py-0.5 text-[11px] font-semibold text-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => setConfirming(false)}
            >
              {compact ? "Ні" : "Скасувати"}
            </button>
          </span>
        ) : (
          <button
            className="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] font-semibold text-dim hover:border-err/40 hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={`Зупинити процес PID ${file.pid}`}
            onClick={() => setConfirming(true)}
          >
            Вбити
          </button>
        )
      ) : null}
      {message ? <span className="max-w-[220px] truncate text-[11px] font-semibold text-dim">{message}</span> : null}
    </span>
  );
}

export function TaskHeader({
  file,
  files,
  onSelect,
}: {
  file: FileEntry;
  files: FileEntry[];
  onSelect: (file: FileEntry) => void;
}) {
  if (file.root === "codex-jobs") {
    const rollout = files.find((entry) => entry.root === "codex-sessions" && entry.parent === file.path);
    return (
      <div className="mb-4 mt-1 rounded-[14px] border border-line bg-panel px-4 py-3 shadow-card">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <ProcessStatusChip file={file} />
        </div>
        {rollout ? (
          <>
            <div className="mb-2 whitespace-pre-line text-[13.5px] font-semibold">
              Це короткий джоб-лог (лише службові події). Реальна робота Codex — у повній сесії:
            </div>
            <button
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-bg px-3 py-1.5 text-[13px] font-semibold text-codex hover:bg-codex-soft"
              onClick={() => onSelect(rollout)}
            >
              <Command className="h-3.5 w-3.5" aria-hidden /> Відкрити сесію Codex ({(rollout.size / 1024).toFixed(0)} kB{activityText(rollout)})
            </button>
          </>
        ) : (
          <div className="text-[13.5px] text-dim">Це короткий джоб-лог. Повна rollout-сесія Codex ще не з&apos;явилась у списку</div>
        )}
      </div>
    );
  }
  if (file.root !== "claude-tasks") return null;
  return (
    <div className="mb-4 mt-1 rounded-[14px] border border-line bg-panel px-4 py-3 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ProcessStatusChip file={file} />
      </div>
      {file.cmd ? (
        <>
          <div className="mb-1 text-[13.5px] font-semibold">{file.cmdDesc || "Фонова команда"}</div>
          <code className="block whitespace-pre-wrap break-words rounded-lg border border-line bg-[#fafafc] px-2.5 py-2 font-mono text-[12.5px]">
            $ {file.cmd}
          </code>
        </>
      ) : (
        <div className="text-[13.5px] text-dim">Команду, що запустила цю фонову задачу, не знайдено у транскриптах сесії</div>
      )}
    </div>
  );
}
