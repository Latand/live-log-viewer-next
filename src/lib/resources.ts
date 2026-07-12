import { procBackend } from "@/lib/proc";
import { descendantPids } from "@/lib/proc/memory";
import { listFiles } from "@/lib/scanner";
import { overlaySessionTitles } from "@/lib/session/titleProjection";
import { readTranscriptHosts, type TranscriptHost, type TranscriptHostSnapshot } from "@/lib/agent/transcriptHost";
import { captureTmuxAttachReference, type TmuxAttachReference } from "@/lib/tmux";

import type { FileEntry, ResourceSession, ResourcesPayload } from "./types";

/**
 * System memory pressure + per-agent-session memory attribution, the data
 * behind the rail resources block and its cleanup list. Each tmux pane whose
 * process tree contains a claude/codex CLI is one session; the tree sum is
 * what actually frees up on kill-pane — the MCP children (`npm exec`, node
 * servers) hanging off the CLI usually outweigh the CLI itself.
 */

const CACHE_MS = 10_000;

function captureSystemMemory(): ResourcesPayload["system"] {
  const system = procBackend.systemMemory();
  return system ? { ...system, capturedAt: new Date().toISOString() } : null;
}

/** What the kill path needs to take a snapshot session down safely: the
    stable `%N` pane id to address, and the pane pid to verify it against. */
export type KillTargetRef = TmuxAttachReference;

const globalStore = globalThis as unknown as {
  __llvResourcesCache?: { at: number; data: ResourcesPayload } | null;
  __llvResourceTargets?: Map<string, KillTargetRef>;
};

/**
 * Server-held allowlist for the kill-target action: only pane targets present
 * in the last resources snapshot may be killed. A client-supplied arbitrary
 * target could name the user's own work pane, so it is refused. Each target
 * keeps the stable pane id and pane pid it had in the snapshot: display
 * coordinates renumber as windows close (`renumber-windows on`), so the kill
 * must address the pane by id and verify the pid still matches.
 */
export function noteSessionTargets(sessions: Iterable<{ target: string; ref: KillTargetRef }>): void {
  const map = new Map<string, KillTargetRef>();
  for (const { target, ref } of sessions) map.set(target, ref);
  globalStore.__llvResourceTargets = map;
}

/** Snapshot pane ref recorded for `target`, or null when it was never listed. */
export function allowedKillTarget(target: string): KillTargetRef | null {
  if (target === "") return null;
  return globalStore.__llvResourceTargets?.get(target) ?? null;
}

/** Drops `target` from the allowlist after a kill: the coordinates are free
    for tmux to reuse, so a repeated POST must not pass the gate again. */
export function consumeKillTarget(target: string): void {
  globalStore.__llvResourceTargets?.delete(target);
}

/** The resources rail may list duplicate panes for cleanup. Only the host
    elected by the shared resolver receives the transcript path and its UI
    metadata, keeping observation aligned with path-addressed delivery. */
export function canonicalResourceEntry(
  snapshot: TranscriptHostSnapshot,
  paneHosts: TranscriptHost[],
  entriesByPath: Map<string, FileEntry>,
): FileEntry | null {
  for (const candidate of paneHosts) {
    if (!candidate.primaryPath) continue;
    const canonical = snapshot.canonicalFor(candidate.primaryPath);
    if (canonical?.paneId === candidate.paneId && canonical.agentPid === candidate.agentPid) {
      return entriesByPath.get(candidate.primaryPath) ?? null;
    }
  }
  return null;
}

export function conflictingResourceHost(snapshot: TranscriptHostSnapshot, host: TranscriptHost): boolean {
  return snapshot.conflicts?.some((conflict) => conflict.paneIds.includes(host.paneId)) ?? false;
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** `fresh` skips the pane/agent-process memos too, all the way down: a
    rebuild triggered right after a kill would otherwise read 5s-old caches
    and re-list (and re-allowlist) the session that was just killed. */
async function buildResources(fresh: boolean): Promise<ResourcesPayload> {
  const system = captureSystemMemory();

  const hosts = await readTranscriptHosts(fresh);
  const sessions: ResourceSession[] = [];
  if (hosts.hosts.length > 0) {
    const ppids = procBackend.ppidMap();
    const files = await listFiles();
    overlaySessionTitles(files);
    const byPath = new Map(files.map((entry) => [entry.path, entry]));
    const byPane = new Map<string, TranscriptHost[]>();
    for (const host of hosts.hosts) {
      const paneHosts = byPane.get(host.paneId);
      if (paneHosts) paneHosts.push(host);
      else byPane.set(host.paneId, [host]);
    }

    /* Trees first, memory second: one processMemory() batch over the union
       keeps the portable backend at a single `ps` spawn for all panes. */
    const paneTrees: Array<{ host: TranscriptHost; tree: number[]; paneHosts: TranscriptHost[] }> = [];
    const treePids = new Set<number>();
    for (const paneHosts of byPane.values()) {
      const host = paneHosts[0]!;
      const tree = descendantPids(host.panePid, ppids);
      paneTrees.push({ host, tree, paneHosts });
      for (const pid of tree) treePids.add(pid);
    }
    const memory = procBackend.processMemory(treePids);

    const killRefs: Array<{ target: string; ref: KillTargetRef }> = [];
    for (const { host, tree, paneHosts } of paneTrees) {
      let rssBytes = 0;
      let swapBytes = 0;
      for (const pid of tree) {
        const mem = memory.get(pid);
        if (!mem) continue;
        rssBytes += mem.rssBytes;
        swapBytes += mem.swapBytes;
      }
      /* The resolver elects one canonical host for every transcript. A
         duplicate pane stays visible for cleanup, though it carries no path
         and cannot disagree with path-addressed delivery. */
      const entry = canonicalResourceEntry(hosts, paneHosts, byPath);
      sessions.push({
        target: host.display,
        panePid: host.panePid,
        path: entry?.path ?? null,
        engine: host.engine,
        hostConflict: conflictingResourceHost(hosts, host),
        title: entry?.title ?? null,
        project: entry?.project || null,
        activity: entry?.activity ?? null,
        lastActiveAt: entry ? isoFromUnix(entry.mtime) : null,
        cwd: host.cwd,
        rssBytes,
        swapBytes,
        procCount: tree.length,
      });
      killRefs.push({
        target: host.display,
        ref: captureTmuxAttachReference({ tmuxServerPid: host.tmuxServerPid, panePid: host.panePid, paneId: host.paneId }),
      });
    }
    sessions.sort((a, b) => b.rssBytes + b.swapBytes - (a.rssBytes + a.swapBytes));
    noteSessionTargets(killRefs);
  } else {
    noteSessionTargets([]);
  }

  return {
    system,
    sessions,
  };
}

/** Snapshot for GET /api/resources, cached briefly so UI polling stays cheap.
    `fresh` forces a rebuild — used right after a kill so the freed memory and
    the shorter session list show up immediately. */
export async function readResources(fresh = false): Promise<ResourcesPayload> {
  const cached = globalStore.__llvResourcesCache;
  /* Pane discovery is the expensive cached half. Host pressure comes from a
     new /proc/meminfo snapshot on every request, so RAM and swap never inherit
     the age of a pane/session snapshot. */
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return { ...cached.data, system: captureSystemMemory() };
  }
  const data = await buildResources(fresh);
  globalStore.__llvResourcesCache = { at: Date.now(), data };
  return data;
}
