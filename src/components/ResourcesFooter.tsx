"use client";

import { startTransition, useEffect, useRef, useState } from "react";

import { createFreshAwareCoalescer } from "@/lib/asyncCoalescer";
import { useLocale } from "@/lib/i18n";
import type { ResourceSession, ResourcesPayload } from "@/lib/types";

import { X } from "./icons";
import { AttachControls } from "./resources/AttachControls";
import { bulkKillTargets, idleKillTargets, isStructuredHost, resourceCounts } from "./resources/hostSelection";
import { activityDot, engineTintOf, fmtAge } from "./utils";

const POLL_MS = 30_000;
const INITIAL_POLL_DELAY_MS = 1_500;
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
  if (availablePercent < 10) return "var(--color-danger)";
  if (availablePercent < 30) return "var(--color-warning)";
  return "var(--color-muted)";
}

function swapColor(usedPercent: number): string {
  if (usedPercent > 85) return "var(--color-danger)";
  if (usedPercent > 60) return "var(--color-warning)";
  return "var(--color-muted)";
}

function MemoryRow({ label, usedPercent, color, note }: { label: string; usedPercent: number; color: string; note: string }) {
  const width = Math.max(1.5, Math.min(100, usedPercent));
  return (
    <div className="mt-1.5 first:mt-0">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold text-primary">{label}</span>
        <span className="text-[11px] tabular-nums text-muted">{note}</span>
      </div>
      <div className="mt-1 h-[4px] overflow-hidden rounded-full bg-sunken">
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

type ResourcesFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** One request channel for initial load, polling, and post-kill refreshes.
    Polls share an active request. A forced refresh waits for the active poll
    and then requests a fresh server snapshot. */
export function createResourcesLoader(
  fetcher: ResourcesFetcher,
  onPayload: (payload: ResourcesPayload, at: number) => void,
  onFailure: (at: number) => void,
) {
  const requests = createFreshAwareCoalescer<boolean>();
  const controller = new AbortController();
  let disposed = false;

  return {
    load(fresh = false): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      return requests.run(fresh, async (forceFresh) => {
        /* A fresh call may have waited behind an ordinary poll. Teardown can
           happen while it waits, so check again before starting another scan. */
        if (disposed) return false;
        const at = Date.now() / 1000;
        try {
          const res = await fetcher("/api/resources" + (forceFresh ? "?fresh=1" : ""), { signal: controller.signal });
          if (!res.ok) throw new Error(String(res.status));
          const json = (await res.json()) as ResourcesPayload;
          if (!disposed) onPayload(json, at);
          return true;
        } catch {
          if (!disposed) onFailure(at);
          return false;
        }
      });
    },
    dispose(): void {
      disposed = true;
      controller.abort();
    },
  };
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
    let disposed = false;
    const loader = createResourcesLoader(
      fetch,
      (json, at) => {
        startTransition(() => {
          if (!disposed) setSnap((prev) => stickySnap(prev, json, at));
        });
      },
      (at) => {
        startTransition(() => {
          if (!disposed) setSnap((prev) => (prev ? { ...prev, staleSince: prev.staleSince ?? at } : prev));
        });
      },
    );
    const load = async (fresh = false) => {
      await loader.load(fresh);
    };
    loadRef.current = load;
    /* Board, limits and presence mount in the same frame. Starting this probe
       slightly later keeps their first responses and recurring work out of one
       main-thread burst. Reschedule after completion so later polls retain the
       separation instead of snapping back to the page-load clock. */
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await load();
      if (!disposed) timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), INITIAL_POLL_DELAY_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      loader.dispose();
      loadRef.current = async () => {};
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
    <div ref={panelRef} className="relative shrink-0 border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("resources.openAria")}
        onClick={() => setOpen((value) => !value)}
        className="block w-full px-3.5 pb-2.5 pt-2 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {snap.staleSince ? (
          <span
            className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-warning"
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
            <span className="mt-1.5 block text-right text-[9.5px] tabular-nums text-muted">
              {t("resources.captured", { age: fmtAge(Date.parse(system.capturedAt) / 1000) })}
            </span>
          </>
        ) : (
          <span className="text-[11px] font-semibold text-primary">{t("resources.title")}</span>
        )}
      </button>
      {open ? (
        <CleanupPanel sessions={sessions} now={snap.at} onRefresh={() => loadRef.current(true)} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

/** Kills one row, on whichever transport owns it, for one named gesture.
    A structured host goes to /api/runtime/hosts, which ends it through the
    runtime when it still holds it and by process group otherwise, then retires
    the registry row. A tmux pane keeps the kill-target action: the server
    resolves the stable pane id recorded in the snapshot and verifies the pane
    pid before killing, so the kill survives window renumbering mid-bulk.
    Both sides refuse a target the last snapshot did not list.
    Returns the error text, if any. */
async function killSession(
  session: ResourceSession,
  gesture: { intent: "row" | "idle" | "all"; includeSeat: boolean; idleHours?: number },
): Promise<string | null> {
  const res = isStructuredHost(session)
    ? await fetch("/api/runtime/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "kill",
          target: session.target,
          /* The gesture travels with the request: the server re-reads the
             promises it makes (settled turn, quiet transcript, untouched
             orchestrator seat) instead of trusting the polled snapshot. */
          intent: gesture.intent,
          includeSeat: gesture.includeSeat,
          ...(gesture.intent === "idle" ? { idleHours: gesture.idleHours } : {}),
        }),
      })
    : await fetch("/api/tmux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "kill-target", target: session.target }),
      });
  if (res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error ?? String(res.status);
}

/** The "Agent sessions" dialog. Exported for the DOM test, which drives the
    rows and the bulk buttons without waiting on the rail's poll. */
export function CleanupPanel({
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
  /* The nuke: a two-step arm before it force-kills every agent host, live ones
     included. Any other kill action disarms it, so a stray tap can't fire it. */
  const [killAllArmed, setKillAllArmed] = useState(false);
  const [killAllBusy, setKillAllBusy] = useState(false);
  /* Orchestrator seats the operator ticked into the bulk kills. The server asks
     for the same opt-in per kill, so an untouched seat survives either way. */
  const [tickedSeats, setTickedSeats] = useState<Set<string>>(new Set());

  const markBusy = (target: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(target);
      else next.delete(target);
      return next;
    });

  const killOne = async (session: ResourceSession) => {
    setError(null);
    setKillAllArmed(false);
    markBusy(session.target, true);
    try {
      /* A per-row kill is the explicit gesture the seat rule asks for. */
      const failure = await killSession(session, { intent: "row", includeSeat: true });
      if (failure) setError(failure);
      await onRefresh();
    } finally {
      markBusy(session.target, false);
      setArmed(null);
    }
  };

  const killEach = async (targets: ResourceSession[], intent: "idle" | "all", idleHours?: number) => {
    for (const session of targets) {
      markBusy(session.target, true);
      const failure = await killSession(session, {
        intent,
        includeSeat: tickedSeats.has(session.target),
        ...(idleHours === undefined ? {} : { idleHours }),
      });
      if (failure) setError(failure);
    }
    await onRefresh();
  };

  const killBulk = async () => {
    const targets = idleKillTargets(sessions, bulkHours, now, tickedSeats);
    if (targets.length === 0 || bulkBusy) return;
    setError(null);
    setKillAllArmed(false);
    setBulkBusy(true);
    try {
      await killEach(targets, "idle", bulkHours);
    } finally {
      setBusy(new Set());
      setBulkBusy(false);
    }
  };

  /* Force-kills every listed host, live included — the clean-slate nuke.
     Sequential, like killBulk, so window renumbering between kills never
     misaddresses a pane (each kill re-verifies the recorded pane pid or host
     identity server-side). Only the viewer's own hosts are in this list, so
     work shells, the viewer, the runtime host and the account-migration
     workers are never in reach; a live orchestrator seat needs its tick. */
  const killAll = async () => {
    const targets = bulkKillTargets(sessions, tickedSeats);
    if (targets.length === 0 || killAllBusy) return;
    setError(null);
    setKillAllBusy(true);
    try {
      await killEach(targets, "all");
    } finally {
      setBusy(new Set());
      setKillAllBusy(false);
      setKillAllArmed(false);
    }
  };

  const toggleSeat = (target: string) =>
    setTickedSeats((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });

  const counts = resourceCounts(sessions, bulkHours, now);
  const bulkCount = idleKillTargets(sessions, bulkHours, now, tickedSeats).length;
  const killAllCount = bulkKillTargets(sessions, tickedSeats).length;

  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex w-[min(430px,calc(100vw-16px))] -translate-x-1/2 flex-col rounded-[12px] border border-border bg-card shadow-2 sm:absolute sm:bottom-1 sm:left-full sm:ml-2 sm:translate-x-0">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[12.5px] font-bold">{t("resources.title")}</span>
        {sessions.length ? (
          <span className="text-[11px] tabular-nums text-muted" data-testid="resources-counts">
            {t("resources.hostsN", { count: counts.hosts })}
            {" · "}
            {t("resources.idleN", { n: counts.idle })}
            {" · "}
            {t("resources.total", { amount: fmtBytes(counts.bytes) })}
          </span>
        ) : null}
        <button
          type="button"
          aria-label={t("resources.close")}
          onClick={onClose}
          className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-[6px] p-1 text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </header>
      <div className="max-h-[min(420px,60vh)] overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">{t("resources.empty")}</div>
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.target}
              session={session}
              busy={busy.has(session.target)}
              armed={armed === session.target}
              seatTicked={tickedSeats.has(session.target)}
              onToggleSeat={() => toggleSeat(session.target)}
              onArm={() => setArmed(session.target)}
              onKill={() => void killOne(session)}
              onRefresh={onRefresh}
            />
          ))
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-[11px] text-muted">{t("resources.bulkLabel")}</span>
        <select
          value={bulkHours}
          onChange={(event) => setBulkHours(Number(event.target.value) as (typeof BULK_HOURS)[number])}
          className="min-h-[44px] min-w-[44px] rounded-[8px] border border-border bg-canvas px-1.5 py-1 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:min-w-0"
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
          className="ml-auto inline-flex min-h-[44px] items-center rounded-[8px] border border-danger/40 px-2.5 py-1 text-[11px] font-semibold text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 sm:min-h-0"
        >
          {t("resources.bulkKill")}
          {bulkCount ? ` (${bulkCount})` : ""}
        </button>
      </footer>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="text-[13px] leading-none text-danger" aria-hidden>
          ⚠
        </span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted" title={t("resources.killAllHint")}>
          {t("resources.killAllHint")}
        </span>
        <button
          type="button"
          disabled={killAllBusy || killAllCount === 0}
          title={killAllCount === 0 ? t("resources.killAllNone") : t("resources.killAllHint")}
          onClick={() => (killAllArmed ? void killAll() : setKillAllArmed(true))}
          className={[
            "inline-flex min-h-[44px] shrink-0 items-center rounded-[8px] border px-2.5 py-1 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-0",
            killAllArmed ? "border-danger bg-danger text-white" : "border-danger/40 text-danger hover:bg-danger/10",
          ].join(" ")}
        >
          {killAllArmed
            ? t("resources.killAllConfirm", { n: killAllCount })
            : t("resources.killAll") + (killAllCount ? ` (${killAllCount})` : "")}
        </button>
      </div>
      {error ? <div className="border-t border-border px-3 py-1.5 text-[11px] font-semibold text-danger">{error}</div> : null}
    </div>
  );
}

/** Last two path segments — enough to recognize a worktree or project dir. */
function tailPath(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || dir;
}

/** Badge copy for the ownership the payload reported. */
const OWNERSHIP_COPY = {
  owned: { label: "resources.hostOwned", hint: "resources.hostOwnedHint", tone: "border-border text-muted" },
  released: { label: "resources.hostReleased", hint: "resources.hostReleasedHint", tone: "border-warning/50 text-warning" },
  orphaned: { label: "resources.hostOrphaned", hint: "resources.hostOrphanedHint", tone: "border-danger/50 text-danger" },
} as const;

function SessionRow({
  session,
  busy,
  armed,
  seatTicked,
  onToggleSeat,
  onArm,
  onKill,
  onRefresh,
}: {
  session: ResourceSession;
  busy: boolean;
  armed: boolean;
  seatTicked: boolean;
  onToggleSeat: () => void;
  onArm: () => void;
  onKill: () => void;
  /** Re-poll the snapshot — the attach control's stale-pane recovery. */
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLocale();
  const tint = engineTintOf(session.engine ?? "");
  const structured = isStructuredHost(session);
  const live = session.activity === "live" || session.turnBusy === true;
  const hostConflict = session.hostConflict === true;
  const lastActive = session.lastActiveAt !== null ? Date.parse(session.lastActiveAt) / 1000 : null;
  const ownership = session.ownership ? OWNERSHIP_COPY[session.ownership] : null;
  /* Role, stage and model are what tell two lanes of the same pipeline apart;
     the project and the idle age follow, as they did for panes. */
  const detail = [
    session.role,
    session.stage,
    session.model,
    session.project,
  ].filter((value): value is string => Boolean(value));
  /* Live rows keep the kill button locked; the first click only arms it and a
     second, now-red click actually kills — a guard against taking down an
     agent mid-turn with one stray tap. */
  const needsArm = live && !armed;
  return (
    <div className="px-3 py-1.5 hover:bg-canvas" data-testid={structured ? "resource-host-row" : "resource-pane-row"} data-target={session.target}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${activityDot(session.activity ?? "idle")}`} />
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
          style={{ backgroundColor: tint.soft, color: tint.color }}
        >
          {session.engine === "codex" ? "Codex" : session.engine === "claude" ? "Claude" : "?"}
        </span>
        <span
          className="min-w-0 flex-1"
          title={[session.cwd, session.target, t("resources.procs", { count: session.procCount })].filter(Boolean).join(" · ")}
        >
          <span className="block truncate text-[12px] font-semibold">
            {hostConflict
              ? t("resources.hostConflict")
              : session.title ?? (session.cwd ? tailPath(session.cwd) : t(structured ? "resources.hostUntitled" : "resources.orphan"))}
          </span>
          <span className="block truncate text-[10.5px] text-muted">
            {hostConflict
              ? t("resources.hostConflictHint") + " · "
              : structured
                ? (detail.length ? detail.join(" · ") + " · " : "")
                : session.title === null ? t("resources.orphan") + " · " : session.project ? session.project + " · " : ""}
            {lastActive !== null ? fmtAge(lastActive) : session.target}
            {session.turnBusy === true ? " · " + t("resources.hostBusy") : ""}
          </span>
        </span>
        {ownership ? (
          <span
            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-semibold ${ownership.tone}`}
            title={t(ownership.hint)}
          >
            {t(ownership.label)}
          </span>
        ) : null}
        {session.seat === true ? (
          <label className="flex shrink-0 items-center gap-1 text-[9.5px] font-semibold text-muted" title={t("resources.hostSeatTick")}>
            <input
              type="checkbox"
              checked={seatTicked}
              onChange={onToggleSeat}
              aria-label={t("resources.hostSeatTick")}
              className="h-3 w-3 accent-[var(--color-danger)]"
            />
            {t("resources.hostSeat")}
          </label>
        ) : structured && (session.seat === null || session.seat === undefined) ? (
          <span
            className="shrink-0 rounded-full border border-warning/50 px-1.5 py-0.5 text-[9.5px] font-semibold text-warning"
            title={t("resources.hostSeatUnknownHint")}
          >
            {t("resources.hostSeatUnknown")}
          </span>
        ) : null}
        <span className="shrink-0 text-right">
          <span className="block text-[11.5px] font-bold tabular-nums">{fmtBytes(session.rssBytes)}</span>
          {session.swapBytes > 0 ? (
            <span className="block text-[10px] tabular-nums text-muted">
              {t("resources.swapShare", { amount: fmtBytes(session.swapBytes) })}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          disabled={busy}
          aria-disabled={needsArm || busy}
          title={live ? t("resources.killLiveHint") : t(structured ? "resources.killHostHint" : "resources.killHint")}
          onClick={() => (needsArm ? onArm() : onKill())}
          className={[
            "inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-[8px] border px-2 py-1 text-[11px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 sm:min-h-0 sm:min-w-0",
            busy ? "cursor-wait opacity-50" : "",
            armed
              ? "border-danger bg-danger text-white"
              : needsArm
                ? "border-border text-muted opacity-60 hover:opacity-90"
                : "border-danger/40 text-danger hover:bg-danger/10",
          ].join(" ")}
        >
          {armed ? t("resources.confirm") : t("resources.kill")}
        </button>
      </div>
      {/* Attaching means attaching to a tmux pane; a structured host has none. */}
      {structured ? null : <AttachControls target={session.target} onRefresh={() => void onRefresh()} />}
    </div>
  );
}
