/* #1254: what it means to have verified a runtime change.
 *
 * The Bun pin moved to 1.4.0 for the framework bump. Every check that ran
 * before promotion exercised the Viewer, and the Viewer was fine. The runtime
 * host runs under the same Bun, owns the stable listener, and performs the
 * release succession — and it was never started under 1.4.0 until it was
 * production. It crash-looped there, on a socket write to a peer that had
 * already gone.
 *
 * A runtime is verified for this repository when the runtime host has actually
 * done its job under it: booted, taken the singleton fence from a predecessor
 * generation, and then held both of its endpoints while real peers came and
 * went — including peers that leave in the middle of an answer, which is the
 * write that took production down. This is a gate, not a report: a candidate
 * whose host cannot do this is refused before promotion.
 *
 * The rehearsal never touches a live listener. Both generations run against a
 * private state directory on an ephemeral port; the concrete ports in
 * `hostRehearsalRun.ts` own that isolation, and the deployment gate runs the
 * whole thing inside a throwaway container from the candidate image.
 */

import type {
  ViewerRuntimeHostHealthEvidence,
  ViewerRuntimeHostListenerEvidence,
  ViewerRuntimeHostProbeEvidence,
} from "@/lib/runtime/contracts";

/** The predecessor's listener must answer within this after it is started. */
const DEFAULT_READY_BUDGET_MS = 60_000;
/** The successor must take the fence and answer within this after the
    predecessor is asked to exit. */
const DEFAULT_SUCCESSION_BUDGET_MS = 30_000;
/** How long the successor's endpoints are held under observation, and how
    often they are asked. The incident's listener answered 12 of 24 polls, so a
    window of this size with every poll required sees it several times over. */
const DEFAULT_HOLD_WINDOW_MS = 15_000;
const DEFAULT_HOLD_POLL_MS = 500;
/** Bounded tail of a generation's own output, kept with a failure. */
export const RUNTIME_HOST_REHEARSAL_LOG_LINES = 40;
/** How the rehearsal names its report inside a stream of host output. */
export const RUNTIME_HOST_REHEARSAL_REPORT_PREFIX = "[runtime host rehearsal] report ";

export interface RuntimeHostRehearsalGeneration {
  /** Ask this generation to exit the way a hand-over does. */
  stop(): Promise<void>;
  /** Whether the process is gone, however it went. */
  exited(): boolean;
  /** Bounded tail of what it wrote. */
  log(): string[];
}

export interface RuntimeHostRehearsalPorts {
  /** Start one runtime-host generation. The successor boots while the
      predecessor still owns the fence, exactly as a staged one does. */
  start(role: "predecessor" | "successor"): Promise<RuntimeHostRehearsalGeneration>;
  /**
   * Put enough in the journal that one answer is a large one rather than a
   * single small write, so an abandoning peer leaves bytes still pending.
   */
  seed(): Promise<void>;
  /**
   * Ask the stable listener for an answer. `abandon` makes the caller vanish
   * part-way through — the write that took production down, produced on
   * purpose rather than waited for.
   */
  probeListener(options: { abandon: boolean }): Promise<boolean>;
  /** The same question of the runtime socket, whose answers are the large ones. */
  probeSocket(options: { abandon: boolean }): Promise<boolean>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface RuntimeHostRehearsalOptions {
  /** What was exercised, for the record: `bun 1.4.0`. */
  runtime: string;
  readyBudgetMs?: number;
  successionBudgetMs?: number;
  holdWindowMs?: number;
  holdPollMs?: number;
}

function evidence(
  options: RuntimeHostRehearsalOptions,
  checkedAt: string,
  succession: ViewerRuntimeHostHealthEvidence["succession"],
  listener: ViewerRuntimeHostListenerEvidence,
  socket: ViewerRuntimeHostProbeEvidence,
  failure: { detail: string; log: string[] } | null,
): ViewerRuntimeHostHealthEvidence {
  return {
    checkedAt,
    runtime: options.runtime,
    succession,
    listener,
    socket,
    ok: failure === null,
    ...(failure ? { detail: failure.detail } : {}),
    ...(failure && failure.log.length > 0 ? { log: failure.log } : {}),
  };
}

/** Wait until the stable listener answers, or give up at the budget. */
async function awaitListener(
  ports: RuntimeHostRehearsalPorts,
  budgetMs: number,
  pollMs: number,
): Promise<number | null> {
  const started = ports.now();
  for (;;) {
    if (await ports.probeListener({ abandon: false })) return ports.now() - started;
    if (ports.now() - started >= budgetMs) return null;
    await ports.sleep(pollMs);
  }
}

/**
 * Drive one runtime-host succession under a runtime and hold the endpoints it
 * hands over. The returned evidence is the whole account: a caller that gets
 * `ok: false` has a named reason and the generation's own output.
 */
export async function rehearseRuntimeHost(
  ports: RuntimeHostRehearsalPorts,
  options: RuntimeHostRehearsalOptions,
): Promise<ViewerRuntimeHostHealthEvidence> {
  const readyBudgetMs = options.readyBudgetMs ?? DEFAULT_READY_BUDGET_MS;
  const successionBudgetMs = options.successionBudgetMs ?? DEFAULT_SUCCESSION_BUDGET_MS;
  const holdWindowMs = options.holdWindowMs ?? DEFAULT_HOLD_WINDOW_MS;
  const holdPollMs = Math.max(1, options.holdPollMs ?? DEFAULT_HOLD_POLL_MS);
  const checkedAt = new Date().toISOString();
  const listener: ViewerRuntimeHostListenerEvidence = { windowMs: holdWindowMs, polls: 0, answered: 0, abandoned: 0 };
  const socket: ViewerRuntimeHostProbeEvidence = { polls: 0, answered: 0, abandoned: 0 };

  let predecessor: RuntimeHostRehearsalGeneration | null = null;
  let successor: RuntimeHostRehearsalGeneration | null = null;
  // A failure keeps the output of whichever generation was meant to be serving.
  const fail = (
    detail: string,
    succession: ViewerRuntimeHostHealthEvidence["succession"],
  ): ViewerRuntimeHostHealthEvidence => evidence(options, checkedAt, succession, listener, socket, {
    detail,
    log: (successor ?? predecessor)?.log() ?? [],
  });

  try {
    predecessor = await ports.start("predecessor");
    const predecessorReadyMs = await awaitListener(ports, readyBudgetMs, holdPollMs);
    if (predecessorReadyMs === null) {
      return fail(
        `the runtime host did not hold the stable listener within ${Math.round(readyBudgetMs / 1_000)}s of starting under ${options.runtime}`,
        { predecessorReadyMs: readyBudgetMs, successorTookOverMs: 0, completed: false },
      );
    }
    await ports.seed();

    successor = await ports.start("successor");
    const started = { predecessorReadyMs, successorTookOverMs: 0, completed: false };
    await predecessor.stop();
    const successorTookOverMs = await awaitListener(ports, successionBudgetMs, holdPollMs);
    if (successorTookOverMs === null) {
      return fail(
        `the successor generation never took the singleton fence and the stable listener within ${Math.round(successionBudgetMs / 1_000)}s under ${options.runtime}`,
        { ...started, successorTookOverMs: successionBudgetMs },
      );
    }
    const succession = { predecessorReadyMs, successorTookOverMs, completed: true };

    /* The hold. Every poll on both endpoints must answer: whoever asked a
       listener that missed one saw an outage, and a host that dies on a peer's
       disconnect misses them in runs. Half the callers leave mid-answer. */
    const holdStarted = ports.now();
    const elapsed = () => Math.round((ports.now() - holdStarted) / 1_000);
    const window = Math.round(holdWindowMs / 1_000);
    while (ports.now() - holdStarted < holdWindowMs) {
      const abandon = listener.polls % 2 === 1;
      listener.polls += 1;
      if (abandon) listener.abandoned += 1;
      if (!await ports.probeListener({ abandon })) {
        return fail(`the stable listener stopped answering ${elapsed()}s into a ${window}s hold under ${options.runtime}`, succession);
      }
      listener.answered += 1;
      socket.polls += 1;
      if (abandon) socket.abandoned += 1;
      if (!await ports.probeSocket({ abandon })) {
        return fail(`the runtime socket stopped answering ${elapsed()}s into a ${window}s hold under ${options.runtime}`, succession);
      }
      socket.answered += 1;
      if (successor.exited()) {
        return fail(`the runtime host exited during the ${window}s hold under ${options.runtime}`, succession);
      }
      await ports.sleep(holdPollMs);
    }
    if (listener.polls === 0) return fail("the hold window observed nothing", succession);
    return evidence(options, checkedAt, succession, listener, socket, null);
  } finally {
    await successor?.stop().catch(() => undefined);
    await predecessor?.stop().catch(() => undefined);
  }
}

/**
 * The interpreter the rehearsal must exercise inside the image, named in full.
 *
 * `bun` in the image is an nsenter shim that redirects to the operator's bun
 * on the host — it is for the agent CLIs, it needs the host PID namespace this
 * container deliberately does not have, and it is not the interpreter being
 * promoted. `bun-container` is the real in-container Bun the runtime host runs
 * under in production, which is the whole point of the rehearsal.
 */
export const RUNTIME_HOST_REHEARSAL_IMAGE_BIN = "/usr/local/bin/bun-container";

/**
 * Rehearse the runtime host of a candidate image, inside a container built
 * from that image. `--rm` and no mounts: the rehearsal writes only inside a
 * container that is discarded, so it can reach neither the live state
 * directory nor the live listener.
 */
export function runtimeHostRehearsalDockerArgs(image: string, stateDir = "/tmp/llv-host-rehearsal"): string[] {
  return [
    "docker", "run", "--rm",
    // Loopback only: the rehearsal's ephemeral ports are the container's own.
    "--network", "none",
    "--label", "dev.live-log-viewer.runtime-host-rehearsal=1",
    "-e", `LLV_RUNTIME_HOST_REHEARSAL_STATE_DIR=${stateDir}`,
    // Both the rehearsal itself and the generations it starts run under the
    // image's own Bun. Without the second one the generations inherit `bun`,
    // the shim, and every candidate fails a gate that never reached a host.
    "-e", `LLV_RUNTIME_HOST_REHEARSAL_BIN=${RUNTIME_HOST_REHEARSAL_IMAGE_BIN}`,
    "--entrypoint", RUNTIME_HOST_REHEARSAL_IMAGE_BIN,
    image,
    "run", "src/runtime-host/hostRehearsalRun.ts",
  ];
}

/** Read the rehearsal's own report out of the container's output. */
export function parseRuntimeHostRehearsalReport(output: string): ViewerRuntimeHostHealthEvidence {
  const marker = output.lastIndexOf(RUNTIME_HOST_REHEARSAL_REPORT_PREFIX);
  if (marker < 0) throw new Error("the runtime-host rehearsal produced no report");
  const line = output.slice(marker + RUNTIME_HOST_REHEARSAL_REPORT_PREFIX.length).split("\n")[0] ?? "";
  const report = JSON.parse(line) as ViewerRuntimeHostHealthEvidence;
  if (typeof report.ok !== "boolean" || typeof report.runtime !== "string") {
    throw new Error("the runtime-host rehearsal report is malformed");
  }
  return report;
}
