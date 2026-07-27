"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { setVoiceConnected, setVoiceSpeaking } from "@/lib/audio/app";
import type { Speaker } from "@/lib/audio/ambientLoop";
import { speakingFromLines } from "@/lib/audio/speech";
import { codexRealtimeClient, type CodexRealtimeLine, type CodexRealtimeSnapshot } from "@/lib/realtime/codexRealtimeClient";
import type { RuntimeVoiceDelivery } from "@/lib/runtime/voiceDelivery";

import { useBridgeReportRelay } from "./useBridgeReportRelay";

const IDLE = { phase: "idle" as const, lines: [], error: null, startedAt: null, micMuted: false, outputMuted: false };

/**
 * The part of the realtime client this hook consumes.
 *
 * Named so the store can be swapped for one with no WebRTC under it, which is
 * the only way to drive the transcript-fed behaviours below — ducking above all
 * — through the REAL hook rather than a copy of it in a test.
 */
export interface RealtimeSurface {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CodexRealtimeSnapshot;
  micStream(): MediaStream | null;
  toggleMic(): void;
  toggleOutput(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  updateWorkerProgress(turnId: string, progress: string, running: boolean): void;
  reconcileWorkerDeliveries(deliveries: readonly RuntimeVoiceDelivery[]): void;
}

const NO_LINES: ReadonlySet<string> = new Set();

let clientFactory: (conversationId: string) => RealtimeSurface = codexRealtimeClient;

/** Test seam: `null` restores the real client. */
export function configureRealtimeClientForTests(factory: ((conversationId: string) => RealtimeSurface) | null): void {
  clientFactory = factory ?? codexRealtimeClient;
}

/**
 * One mounted realtime surface's lease on the background music: whether a call
 * is up, and who is talking in it.
 *
 * Both are per MOUNT, not per conversation, because several conversation cards
 * can have composers mounted at once. A mount speaks only for itself: it
 * releases only its own lease and clears only its own duck, so the card the
 * operator is not looking at can neither end the call nor let the music back up
 * over the voice in the one they are.
 *
 * Card switching is the case that decides the shape here. The focused card is a
 * keyed element, so React destroys the outgoing card's effects before creating
 * the incoming one's — the lease count legitimately passes through zero inside
 * one commit. `setVoiceConnected` settles that at the end of the tick rather
 * than acting on the instant, which is what keeps a swipe from restarting the
 * music.
 *
 * What the music then DOES with the signals is the audio module's business: with
 * music enabled on both sides of the call boundary this hook's edges change
 * nothing audible at all.
 */
/**
 * Who is talking IN THIS CALL, read from the transcript.
 *
 * The transcript outlives the call that produced it, on purpose: the operator
 * keeps reading it after a hangup. Nothing marks its last line final when a call
 * ends, either — a call that drops mid-sentence leaves a streaming line behind
 * for good. Read naively, that line says "the agent is talking" forever, and the
 * NEXT call would open already ducked with nobody saying anything.
 *
 * So every line the call inherited is disqualified at the moment it goes live.
 * The client numbers each line from a counter that only ever goes up and clears
 * its open-line table on teardown, so a new call cannot write into an inherited
 * id — which makes "was it already there?" an exact test for "is it from a call
 * that is over?", with no clock and no heuristic.
 *
 * The carried-over set is adjusted DURING the render that first sees the call
 * (React's documented way to derive state from a change), so the very first
 * committed render of a live call is already un-ducked. An effect would be a
 * commit late, and that commit is precisely the one that opens the duck.
 */
function useCurrentCallSpeaker(live: boolean, lines: readonly CodexRealtimeLine[]): Speaker | null {
  const [wasLive, setWasLive] = useState(live);
  const [carriedOver, setCarriedOver] = useState<ReadonlySet<string>>(NO_LINES);
  if (wasLive !== live) {
    setWasLive(live);
    setCarriedOver(live ? new Set(lines.map((line) => line.id)) : NO_LINES);
  }
  return useMemo(
    () => (live ? speakingFromLines(lines.filter((line) => !carriedOver.has(line.id))) : null),
    [carriedOver, lines, live],
  );
}

export function useAmbientCallLease(live: boolean, speaking: Speaker | null = null): void {
  const owner = useRef(Symbol("realtime-ambient-owner"));
  useEffect(() => {
    const held = owner.current;
    setVoiceConnected(held, live);
    return () => setVoiceConnected(held, false);
  }, [live]);
  useEffect(() => {
    const held = owner.current;
    /* Nobody is talking in a call that is not up — a call dropping mid-sentence
       leaves a non-final line behind for good, and the music must not stay held
       down under a voice that is gone. */
    setVoiceSpeaking(held, live ? speaking : null);
    return () => setVoiceSpeaking(held, null);
  }, [live, speaking]);
}

export function useCodexRealtime(
  conversationId: string,
  enabled: boolean,
  workerTurnId: string,
  workerProgress: string,
  workerRunning: boolean,
  workerDeliveries: readonly RuntimeVoiceDelivery[],
) {
  const client = useMemo(
    () => enabled && conversationId.startsWith("conversation_") ? clientFactory(conversationId) : null,
    [conversationId, enabled],
  );
  const snapshot = useSyncExternalStore(
    client?.subscribe ?? (() => () => undefined),
    client?.getSnapshot ?? (() => IDLE),
    () => IDLE,
  );
  useEffect(() => {
    if (!client || !workerTurnId || !workerProgress) return;
    client.updateWorkerProgress(workerTurnId, workerProgress, workerRunning);
  }, [client, snapshot.phase, workerProgress, workerRunning, workerTurnId]);
  useEffect(() => {
    client?.reconcileWorkerDeliveries(workerDeliveries);
  }, [client, snapshot.phase, workerDeliveries]);

  /* Which side of the call boundary the background music is on, and who has the
     floor. `live` is the only phase with two participants who can talk;
     connecting, stopping and error are not a call. Speech is read off the
     transcript this call already produces — no analyser node, no second event
     path — and the music ducks under it. */
  const live = snapshot.phase === "live";
  const speaking = useCurrentCallSpeaker(live, snapshot.lines);
  useAmbientCallLease(live, speaking);

  /* #691 §4 — manager reports reach the user here, in the card's tree, exactly once
     per conversation. The floater is a second rendering of this same client and
     mounts no relay of its own, so a report cannot be delivered twice. */
  useBridgeReportRelay(client, live);

  return {
    ...snapshot,
    /* Read at render time rather than stored: the stream appears with the
       `live` phase, which already re-renders this subtree. */
    micStream: client?.micStream() ?? null,
    toggleMic: () => client?.toggleMic(),
    toggleOutput: () => client?.toggleOutput(),
    start: () => client?.start() ?? Promise.resolve(),
    stop: () => client?.stop() ?? Promise.resolve(),
  };
}
