"use client";

import { useEffect, useState } from "react";

import { X } from "@/components/icons";
import { cleanTitle } from "@/components/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import type { TaskSendResult } from "./taskApi";

export interface TaskToast {
  id: number;
  kind: "ok" | "err";
  text: string;
}

const TOAST_MS = 6000;

let seq = 0;
const listeners = new Set<(toast: TaskToast) => void>();

/** Fire-and-forget notification; the host renders and auto-dismisses it. */
export function pushTaskToast(kind: TaskToast["kind"], text: string): void {
  const toast = { id: ++seq, kind, text };
  for (const listener of listeners) listener(toast);
}

/** «Delivered 2 of 3; ✗ "title": error» — the partial-delivery breakdown. */
export function sendSummary(result: TaskSendResult, files: readonly FileEntry[]): { kind: TaskToast["kind"]; text: string } {
  const locale = getLocale();
  const total = result.results.length;
  const head = translate(locale, "tasks.sendOk", { delivered: result.delivered, total });
  if (!result.failed) return { kind: "ok", text: head };
  const byPath = new Map(files.map((file) => [file.path, file]));
  const failures = result.results
    .filter((item) => !item.ok)
    .map((item) => {
      const file = byPath.get(item.path);
      const title = file ? cleanTitle(file.title, 40) : (item.path.split("/").pop() ?? item.path);
      return translate(locale, "tasks.sendFailPart", { title, error: item.error ?? "" });
    });
  return { kind: "err", text: `${head}; ${failures.join("; ")}` };
}

/** Toast stack; mounted once per dashboard surface. On desktop it floats
    bottom-center over the board; on the phone (finding 7) it docks in normal
    flow at the bottom of the board column — below the interactive worker /
    quiet-conversation rows — so it reserves its own space and never covers
    transcript content or those rows. */
export function TaskToastHost() {
  const isMobile = useIsMobile();
  const [toasts, setToasts] = useState<TaskToast[]>([]);
  useEffect(() => {
    const onToast = (toast: TaskToast) => {
      setToasts((prev) => [...prev.slice(-3), toast]);
      window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== toast.id)), TOAST_MS);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);
  if (!toasts.length) return null;
  return (
    <div
      className={
        isMobile
          ? "z-50 flex shrink-0 flex-col gap-1.5 border-t border-line bg-panel px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          : "pointer-events-none absolute inset-x-0 bottom-14 z-50 flex flex-col items-center gap-1.5 px-3"
      }
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[11.5px] font-semibold shadow-[0_10px_36px_rgb(20_20_30/0.18)] ${isMobile ? "w-full" : "max-w-[560px]"} ${
            toast.kind === "ok" ? "border-ok/40 bg-[#eef8f0] text-[#1c6b30]" : "border-err/40 bg-[#fdf0f0] text-[#8f2525]"
          }`}
        >
          <span className="min-w-0 flex-1 break-words">{toast.text}</span>
          <button
            type="button"
            className={`shrink-0 rounded opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              isMobile ? "-my-1 -mr-1 flex h-11 w-11 items-center justify-center" : "mt-0.5 p-0.5"
            }`}
            aria-label={translate(getLocale(), "viewer.closeNotification")}
            onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
          >
            <X className={isMobile ? "h-4 w-4" : "h-3 w-3"} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
