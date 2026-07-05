"use client";

import { CornerDownRight } from "lucide-react";
import { useMemo } from "react";

import { isChildConversation, isConversation, kidsIndex, projectKey, subtree } from "@/components/projectModel";
import { activityDot, cleanTitle, engineBadge } from "@/components/utils";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/** Conversations of the project a task can be sent to, freshest first. */
export function sendableConversations(files: FileEntry[], project: string): FileEntry[] {
  return files
    .filter((file) => projectKey(file) === project && (isConversation(file) || isChildConversation(file)))
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Checkbox list over the project's conversations, with the «⤷ всім дітям»
 * shortcut on rows that have conversation descendants. Selection state lives
 * in the caller (card popover, mobile sheet).
 */
export function TargetChecklist({
  files,
  project,
  checked,
  onChange,
  maxHeight = 240,
}: {
  files: FileEntry[];
  project: string;
  checked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  maxHeight?: number;
}) {
  const { t } = useLocale();
  const conversations = useMemo(() => sendableConversations(files, project), [files, project]);
  const kids = useMemo(() => kidsIndex(files), [files]);
  const convPaths = useMemo(() => new Set(conversations.map((file) => file.path)), [conversations]);

  const toggle = (path: string) => {
    const next = new Set(checked);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onChange(next);
  };
  const checkChildren = (file: FileEntry) => {
    const next = new Set(checked);
    next.add(file.path);
    for (const child of subtree(file, kids)) if (convPaths.has(child.path)) next.add(child.path);
    onChange(next);
  };

  if (!conversations.length) {
    return <div className="px-1.5 py-2 text-[11px] text-dim">{t("tasks.pickerEmpty")}</div>;
  }
  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto" style={{ maxHeight }}>
      {conversations.map((file) => {
        const badge = engineBadge(file);
        const childCount = subtree(file, kids).filter((entry) => convPaths.has(entry.path)).length;
        return (
          <div key={file.path} className="flex items-center gap-1">
            <label className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-[6px] px-1.5 hover:bg-bg">
              <input type="checkbox" checked={checked.has(file.path)} onChange={() => toggle(file.path)} className="accent-accent" />
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${activityDot(file.activity)}`} />
              <span className="shrink-0 rounded-full px-1.5 text-[9px] font-bold" style={badge.style}>
                {badge.label}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={cleanTitle(file.title)}>
                {cleanTitle(file.title, 46)}
              </span>
            </label>
            {childCount ? (
              <button
                type="button"
                className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-[6px] px-1 text-[10px] font-semibold text-dim hover:bg-bg hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                title={t("tasks.pickerAllChildren")}
                onClick={() => checkChildren(file)}
              >
                <CornerDownRight className="h-3 w-3" aria-hidden /> {childCount}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
