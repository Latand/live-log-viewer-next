"use client";

const POLL_MS = 5_000;
const MAX_REQS = 64;

export type TmuxBusResult = string | null | { transportError: true };

export interface TmuxSubscriber {
  pid: number | null;
  path: string;
  onTarget(result: TmuxBusResult): void;
}

const subs = new Set<TmuxSubscriber>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let kickPending = false;
let kickScheduled = false;

async function tick(): Promise<void> {
  if (subs.size === 0) return;
  if (inFlight) {
    kickPending = true;
    return;
  }
  inFlight = true;
  try {
    const batch = [...subs];
    for (let base = 0; base < batch.length; base += MAX_REQS) {
      const slice = batch.slice(base, base + MAX_REQS);
      const reqs = slice.map((sub, i) => ({
        id: String(i),
        ...(sub.pid !== null ? { pid: sub.pid } : {}),
        ...(sub.path ? { path: sub.path } : {}),
      }));
      let targets: Record<string, string | null> = {};
      let transportError = false;
      try {
        const res = await fetch("/api/tmux/targets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reqs }),
        });
        if (!res.ok) {
          transportError = true;
        } else {
          const json = (await res.json()) as { targets?: Record<string, string | null> };
          targets = json.targets ?? {};
        }
      } catch {
        transportError = true;
      }
      for (let i = 0; i < slice.length; i += 1) {
        const sub = slice[i];
        if (!subs.has(sub)) continue;
        if (transportError) sub.onTarget({ transportError: true });
        else if (Object.prototype.hasOwnProperty.call(targets, String(i))) sub.onTarget(targets[String(i)] ?? null);
      }
    }
  } finally {
    inFlight = false;
    if (kickPending) {
      kickPending = false;
      void tick();
    }
  }
}

function kick(): void {
  if (kickScheduled) return;
  kickScheduled = true;
  setTimeout(() => {
    kickScheduled = false;
    void tick();
  }, 0);
}

export function subscribeTmuxTarget(sub: TmuxSubscriber): () => void {
  subs.add(sub);
  if (timer === null) timer = setInterval(() => void tick(), POLL_MS);
  kick();
  return () => {
    subs.delete(sub);
    if (subs.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
