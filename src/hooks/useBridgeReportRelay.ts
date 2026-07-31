"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  bridgeAcknowledgementFor,
  forgetBridgeAcknowledgement,
  pendingBridgeAcknowledgements,
  rememberBridgeAcknowledgement,
} from "@/lib/bridge/pendingAcknowledgements";
import { BRIDGE_LIVE_BATCH_INTERVAL_MS } from "@/lib/bridge/types";
import {
  backoffDelayMs,
  deadlineSignal,
  isAbortError,
  systemScheduler,
  type DeadlineScheduler,
} from "@/lib/deadline";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

/**
 * The production relay: manager reports into the live call (#691 §4).
 *
 * This is the loop that was missing. The durable half of the bridge is a file and
 * an API route; something has to actually pull from it while a call is up and hand
 * what it finds to the one realtime client. That something is here, in the card's
 * tree — the opener — because it is a polling effect, and §4 rule 4 keeps every
 * polling effect and every dispatcher out of the PiP portal.
 *
 * Runs only while the call is live. There is no call to interject into otherwise,
 * and the design is explicit that nothing pushes when no call is up: the gateway's
 * next turn drains instead.
 *
 * Three outcomes, three different obligations, which is why the plan is a tagged
 * union rather than a nullable delivery:
 *
 * - `deliver` — hand it to the client and park the cursor. The acknowledgement is
 *   NOT sent here: `reconcileWorkerDeliveries` only enqueues, and a cursor advanced
 *   on an enqueue is exactly-once inverted — a crash before the host writes loses
 *   the report while the cursor swears it arrived. The cursor moves in the
 *   confirmation listener, when the host says the session took it.
 * - `already-acknowledged` — the batch provably reached the session but the cursor
 *   write was lost. Acknowledge immediately and nothing else. Skipping this leaves
 *   every later report queued behind something already spoken.
 * - `hold` / `idle` — nothing to do.
 *
 * ## What #845 changed, and why
 *
 * The loop above was right about exactly-once and wrong about everything to do
 * with FAILURE. A `setInterval` fired every ten seconds regardless of what the
 * previous tick learned, every non-2xx was treated as "try again in ten seconds",
 * no request carried a deadline, and a confirmation listener could start a POST
 * beside a poll. A stale or non-root `realtimeSessionId` is answered 403 by the
 * gateway authority — correctly, and forever — so the honest reading of the old
 * loop is that a legitimately refused session hammered the route six times a
 * minute for as long as the tab stayed open, each poll asking the server to
 * rebuild the whole registry, with up to thirty-two parked acknowledgements
 * fanned out beside it.
 *
 * So the shape is now:
 *
 * - one owner and one in-flight request. The interval is gone; each cycle
 *   schedules the next when it finishes, so two cycles cannot overlap and the
 *   confirmation listener wakes the loop instead of fetching beside it.
 * - every fetch carries a deadline and an `AbortSignal` descending from an owner
 *   controller that is aborted on unmount, navigation, call-phase change and
 *   session change.
 * - 401/403 RETIRES that exact session id. It is not a transient state; the
 *   credential either is the live root's or is not, and asking again cannot
 *   change the answer. A different session id starts clean.
 * - transport failures, 429 and 5xx are the retryable class, and back off
 *   exponentially with jitter up to a ceiling.
 * - parked acknowledgements are swept oldest-first, bounded per cycle, and only
 *   for the session that parked them.
 */

type BridgeDeliveryPlanPayload =
  | { kind: "deliver"; delivery: RuntimeVoiceDelivery; ackToken: string }
  | { kind: "already-acknowledged"; ackToken: string }
  | { kind: "hold" }
  | { kind: "idle" };

export interface BridgeRelayClient {
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]): void;
  /** Fires when the runtime host has durably accepted a delivery. */
  onDeliveryAcknowledged(listener: (deliveryId: string) => void): () => void;
  /** #691 §4: this call's credential. The inbox carries deploy nonces, so reading it
      needs the same proof writing into the call does. */
  realtimeSession(): string | null;
}

/**
 * What the relay is doing, as a value.
 *
 * Typed and bounded rather than a free-form counter, because "retired" is a
 * terminal fact about one session id and the surface above has to be able to tell
 * it apart from "between polls". Exposed for tests and diagnostics; the voice host
 * does not need it.
 */
export type BridgeRelayState =
  | { kind: "idle" }
  | { kind: "polling"; sessionId: string }
  | { kind: "backing-off"; sessionId: string; failures: number; delayMs: number }
  | { kind: "retired"; sessionId: string; status: number };

/** Slightly under the coalescing window: polling faster cannot produce a batch any
    sooner, and polling slower would add latency the server already bounds. */
const POLL_MS = Math.floor(BRIDGE_LIVE_BATCH_INTERVAL_MS / 3);

/** Under the poll cadence on purpose: a request that has not answered by then
    cannot be the reason the next cycle waits, and a hung socket must never be
    able to hold the single in-flight slot past its own turn. */
const REQUEST_TIMEOUT_MS = 8_000;

/** The retryable class climbs from the ordinary cadence to five minutes. Past
    that there is nothing to learn from asking sooner, and the reports are
    durable — a late batch costs latency, never a loss. */
const BACKOFF_BASE_MS = POLL_MS;
const BACKOFF_MAX_MS = 300_000;
const BACKOFF_JITTER = 0.3;

/**
 * Parked tokens attempted per cycle.
 *
 * The store holds up to thirty-two, and the loop used to fan out all of them on
 * every tick. Oldest-first and bounded means a backlog drains over a few cycles
 * instead of turning one poll into a burst; nothing is dropped, because a token
 * not attempted this cycle is still parked for the next.
 */
const MAX_ACK_ATTEMPTS_PER_CYCLE = 4;

/** Session ids whose credential the gateway refused. Bounded, and module-scoped
    so a call-phase transition — which tears the effect down and builds it again
    with the same credential — does not resurrect a refused poll. */
const RETIRED_SESSION_CAPACITY = 16;
type RetiredSession = { sessionId: string; status: number };
const relayHost = globalThis as typeof globalThis & { __llvRetiredBridgeSessions?: RetiredSession[] };

function retiredSessions(): RetiredSession[] {
  return relayHost.__llvRetiredBridgeSessions ??= [];
}

function retireBridgeSession(sessionId: string, status: number): void {
  const next = retiredSessions().filter((entry) => entry.sessionId !== sessionId);
  next.push({ sessionId, status });
  relayHost.__llvRetiredBridgeSessions = next.slice(-RETIRED_SESSION_CAPACITY);
}

export function bridgeSessionRetirement(sessionId: string): RetiredSession | null {
  return retiredSessions().find((entry) => entry.sessionId === sessionId) ?? null;
}

export function isBridgeSessionRetired(sessionId: string): boolean {
  return bridgeSessionRetirement(sessionId) !== null;
}

/** Tests only. */
export function resetBridgeRelayStateForTests(): void {
  relayHost.__llvRetiredBridgeSessions = [];
}

/** 401 and 403 are the gateway saying this credential is not the live root's.
    Nothing about repeating the question changes the answer. */
function isAuthorityRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

/** Contention, rate limiting and server faults are "come back later"; every other
    4xx is a statement about the request itself, which a retry reproduces exactly. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface BridgeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal | null;
  scheduler?: DeadlineScheduler;
}

async function bridgeFetch(
  request: typeof fetch,
  input: string,
  init: RequestInit,
  options: BridgeRequestOptions,
): Promise<Response> {
  const deadline = deadlineSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS, {
    signal: options.signal ?? null,
    scheduler: options.scheduler ?? systemScheduler,
    reason: "bridge request deadline exceeded",
  });
  try {
    return await request(input, { ...init, signal: deadline.signal });
  } finally {
    /* In a `finally` because the interesting case is the one that throws: a
       transport failure that left the timer armed is a leak that survives the
       request by the whole timeout. */
    deadline.release();
  }
}

/**
 * The no-call half of the relay (§4): drain at the start of the gateway's turn.
 *
 * Returned as a callback rather than run on a timer, because a turn is an event
 * the card already owns — it is the submit. Nothing pushes while no call is live;
 * this pulls once, at the only moment the inbox is about to matter.
 *
 * The cursor is acknowledged only after the caller reports the turn actually left,
 * for the reason the live path parks its cursor: a batch folded into a message that
 * never sent must arrive again.
 */
export interface BridgeTurnStart {
  /** Prepended to the turn's own input; "" when nothing is pending. */
  text: string;
  /** The token that settles this batch, or "" when nothing was drained. Handed to
      the caller so a send that settles LATER can still acknowledge it. */
  ackToken: string;
  /**
   * Advance the cursor — call ONLY once the turn carrying `text` has been durably
   * admitted. Same rule as the live path, same reason: a batch folded into a
   * message that was rejected, deadlined or never sent has not reached anyone, and
   * a cursor moved on composing it would lose those reports permanently.
   */
  commit: () => void;
}

const NOTHING_PENDING: BridgeTurnStart = { text: "", ackToken: "", commit: () => undefined };

/**
 * Settle a batch whose turn was admitted after the fact.
 *
 * A structured send answers `ok` with a receipt that may still be `pending`, and the
 * durable admission arrives later on the receipt stream — by which time the closure
 * that drained the batch is long gone. Acknowledging by TOKEN rather than by closure
 * is what lets the cursor move then: the token is a value, so it survives being
 * stored beside the delivery key and replayed once.
 */
export async function commitBridgeTurn(
  ackToken: string,
  fetchFn: typeof fetch = fetch,
  options: BridgeRequestOptions = {},
): Promise<void> {
  if (!ackToken) return;
  /* Awaitable and throwing on refusal, so the caller can keep the token when the
     cursor did not actually move. Swallowing the failure here is what left batches
     parked with nothing able to settle them. */
  const response = await bridgeFetch(fetchFn, "/api/bridge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ackToken }),
  }, options);
  if (!response.ok) throw new BridgeAcknowledgementRefused(response.status);
}

/** A refusal that carries its status, so a caller can tell "not you" (401/403)
    and "that batch is already settled" (409) apart from "come back" (5xx). */
export class BridgeAcknowledgementRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`bridge acknowledgement refused with ${status}`);
    this.name = "BridgeAcknowledgementRefused";
    this.status = status;
  }
}

/**
 * Whether a refused acknowledgement is worth parking any longer.
 *
 * 409 is the server saying the token does not name the outstanding batch. That is
 * terminal in the only direction that matters: the token cannot settle anything
 * ever again, so keeping it parked would hold a slot in a bounded store — and
 * before #845 it held one forever. Dropping it costs nothing, because a batch
 * still outstanding is handed out again with a FRESH token on the next drain.
 */
function isSpentAcknowledgement(error: unknown): boolean {
  return error instanceof BridgeAcknowledgementRefused && error.status === 409;
}

/**
 * Settle every token still parked from an earlier turn, to completion.
 *
 * Run BEFORE a drain, and awaited, so the two cannot interleave: draining first would
 * hand out a fresh batch while an older one is still unacknowledged, and the cursor
 * would move past reports the operator never heard. A token that is refused stays
 * parked and is tried again at the next drain, so a transient failure costs a delay
 * rather than a batch.
 */
export async function retirePendingBridgeAcknowledgements(
  fetchFn: typeof fetch = fetch,
  subject: (waitingOn: string) => boolean = () => true,
  options: BridgeRequestOptions = {},
): Promise<void> {
  for (const entry of pendingBridgeAcknowledgements()) {
    if (!subject(entry.waitingOn)) continue;
    try {
      await commitBridgeTurn(entry.ackToken, fetchFn, options);
      forgetBridgeAcknowledgement(entry.waitingOn);
    } catch (error) {
      /* Kept: the cursor did not move, so this token is still the only thing that can
         settle its batch. The next drain tries again — unless the server says the
         token is spent, in which case parking it again only wastes a slot. */
      if (isSpentAcknowledgement(error)) forgetBridgeAcknowledgement(entry.waitingOn);
    }
  }
}

export function useBridgeTurnStartDrain(
  enabled: boolean,
  options: { fetchFn?: typeof fetch; conversationId?: string | null } = {},
): () => Promise<BridgeTurnStart> {
  const fetchFn = options.fetchFn;
  const conversationId = options.conversationId?.trim() ?? "";
  return useCallback(async () => {
    if (!enabled) return NOTHING_PENDING;
    const request = fetchFn ?? fetch;
    /* Ahead of the GET, and awaited. A drain that ran first would hand out a new
       batch on top of an unsettled one. */
    await retirePendingBridgeAcknowledgements(request, (waitingOn) => !waitingOn.startsWith("voice:"));
    try {
      /* No session id, deliberately: this is the path taken when NO call is live, so
         requiring one would mean the inbox drains only while it is not needed. This
         is the Viewer's own same-origin fetch, which is what says it is the operator
         opening a turn — it presents no capability, and must not. */
      const parameters = new URLSearchParams({ mode: "turn-start" });
      if (conversationId) parameters.set("conversationId", conversationId);
      const response = await bridgeFetch(request, `/api/bridge?${parameters.toString()}`, { cache: "no-store" }, {});
      if (!response.ok) return NOTHING_PENDING;
      const payload = await response.json() as { prelude?: { text: string; ackToken: string } | null };
      const prelude = payload.prelude;
      if (!prelude?.text) return NOTHING_PENDING;
      return {
        text: prelude.text,
        ackToken: prelude.ackToken,
        /* Through `commitBridgeTurn` rather than its own fetch, so this path gets the
           same rule as every other acknowledgement: a refusal is a refusal. The inline
           version treated any response as a settle, which turned a 403 or a 409 into a
           silently lost batch. Fire-and-forget by contract — the caller holds the
           token and can spend it again — so the rejection is absorbed here. */
        commit: () => {
          void commitBridgeTurn(prelude.ackToken, request).catch(() => undefined);
        },
      };
    } catch {
      /* The reports are durable and the cursor did not move: the next turn tries
         again. A blocked send would be a far worse failure than a late report. */
      return NOTHING_PENDING;
    }
  }, [conversationId, enabled, fetchFn]);
}

export interface BridgeReportRelayOptions {
  fetchFn?: typeof fetch;
  pollMs?: number;
  requestTimeoutMs?: number;
  /** Injected so thirty simulated minutes cost a few milliseconds. */
  scheduler?: DeadlineScheduler;
  random?: () => number;
  onState?: (state: BridgeRelayState) => void;
}

/** What one cycle learned, which is the only thing that decides when the next runs. */
type CycleOutcome =
  | { kind: "idle" }
  | { kind: "settled" }
  | { kind: "retired" }
  | { kind: "retryable" };

export function useBridgeReportRelay(
  client: BridgeRelayClient | null,
  live: boolean,
  options: BridgeReportRelayOptions = {},
): void {
  const acknowledgedRef = useRef<string[]>([]);
  const lastBatchAtRef = useRef<Date | null>(null);

  const { fetchFn, onState, random, scheduler: injectedScheduler } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  /* The callbacks are read through a ref so a caller that passes an inline
     `onState` or `random` cannot restart the loop on every render — restarting is
     what a polling effect must never do, and it is how the previous shape ended up
     with overlapping fetches. */
  const callbacksRef = useRef({ onState, random });
  useEffect(() => { callbacksRef.current = { onState, random }; }, [onState, random]);

  useEffect(() => {
    if (!client || !live) return;
    const request = fetchFn ?? fetch;
    const scheduler = injectedScheduler ?? systemScheduler;

    /* One owner for the whole effect. Unmount, navigation and a call-phase change
       all abort it, and every request descends from it, so nothing survives the
       thing that wanted it. */
    const owner = new AbortController();
    let timer: unknown;
    let running = false;
    let stopped = false;
    let failures = 0;
    /* Delivery ids the host has confirmed, waiting for the loop to spend their
       tokens. The listener used to POST directly, which is how a second request
       appeared beside a poll. */
    let confirmed: string[] = [];

    const publish = (state: BridgeRelayState): void => {
      if (stopped) return;
      callbacksRef.current.onState?.(state);
    };

    const call = (input: string, init: RequestInit): Promise<Response> => bridgeFetch(request, input, init, {
      timeoutMs: requestTimeoutMs,
      signal: owner.signal,
      scheduler,
    });

    /**
     * Settle a batch, and REPORT WHETHER IT SETTLED.
     *
     * `fetch` rejects only on transport failure, so a 403 from an unauthenticated
     * poll, a 409 on a token the server no longer holds, and a 500 mid-write all
     * resolve as success — and treating success as permission to delete the token
     * throws away the one thing that could settle the batch precisely when the
     * batch has NOT been settled. So a refusal throws, carrying its status.
     */
    const acknowledgeCursor = async (ackToken: string, sessionId: string): Promise<void> => {
      const response = await call("/api/bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* The token the batch was handed out with — never a sequence of our own
           choosing, which the server would be right to refuse. */
        body: JSON.stringify({ ackToken, realtimeSessionId: sessionId }),
      });
      if (!response.ok) throw new BridgeAcknowledgementRefused(response.status);
    };

    /**
     * Spend the tokens this session parked, oldest first and bounded.
     *
     * Sequential, not `Promise.all`: the single in-flight rule is the whole point,
     * and the drain that follows asks the server a question these answers change.
     * Returns the refusal status when the gateway rejected the credential, because
     * that retires the session rather than merely failing this cycle.
     */
    const sweepParkedAcknowledgements = async (sessionId: string): Promise<number | null> => {
      const parked = [
        ...confirmed.flatMap((deliveryId) => {
          const ackToken = bridgeAcknowledgementFor(deliveryId);
          return ackToken ? [{ waitingOn: deliveryId, ackToken }] : [];
        }),
        /* Everything else this session parked — a token dropped by a torn-down
           effect, or one whose POST was refused. A reload mid-call leaves entries
           with no session recorded; they are this call's or nobody's, so they are
           swept too rather than stranded. */
        ...pendingBridgeAcknowledgements().filter((entry) => (
          entry.waitingOn.startsWith("voice:")
          && (entry.sessionId === null || entry.sessionId === sessionId)
        )),
      ];
      const seen = new Set<string>();
      let attempts = 0;
      for (const entry of parked) {
        if (stopped || attempts >= MAX_ACK_ATTEMPTS_PER_CYCLE) break;
        if (seen.has(entry.waitingOn)) continue;
        seen.add(entry.waitingOn);
        attempts += 1;
        try {
          await acknowledgeCursor(entry.ackToken, sessionId);
          forgetBridgeAcknowledgement(entry.waitingOn);
          confirmed = confirmed.filter((deliveryId) => deliveryId !== entry.waitingOn);
        } catch (error) {
          if (error instanceof BridgeAcknowledgementRefused && isAuthorityRefusal(error.status)) return error.status;
          /* Spent tokens stop occupying a bounded slot; everything else stays
             parked, because it is still the only thing that can settle its batch. */
          if (isSpentAcknowledgement(error)) {
            forgetBridgeAcknowledgement(entry.waitingOn);
            confirmed = confirmed.filter((deliveryId) => deliveryId !== entry.waitingOn);
          }
        }
      }
      return null;
    };

    const runCycle = async (): Promise<CycleOutcome> => {
      const session = client.realtimeSession();
      /* No credential, no read: the inbox carries deploy nonces. A call that has
         not finished its SDP exchange has nothing to present yet, and waits — and
         it must not acknowledge anything either, which is why the sweep sits after
         this check rather than before it. */
      if (!session) {
        publish({ kind: "idle" });
        return { kind: "idle" };
      }
      const retirement = bridgeSessionRetirement(session);
      if (retirement) {
        /* Zero requests, for as long as this credential is the one on offer. The
           timer keeps ticking so a genuinely new session is noticed, which costs one
           string comparison rather than a round trip. */
        publish({ kind: "retired", sessionId: session, status: retirement.status });
        return { kind: "retired" };
      }
      publish({ kind: "polling", sessionId: session });

      const refusedBySweep = await sweepParkedAcknowledgements(session);
      if (refusedBySweep !== null) {
        retireBridgeSession(session, refusedBySweep);
        publish({ kind: "retired", sessionId: session, status: refusedBySweep });
        return { kind: "retired" };
      }
      if (stopped || client.realtimeSession() !== session) return { kind: "settled" };

      const parameters = new URLSearchParams({ realtimeSessionId: session });
      for (const id of acknowledgedRef.current) parameters.append("acked", id);
      if (lastBatchAtRef.current) parameters.set("lastBatchAt", lastBatchAtRef.current.toISOString());
      const response = await call(`/api/bridge?${parameters.toString()}`, { cache: "no-store" });

      if (isAuthorityRefusal(response.status)) {
        retireBridgeSession(session, response.status);
        publish({ kind: "retired", sessionId: session, status: response.status });
        return { kind: "retired" };
      }
      if (isRetryableStatus(response.status)) return { kind: "retryable" };
      /* Any other non-2xx is a statement about this request, not about the link.
         Repeating it faster changes nothing, so it rejoins the ordinary cadence. */
      if (!response.ok) return { kind: "settled" };

      const payload = await response.json() as { plan?: BridgeDeliveryPlanPayload };
      const plan = payload.plan;
      /* The credential may have rolled while this was in flight. The server's cursor
         did not move, so dropping the answer costs a repeat at worst — and applying
         a previous call's batch to a new one would be far worse. */
      if (!plan || stopped || client.realtimeSession() !== session) return { kind: "settled" };

      if (plan.kind === "deliver") {
        /* Enqueue only. `reconcileWorkerDeliveries` puts the batch in an in-memory
           queue and returns; the host has not written anything yet. Advancing the
           cursor here would invert exactly-once — a crash in between loses the report
           while the cursor claims it was delivered — so the batch is parked until the
           host confirms.

           Parked OUTSIDE this effect, and now stamped with the session that drained
           it, so a call-phase transition cannot strand it and a LATER call cannot
           spend it against a credential that never received it. */
        rememberBridgeAcknowledgement(plan.delivery.deliveryId, plan.ackToken, { sessionId: session });
        client.reconcileWorkerDeliveries([plan.delivery]);
        lastBatchAtRef.current = new Date();
        return { kind: "settled" };
      }
      if (plan.kind !== "already-acknowledged") return { kind: "settled" };
      /* Already spoken and provably received; this only heals the cursor. Nothing is
         parked here because there is no delivery left to wait on — the server hands
         out a fresh token for the same batch on the next GET. */
      try {
        await acknowledgeCursor(plan.ackToken, session);
      } catch (error) {
        if (error instanceof BridgeAcknowledgementRefused && isAuthorityRefusal(error.status)) {
          retireBridgeSession(session, error.status);
          publish({ kind: "retired", sessionId: session, status: error.status });
          return { kind: "retired" };
        }
        if (!isSpentAcknowledgement(error)) return { kind: "retryable" };
      }
      return { kind: "settled" };
    };

    const schedule = (delayMs: number): void => {
      if (stopped) return;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      timer = scheduler.setTimeout(() => {
        timer = undefined;
        void cycle();
      }, delayMs);
    };

    /* One in flight, always. A wake that lands mid-cycle is absorbed by the
       reschedule the cycle already performs when it finishes. */
    const wake = (): void => {
      if (stopped || running) return;
      schedule(0);
    };

    const cycle = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      let outcome: CycleOutcome;
      try {
        outcome = await runCycle();
      } catch (error) {
        /* An aborted request is this effect being torn down or deadlined, never an
           incident. Everything else is the retryable class: the reports are durable
           and the cursor did not move, and surfacing a transport blip mid-call would
           be noise on the one surface that must stay calm. */
        outcome = isAbortError(error) && stopped ? { kind: "idle" } : { kind: "retryable" };
      } finally {
        running = false;
      }
      if (stopped) return;
      if (outcome.kind === "retryable") {
        failures += 1;
        const delayMs = backoffDelayMs(failures, {
          baseMs: BACKOFF_BASE_MS,
          maxMs: BACKOFF_MAX_MS,
          jitter: BACKOFF_JITTER,
          ...(callbacksRef.current.random ? { random: callbacksRef.current.random } : {}),
        });
        const session = client.realtimeSession();
        if (session) publish({ kind: "backing-off", sessionId: session, failures, delayMs });
        schedule(delayMs);
        return;
      }
      failures = 0;
      schedule(pollMs);
    };

    /* Waking rather than fetching. The confirmation arrives on the host's schedule,
       not the poll's, and starting a POST here is what let two requests be in flight
       at once. The loop owns the socket; this only tells it there is work. */
    const releaseAcknowledged = client.onDeliveryAcknowledged((deliveryId) => {
      if (stopped) return;
      /* A confirmation for something this relay never handed out settles nothing, and
         waking on it would turn every unrelated host event into a cycle. */
      if (!bridgeAcknowledgementFor(deliveryId)) return;
      /* Now — and only now — has the report provably reached the session. */
      acknowledgedRef.current = [...acknowledgedRef.current, deliveryId].slice(-256);
      confirmed = [...confirmed.filter((entry) => entry !== deliveryId), deliveryId].slice(-256);
      wake();
    });

    /* A hard navigation never unmounts the tree, so the effect cleanup does not run
       and an in-flight request would be left to the browser. Symmetrically removed
       below, so this cannot accumulate across call phases. */
    const abandon = () => { owner.abort(new Error("bridge relay page hidden")); };
    const view = typeof window === "undefined" ? null : window;
    view?.addEventListener("pagehide", abandon);

    void cycle();

    return () => {
      stopped = true;
      view?.removeEventListener("pagehide", abandon);
      releaseAcknowledged();
      if (timer !== undefined) scheduler.clearTimeout(timer);
      timer = undefined;
      owner.abort(new Error("bridge relay stopped"));
    };
  }, [client, fetchFn, injectedScheduler, live, pollMs, requestTimeoutMs]);
}
