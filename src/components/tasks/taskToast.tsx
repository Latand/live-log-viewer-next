"use client";

import { useEffect, useState } from "react";

import { X } from "@/components/icons";
import { cleanTitle } from "@/components/utils";
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

/** «Доставлено 2 з 3; ✗ „title“: помилка» — the partial-delivery breakdown. */
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

/** Bottom-center toast stack; mounted once per dashboard surface. */
export function TaskToastHost() {
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
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-50 flex flex-col items-center gap-1.5 px-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex max-w-[560px] items-start gap-2 rounded-[10px] border px-3 py-2 text-[11.5px] font-semibold shadow-[0_10px_36px_rgb(20_20_30/0.18)] ${
            toast.kind === "ok" ? "border-ok/40 bg-[#eef8f0] text-[#1c6b30]" : "border-err/40 bg-[#fdf0f0] text-[#8f2525]"
          }`}
        >
          <span className="min-w-0 break-words">{toast.text}</span>
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label={translate(getLocale(), "viewer.closeNotification")}
            onClick={() => setToasts((prev) => prev.filter((item) => item.id !== toast.id))}
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
