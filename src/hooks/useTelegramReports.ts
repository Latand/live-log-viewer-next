"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TelegramReportPromptPayload, TelegramReportSettings, TelegramReportsPayload } from "@/lib/telegram/reportContracts";

/**
 * Client state for the Daily Report section of the Telegram panel (#1086).
 *
 * Same shape as `useTelegramConnection`: one payload, one busy flag, thin
 * actions that re-sync from the server's returned state. The two things that
 * can carry the operator's Telegram content — a report BODY and the analyst
 * PROMPT — are fetched on demand and held apart from the list, so the poll
 * never carries either.
 */

const POLL_MS = 20_000;

export type TelegramReportsFailure = { code: string };

export type TelegramReportsState = {
  reports: TelegramReportsPayload | null;
  busy: boolean;
  failure: TelegramReportsFailure | null;
  /** Report body currently open, or `null` when the list is showing. */
  openReport: { id: string; text: string } | null;
  refresh(): Promise<void>;
  saveSettings(settings: TelegramReportSettings): Promise<void>;
  runNow(): Promise<void>;
  openReportById(id: string): Promise<void>;
  closeReport(): void;
  /** Group titles for the source picker; loaded on demand. */
  groups: { id: string; title: string }[] | null;
  loadGroups(): Promise<void>;
  /** The analyst prompt while its editor is open, with the shipped default
      beside it so "reset" needs no second request. */
  ["prompt"]: TelegramReportPromptPayload | null;
  loadPrompt(): Promise<void>;
  savePrompt(prompt: string): Promise<void>;
  closePrompt(): void;
};

async function readJson(response: Response): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: response.ok, json };
}

function codeOf(json: Record<string, unknown>): string {
  return typeof json.code === "string" && /^[a-z_-]{1,40}$/.test(json.code) ? json.code : "action_failed";
}

export function useTelegramReports(active: boolean): TelegramReportsState {
  const [reports, setReports] = useState<TelegramReportsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TelegramReportsFailure | null>(null);
  const [openReport, setOpenReport] = useState<{ id: string; text: string } | null>(null);
  const [groups, setGroups] = useState<{ id: string; title: string }[] | null>(null);
  const [prompt, setPrompt] = useState<TelegramReportPromptPayload | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const { ok, json } = await readJson(await fetch("/api/telegram/reports"));
      if (current !== sequence.current) return;
      if (ok && json.reports) setReports(json.reports as TelegramReportsPayload);
      else setFailure({ code: codeOf(json) });
    } catch {
      if (current === sequence.current) setFailure({ code: "transport" });
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await load();
      if (disposed) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, load]);

  /* Returns the OUTCOME, not just the body: an action that only knows the
     payload cannot tell a rejected save from an accepted one, and would report
     success the server never gave. */
  const act = useCallback(async (body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> }> => {
    sequence.current += 1;
    setBusy(true);
    setFailure(null);
    try {
      const { ok, json } = await readJson(await fetch("/api/telegram/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      sequence.current += 1;
      if (json.reports) setReports(json.reports as TelegramReportsPayload);
      if (!ok) setFailure({ code: codeOf(json) });
      return { ok, json };
    } catch {
      sequence.current += 1;
      setFailure({ code: "transport" });
      return { ok: false, json: {} };
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    reports,
    busy,
    failure,
    openReport,
    groups,
    prompt,
    refresh: load,
    saveSettings: async (settings) => { await act({ action: "settings", settings }); },
    loadPrompt: async () => {
      setBusy(true);
      setFailure(null);
      try {
        const { ok, json } = await readJson(await fetch("/api/telegram/reports?prompt=1"));
        if (ok && typeof json.prompt === "string" && typeof json.defaultPrompt === "string") {
          setPrompt({ prompt: json.prompt, defaultPrompt: json.defaultPrompt });
        } else setFailure({ code: codeOf(json) });
      } catch {
        setFailure({ code: "transport" });
      } finally {
        setBusy(false);
      }
    },
    /* A save the server accepted closes the editor, and that return to the
       settings view — where the prompt row now reads "edited by you" or "default
       template" from the payload the save just returned — is the acknowledgement.
       A save it REJECTED keeps the editor open with the operator's text still in
       the textarea and the failure banner above it, so the next run can never
       quietly use the old brief. Reopening the editor re-reads the stored text,
       which is what makes a server-side truncation visible. */
    savePrompt: async (next) => {
      const current = reports?.settings;
      if (!current) return;
      const { ok } = await act({ action: "settings", settings: current, prompt: next });
      if (ok) setPrompt(null);
    },
    closePrompt: () => setPrompt(null),
    runNow: async () => { await act({ action: "run-now" }); },
    loadGroups: async () => {
      const { json } = await act({ action: "groups" });
      if (Array.isArray(json.groups)) setGroups(json.groups as { id: string; title: string }[]);
    },
    openReportById: async (id) => {
      setBusy(true);
      setFailure(null);
      try {
        const { ok, json } = await readJson(await fetch(`/api/telegram/reports?report=${encodeURIComponent(id)}`));
        if (ok && typeof json.report === "string") setOpenReport({ id, text: json.report });
        else setFailure({ code: codeOf(json) });
      } catch {
        setFailure({ code: "transport" });
      } finally {
        setBusy(false);
      }
    },
    closeReport: () => setOpenReport(null),
  };
}
