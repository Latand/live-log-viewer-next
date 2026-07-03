"use client";

import type { FileEntry } from "@/lib/types";

function activityText(file: FileEntry): string {
  if (file.activity === "live") return ", працює";
  if (file.activity === "recent") return ", закінчив";
  return "";
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
        {rollout ? (
          <>
            <div className="mb-2 whitespace-pre-line text-[13.5px] font-semibold">
              Це короткий джоб-лог (лише службові події). Реальна робота Codex — у повній сесії:
            </div>
            <button
              className="rounded-[10px] border border-line bg-bg px-3 py-1.5 text-[13px] font-semibold text-codex hover:bg-codex-soft"
              onClick={() => onSelect(rollout)}
            >
              ⌘ Відкрити сесію Codex ({(rollout.size / 1024).toFixed(0)} kB{activityText(rollout)})
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
