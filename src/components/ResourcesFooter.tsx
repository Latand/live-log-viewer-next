"use client";

import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { ResourceSession, ResourcesPayload } from "@/lib/types";

import { X } from "./icons";
import { activityDot, engineTintOf, fmtAge } from "./utils";

const POLL_MS = 30_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const BULK_HOURS = [2, 6, 12] as const;

function fmtBytes(n: number): string {
  if (n >= 10 * GIB) return Math.round(n / GIB) + " GiB";
  if (n >= GIB) return (n / GIB).toFixed(1) + " GiB";
  return Math.max(0, Math.round(n / MIB)) + " MiB";
}

/** Bar color mirrors the LimitRow thresholds: amber under 30% headroom, red under 10%. */
function ramColor(availablePercent: number): string {
  if (availablePercent < 10) return "#c62828";
  if (availablePercent < 30) return "#d29a2f";
  return "#9a9aa4";
}

function swapColor(usedPercent: number): string {
  if (usedPercent > 85) return "#c62828";
  if (usedPercent > 60) return "#d29a2f";
  return "#9a9aa4";
}

function MemoryRow({ label, usedPercent, color, note }: { label: string; usedPercent: number; color: string; note: string }) {
  const width = Math.max(1.5, Math.min(100, usedPercent));
  return (
    <div className="mt-1.5 first:mt-0">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-ink">{label}</span>
        <span className="text-[11px] tabular-nums text-dim">{note}</span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-chip">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: width + "%", backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/** A poll that failed or lost its system probe keeps the previous numbers on
    screen (same sticky pattern as LimitsFooter), marked stale from the first
    poll that had to lean on them. */
interface ResourcesSnap {
  data: ResourcesPayload;
  at: number;
  staleSince: number | null;
}

function stickySnap(prev: ResourcesSnap | null, next: ResourcesPayload, at: number): ResourcesSnap {
  const carriedSystem = next.system === null && (prev?.data.system ?? null) !== null;
  return {
    data: { system: next.system ?? prev?.data.system ?? null, sessions: next.sessions },
    at,
    staleSince: carriedSystem ? (prev?.staleSince ?? at) : null,
  };
}

/** Rail block above LimitsFooter: RAM/swap pressure bars; clicking it opens
    the per-session cleanup list. */
export function ResourcesFooter() {
  const { t } = useLocale();
  const [snap, setSnap] = useState<ResourcesSnap | null>(null);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  /* The poll lives inside the effect (same shape as LimitsFooter); the ref
     hands the panel a way to force a fresh snapshot right after a kill. */
  const loadRef = useRef<(fresh?: boolean) => Promise<void>>(async () => {});
  useEffect(() => {
    let alive = true;
    const load = async (fresh = false) => {
      const at = Date.now() / 1000;
      try {
        const res = await fetch("/api/resources" + (fresh ? "?fresh=1" : ""));
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as ResourcesPayload;
        if (!alive) return;
        setSnap((prev) => stickySnap(prev, json, at));
      } catch {
        if (alive) setSnap((prev) => (prev ? { ...prev, staleSince: prev.staleSince ?? at } : prev));
      }
    };
    loadRef.current = load;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const system = snap?.data.system ?? null;
  const sessions = snap?.data.sessions ?? [];
  /* No probe ever succeeded and no sessions either: nothing to show. */
  if (!snap || (!system && sessions.length === 0)) return null;

  const ramUsedPct = system ? (100 * (system.ramTotal - system.ramAvailable)) / system.ramTotal : 0;
  const ramAvailPct = system ? (100 * system.ramAvailable) / system.ramTotal : 100;
  const swapUsedPct = system && system.swapTotal > 0 ? (100 * system.swapUsed) / system.swapTotal : 0;

  return (
    <div ref={panelRef} className="relative shrink-0 border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("resources.openAria")}
        onClick={() => setOpen((value) => !value)}
        className="block w-full px-3.5 pb-2.5 pt-2 text-left hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {snap.staleSince ? (
          <span
            className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[#d29a2f]"
            title={t("resources.stale", { stale: fmtAge(snap.staleSince) })}
          />
        ) : null}
        {system ? (
          <>
            <MemoryRow
              label={t("resources.ram")}
              usedPercent={ramUsedPct}
              color={ramColor(ramAvailPct)}
              note={t("resources.free", { amount: fmtBytes(system.ramAvailable) })}
            />
            {system.swapTotal > 0 ? (
              <MemoryRow
                label={t("resources.swap")}
                usedPercent={swapUsedPct}
                color={swapColor(swapUsedPct)}
                note={t("resources.used", { amount: fmtBytes(system.swapUsed) })}
              />
            ) : null}
          </>
        ) : (
          <span className="text-[11px] font-semibold text-ink">{t("resources.title")}</span>
        )}
      </button>
      {open ? (
        <CleanupPanel sessions={sessions} now={snap.at} onRefresh={() => loadRef.current(true)} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

/** Kills one session through the kill-target action; every row — transcript-
    backed and orphan alike — takes this path. The server resolves the target
    to the stable pane id recorded in the resources snapshot and verifies the
    pane pid before killing, so the kill survives window renumbering mid-bulk
    (a transcript-path kill re-resolves display coordinates at kill time and
    can name a different pane after earlier kills shifted window indexes).
    Returns the error text, if any. */
async function killSession(session: ResourceSession): Promise<string | null> {
  const res = await fetch("/api/tmux", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "kill-target", target: session.target }),
  });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error ?? String(res.status);
}

function CleanupPanel({
  sessions,
  now,
  onRefresh,
  onClose,
}: {
  sessions: ResourceSession[];
  /** Unix seconds of the snapshot poll — the render-stable "now" for idle-age math. */
  now: number;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkHours, setBulkHours] = useState<(typeof BULK_HOURS)[number]>(2);
  const [bulkBusy, setBulkBusy] = useState(false);

  const markBusy = (target: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(target);
      else next.delete(target);
      return next;
    });

  const killOne = async (session: ResourceSession) => {
    setError(null);
    markBusy(session.target, true);
    try {
      const failure = await killSession(session);
      if (failure) setError(failure);
      await onRefresh();
    } finally {
      markBusy(session.target, false);
      setArmed(null);
    }
  };

  /* Bulk never touches live rows; orphans (no lastActiveAt) are skipped too —
     with no idle age to compare, "idle longer than N hours" is unprovable. */
  const bulkTargets = (hours: number): ResourceSession[] => {
    const cutoff = (now - hours * 3_600) * 1000;
    return sessions.filter(
      (session) => session.activity !== "live" && session.lastActiveAt !== null && Date.parse(session.lastActiveAt) < cutoff,
    );
  };

  const killBulk = async () => {
    const targets = bulkTargets(bulkHours);
    if (targets.length === 0 || bulkBusy) return;
    setError(null);
    setBulkBusy(true);
    try {
      for (const session of targets) {
        markBusy(session.target, true);
        const failure = await killSession(session);
        if (failure) setError(failure);
      }
      await onRefresh();
    } finally {
      setBusy(new Set());
      setBulkBusy(false);
    }
  };

  const totalBytes = sessions.reduce((sum, session) => sum + session.rssBytes + session.swapBytes, 0);
  const bulkCount = bulkTargets(bulkHours).length;

  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex w-[min(430px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-line bg-panel shadow-[0_8px_28px_rgba(20,20,30,0.14)] sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12.5px] font-bold">{t("resources.title")}</span>
        {sessions.length ? (
          <span className="text-[11px] tabular-nums text-dim">{t("resources.total", { amount: fmtBytes(totalBytes) })}</span>
        ) : null}
        <button
          type="button"
          aria-label={t("resources.close")}
          onClick={onClose}
          className="ml-auto rounded-[6px] p-1 text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className="max-h-[min(420px,60vh)] overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-dim">{t("resources.empty")}</div>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.target}
              session={session}
              busy={busy.has(session.target)}
              armed={armed === session.target}
              onArm={() => setArmed(session.target)}
              onKill={() => void killOne(session)}
            />
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-line px-3 py-2">
        <span className="text-[11px] text-dim">{t("resources.bulkLabel")}</span>
        <select
          value={bulkHours}
          onChange={(event) => setBulkHours(Number(event.target.value) as (typeof BULK_HOURS)[number])}
          className="rounded-[8px] border border-line bg-bg px-1.5 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          {BULK_HOURS.map((hours) => (
            <option key={hours} value={hours}>
              {t("resources.hoursN", { n: hours })}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={bulkBusy || bulkCount === 0}
          title={bulkCount === 0 ? t("resources.bulkNone") : undefined}
          onClick={() => void killBulk()}
          className="ml-auto rounded-[8px] border border-err/40 px-2.5 py-1 text-[11px] font-semibold text-err hover:bg-err/10 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/40"
        >
          {t("resources.bulkKill")}
          {bulkCount ? ` (${bulkCount})` : ""}
        </button>
      </footer>
      {error ? <div className="border-t border-line px-3 py-1.5 text-[11px] font-semibold text-err">{error}</div> : null}
    </div>
  );
}

function SessionRow({
  session,
  busy,
  armed,
  onArm,
  onKill,
}: {
  session: ResourceSession;
  busy: boolean;
  armed: boolean;
  onArm: () => void;
  onKill: () => void;
}) {
  const { t } = useLocale();
  const tint = engineTintOf(session.engine ?? "");
  const live = session.activity === "live";
  const lastActive = session.lastActiveAt !== null ? Date.parse(session.lastActiveAt) / 1000 : null;
  /* Live rows keep the kill button locked; the first click only arms it and a
     second, now-red click actually kills — a guard against taking down an
     agent mid-turn with one stray tap. */
  const needsArm = live && !armed;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg">
      <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(session.activity ?? "idle")}`} />
      <span
        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
        style={{ backgroundColor: tint.soft, color: tint.color }}
      >
        {session.engine === "codex" ? "Codex" : session.engine === "claude" ? "Claude" : "?"}
      </span>
      <span className="min-w-0 flex-1" title={`${session.target} · ${t("resources.procs", { count: session.procCount })}`}>
        <span className="block truncate text-[12px] font-semibold">
          {session.title ?? t("resources.orphan")}
        </span>
        <span className="block truncate text-[10.5px] text-dim">
          {session.project ? session.project + " · " : ""}
          {lastActive !== null ? fmtAge(lastActive) : session.target}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-[11.5px] font-bold tabular-nums">{fmtBytes(session.rssBytes)}</span>
        {session.swapBytes > 0 ? (
          <span className="block text-[10px] tabular-nums text-dim">
            {t("resources.swapShare", { amount: fmtBytes(session.swapBytes) })}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        disabled={busy}
        aria-disabled={needsArm || busy}
        title={live ? t("resources.killLiveHint") : t("resources.killHint")}
        onClick={() => (needsArm ? onArm() : onKill())}
        className={[
          "shrink-0 rounded-[8px] border px-2 py-1 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/40",
          busy ? "cursor-wait opacity-50" : "",
          armed
            ? "border-err bg-err text-white"
            : needsArm
              ? "border-line text-dim opacity-60 hover:opacity-90"
              : "border-err/40 text-err hover:bg-err/10",
        ].join(" ")}
      >
        {armed ? t("resources.confirm") : t("resources.kill")}
      </button>
    </div>
  );
}
