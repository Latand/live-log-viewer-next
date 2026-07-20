/**
 * Deterministic, privacy-safe timing harness for #353 AC1/AC2/AC3.
 *
 * The production trace on the reopened issue measured a picker preflight
 * (~1.108s) immediately followed by a duplicate draft-creation preflight
 * (~1.301s) for the *same unchanged repository* — the same Git rev-parse chain
 * run twice. It also recorded a transient run that waited ~3.5s and returned a
 * false `not_git` while `git rev-parse --show-toplevel` succeeded either side.
 *
 * This harness models a repository probe as a fixed-latency exec (no real repo,
 * no filesystem, no personal data) and measures the wall time the creation
 * request pays for its repository probes, before and after the short-TTL success
 * cache introduced in `src/lib/pipelines/preflight.ts`. Run with:
 *
 *   bun docs/acceptance/pr-353-canvas/preflight-timing.ts
 */
import { clearPipelinePreflightCache, preflightPipelineRepo, type PipelineRepoPreflightPorts } from "@/lib/pipelines/preflight";
import type { ExecResult } from "@/lib/workflows/provision";

const PROBE_LATENCY_MS = 120; // a plausible per-probe cost on a warm repo

function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* deterministic synchronous latency */ }
}

function ports(counter: { probes: number }): PipelineRepoPreflightPorts {
  return {
    homeDir: () => "/home/operator",
    stat: () => ({ isDirectory: () => true }),
    access: () => {},
    exec: (_command, args): ExecResult => {
      counter.probes += 1;
      busyWait(PROBE_LATENCY_MS);
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/srv/repo\n", stderr: "" };
      return { code: 0, stdout: "/srv/repo/.git\n", stderr: "" };
    },
  };
}

// BEFORE — no cache: the picker preflights, then creation preflights again.
clearPipelinePreflightCache();
const before = (() => {
  const counter = { probes: 0 };
  const p = ports(counter);
  const start = performance.now();
  preflightPipelineRepo("~/repo", p);            // picker
  preflightPipelineRepo("/srv/repo", p);         // creation re-probe
  return { ms: Math.round(performance.now() - start), probes: counter.probes };
})();

// AFTER — short-TTL cache: creation reuses the picker's valid probe.
clearPipelinePreflightCache();
const after = (() => {
  const counter = { probes: 0 };
  const p = ports(counter);
  const start = performance.now();
  preflightPipelineRepo("~/repo", p, { cache: true });      // picker warms cache
  preflightPipelineRepo("/srv/repo", p, { cache: true });   // creation → cache hit
  return { ms: Math.round(performance.now() - start), probes: counter.probes };
})();

console.log(JSON.stringify({
  probeLatencyMs: PROBE_LATENCY_MS,
  before: { ...before, note: "picker + duplicate creation probe" },
  after: { ...after, note: "picker warms cache; creation reuses it" },
  savedProbes: before.probes - after.probes,
  savedMs: before.ms - after.ms,
}, null, 2));
