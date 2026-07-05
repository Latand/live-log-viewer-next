"use client";

import { cleanTitle } from "@/components/utils";
import { getLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

export interface BroadcastImage {
  base64: string;
  mime: string;
}

/** One `/api/tmux` delivery; returns null on success, the error otherwise. */
export async function tmuxSend(file: FileEntry, text: string, images: BroadcastImage[]): Promise<string | null> {
  try {
    const res = await fetch("/api/tmux", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: file.pid ?? undefined, path: file.path, text, images }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !json?.ok) return json?.error ?? translate(getLocale(), "common.failedSend");
    return null;
  } catch {
    return translate(getLocale(), "common.serverUnavailable");
  }
}

/** «Доставлено 2 з 3; ✗ „title“: помилка» over a client-side tmux loop. */
export function broadcastSummary(targets: FileEntry[], errors: (string | null)[]): { kind: "ok" | "err"; text: string } {
  const locale = getLocale();
  const delivered = errors.filter((error) => error === null).length;
  const head = translate(locale, "tasks.sendOk", { delivered, total: targets.length });
  if (delivered === targets.length) return { kind: "ok", text: head };
  const failures = targets
    .map((file, index) => ({ file, error: errors[index] }))
    .filter((item) => item.error)
    .map((item) => translate(locale, "tasks.sendFailPart", { title: cleanTitle(item.file.title, 40), error: item.error ?? "" }));
  return { kind: "err", text: `${head}; ${failures.join("; ")}` };
}
