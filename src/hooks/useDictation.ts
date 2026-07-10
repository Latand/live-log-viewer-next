"use client";

import { useEffect, useRef, useState } from "react";

import {
  drawMeter,
  float32ToBase64Pcm16,
  fmtElapsed,
  METER_BARS,
  METER_HEIGHT,
  METER_WIDTH,
} from "@/lib/audio";
import { chime } from "@/lib/chime";
import { CAP_SECONDS, dictationCues, remaining as remainingSeconds } from "@/lib/dictationTimer";
import { useLocale } from "@/lib/i18n";

/* Re-exported so existing importers (MicButton and friends) keep resolving
   these through the hook module after the pure helpers moved to lib/audio. */
export { drawMeter, fmtElapsed, METER_BARS, METER_HEIGHT, METER_WIDTH };

/** "starting" covers the getUserMedia/permission/live-token window between the
    mic tap and the first recorded frame — the button shows it and stays inert
    so a second tap can't pile a recorder on top. */
export type DictationPhase = "idle" | "starting" | "rec" | "busy";

const MAX_SECONDS = CAP_SECONDS;
/* Voice mono at 32 kbps keeps a full 10-minute batch recording near ~2.4 MB —
   well under the /api/transcribe 16 MB cap and the upstream provider limit —
   while staying clear for speech. */
const BATCH_BITRATE = 32_000;
/* How long the "stopped at the cap" chip holds before the mic returns to idle,
   so an auto-stop is unmistakable even if the transcription lands instantly. */
const CAP_HOLD_MS = 5_000;
/* Sub-2KB blobs are a misclick, not speech — dropped without a server call. */
const MIN_BLOB_BYTES = 2_000;

/* Realtime Scribe wants raw 16kHz PCM; VAD commits a segment after this much
   silence, which is what turns speech into committed text mid-recording. */
const LIVE_SAMPLE_RATE = 16_000;
const LIVE_VAD_SILENCE_SECS = "1.2";
const LIVE_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/* Single-use realtime tokens are minted for free, so one can be requested
   the moment a recording looks likely (composer focus, mic hover) and spent
   on the actual press — the mint round-trip leaves the tap-to-record path.
   Module-level on purpose: every composer's hook instance draws from the one
   pool, and whichever mic is pressed first consumes the warm token. */
const TOKEN_FRESH_MS = 45_000;
/* A null mint means "no live mode" (other backend / no key); remembering it
   briefly keeps hover-driven prewarms from re-asking the server every time. */
const TOKEN_NULL_MS = 15_000;

let tokenCache: { token: string | null; expiresAt: number } | null = null;
let tokenInflight: Promise<string | null> | null = null;

/* A non-200 from the token route means live mode is off (other backend, no
   key) — the caller falls back to batch without surfacing anything. */
const mintLiveToken = async (): Promise<string | null> => {
  try {
    const res = await fetch("/api/transcribe/token", { method: "POST" });
    if (!res.ok) return null;
    const json = (await res.json()) as { token?: string };
    return typeof json.token === "string" && json.token ? json.token : null;
  } catch {
    return null;
  }
};

/** Mint a live token ahead of the mic press so the press itself only waits
    for the microphone. Free (auth-only, no audio billed); no-op while a
    fresh token or an in-flight mint is already there. */
export function prewarmLiveToken(): void {
  if (tokenInflight) return;
  if (tokenCache && tokenCache.expiresAt > Date.now()) return;
  tokenInflight = mintLiveToken().then((token) => {
    tokenInflight = null;
    tokenCache = { token, expiresAt: Date.now() + (token ? TOKEN_FRESH_MS : TOKEN_NULL_MS) };
    return token;
  });
}

/* Consume the prewarmed token (they are single-use, so a real one leaves the
   cache with its taker); a cached null is left in place — "no live mode" is
   an answer, not a spendable resource. Cold cache mints inline. */
const takeLiveToken = async (): Promise<string | null> => {
  const inflight = tokenInflight;
  if (inflight) {
    const token = await inflight;
    if (token) tokenCache = null;
    return token;
  }
  const cached = tokenCache;
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.token) tokenCache = null;
    return cached.token;
  }
  tokenCache = null;
  return mintLiveToken();
};

interface LiveSession {
  ws: WebSocket;
  ctx: AudioContext;
  processor: ScriptProcessorNode;
  stream: MediaStream;
  /* Audio captured before the socket opens; flushed on open so the first
     words of an eager speaker are not lost to the connection handshake. */
  preOpenQueue: string[];
  partial: string;
}

export interface UseDictationOptions {
  onError: (message: string) => void;
  /** Receives a transcript no stop() call was waiting for. The cap auto-stop
      fires with no pending resolver; without this handler that recording's
      text would be silently dropped. */
  onUnclaimedText: (text: string) => void;
  /** Realtime mode delivers each VAD-committed segment here the moment it
      arrives, mid-recording — the composer appends it to the draft right
      away, so stop() only ever returns the short uncommitted tail. */
  onLiveCommit: (segment: string) => void;
}

export interface UseDictationResult {
  phase: DictationPhase;
  elapsed: number;
  /** The recording cap in seconds; the view derives the countdown from it. */
  maxSeconds: number;
  /** Seconds left before the auto-stop (`maxSeconds - elapsed`, never negative). */
  remaining: number;
  /** True once the cap fired the stop, held briefly so the "stopped" chip and
      chime are unmistakable; self-clears. A manual stop or discard never sets
      it, so the capped state and a user stop stay visually distinct. */
  capStopped: boolean;
  /** Screen-reader announcement for the near-cap warning and the cap stop,
      surfaced through a `role="status"` region by the mic view. Empty when
      there is nothing to announce. */
  srMessage: string;
  /** The in-flight partial of the current segment while a realtime session
      records; committed segments have already left through onLiveCommit.
      Empty in batch mode. Composers overlay it on the draft so speech shows
      up in the input as it is spoken. */
  liveText: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  start: () => Promise<void>;
  /**
   * Stops recording and resolves with the recognised text. In realtime mode
   * this is instant: committed segments already went out via onLiveCommit, so
   * it resolves the uncommitted partial tail (possibly "") without waiting
   * for the server. Resolves null when there is nothing usable — a discard, a
   * misclick-length blob, or a reported error (already surfaced via onError).
   */
  stop: () => Promise<string | null>;
  discard: () => void;
}

/**
 * Recording + transcription state machine shared by every dictation control.
 * Two paths behind one interface:
 *  - realtime: raw PCM streams to ElevenLabs Scribe over WebSocket and the
 *    transcript arrives live via `liveText` (picked when /api/transcribe/token
 *    hands out a session token, i.e. the elevenlabs backend is selected);
 *  - batch: MediaRecorder (webm/opus) posted to /api/transcribe on stop —
 *    the fallback whenever no token is available.
 * Lifted out of MicButton so a composer can orchestrate its own send button
 * around the same recording (see TmuxComposer's stop-and-send).
 */
export function useDictation({ onError, onUnclaimedText, onLiveCommit }: UseDictationOptions): UseDictationResult {
  const { t } = useLocale();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [capStopped, setCapStopped] = useState(false);
  const [srMessage, setSrMessage] = useState("");
  /* The interval owns elapsed through this ref rather than a functional
     setState updater: the cap chimes and stop must fire exactly once, and a
     reducer body can be re-invoked (StrictMode) which would double them. */
  const elapsedRef = useRef(0);
  const capHoldRef = useRef<number | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const liveRef = useRef<LiveSession | null>(null);
  const discardRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const meterRef = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const pendingRef = useRef<((text: string | null) => void) | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  const stopStream = (stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
  };

  const stopTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearCapHold = () => {
    if (capHoldRef.current !== null) {
      clearTimeout(capHoldRef.current);
      capHoldRef.current = null;
    }
  };

  /* Marks the cap-fired stop and holds the "stopped" chip briefly. Only the
     timer's cap branch calls this — stop()/discard() leave it untouched, so a
     manual stop never shows the capped state or plays the stop chime. */
  const flagCapStopped = () => {
    clearCapHold();
    setCapStopped(true);
    setSrMessage(t("dictation.capStopped"));
    chime("dictStop", 0);
    capHoldRef.current = window.setTimeout(() => {
      capHoldRef.current = null;
      if (mountedRef.current) setCapStopped(false);
    }, CAP_HOLD_MS);
  };

  const stopMeter = () => {
    const meter = meterRef.current;
    meterRef.current = null;
    if (meter) {
      cancelAnimationFrame(meter.raf);
      void meter.ctx.close().catch(() => undefined);
    }
  };

  /* Live input-level bars during recording. Dictation works without them, so
     an AudioContext failure only costs the visual. */
  const startMeter = (stream: MediaStream) => {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.7;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      if (!meterRef.current) return;
      meterRef.current.raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(bins);
      const canvas = canvasRef.current;
      if (canvas) drawMeter(canvas, bins);
    };
    meterRef.current = { ctx, raf: requestAnimationFrame(draw) };
  };

  const teardownLive = () => {
    const live = liveRef.current;
    liveRef.current = null;
    if (!live) return;
    try {
      live.processor.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      live.ws.close();
    } catch {
      /* already closed */
    }
    live.stream.getTracks().forEach((track) => track.stop());
    void live.ctx.close().catch(() => undefined);
  };

  /* Ends a live session and hands the uncommitted tail to whoever waits for
     it: the pending stop() resolver, or onUnclaimedText for the auto-stop.
     Committed segments are already in the draft via onLiveCommit. */
  const finishLive = (live: LiveSession) => {
    stopTimer();
    stopMeter();
    teardownLive();
    setLiveText("");
    setPhase("idle");
    const resolvePending = pendingRef.current;
    pendingRef.current = null;
    if (discardRef.current) {
      resolvePending?.(null);
      return;
    }
    const tail = live.partial.trim();
    if (resolvePending) resolvePending(tail);
    else if (tail) onUnclaimedText(tail);
  };

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopTimer();
      stopMeter();
      clearCapHold();
      discardRef.current = true;
      teardownLive();
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      rec?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const finishBatch = async () => {
    stopTimer();
    stopMeter();
    const rec = recRef.current;
    recRef.current = null;
    rec?.stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    const resolvePending = pendingRef.current;
    pendingRef.current = null;
    if (discardRef.current || blob.size < MIN_BLOB_BYTES) {
      setPhase("idle");
      resolvePending?.(null);
      return;
    }
    setPhase("busy");
    try {
      const form = new FormData();
      form.append("file", blob, "dictation.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || typeof json.text !== "string") {
        onError(json.error ?? t("dictation.failed"));
        resolvePending?.(null);
        return;
      }
      const text = json.text.trim();
      if (text) {
        if (resolvePending) resolvePending(text);
        else onUnclaimedText(text);
      } else {
        onError(t("dictation.silence"));
        resolvePending?.(null);
      }
    } catch {
      onError(t("common.serverUnavailable"));
      resolvePending?.(null);
    } finally {
      setPhase("idle");
    }
  };

  const startLive = (stream: MediaStream, token: string): boolean => {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
    } catch {
      return false;
    }
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      token,
      audio_format: `pcm_${LIVE_SAMPLE_RATE}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: LIVE_VAD_SILENCE_SECS,
    });
    const ws = new WebSocket(`${LIVE_WS_URL}?${params.toString()}`);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const live: LiveSession = { ws, ctx, processor, stream, preOpenQueue: [], partial: "" };
    liveRef.current = live;

    const source = ctx.createMediaStreamSource(stream);
    processor.onaudioprocess = (event) => {
      if (liveRef.current !== live) return;
      const chunk = float32ToBase64Pcm16(event.inputBuffer.getChannelData(0));
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: chunk }));
      } else if (ws.readyState === WebSocket.CONNECTING) {
        live.preOpenQueue.push(chunk);
      }
    };
    source.connect(processor);
    processor.connect(ctx.destination);

    ws.addEventListener("open", () => {
      if (liveRef.current !== live) return;
      for (const chunk of live.preOpenQueue) {
        ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: chunk }));
      }
      live.preOpenQueue = [];
    });

    ws.addEventListener("message", (event) => {
      if (liveRef.current !== live) return;
      try {
        const msg = JSON.parse(event.data as string) as { message_type: string; text?: string; error?: string };
        if (msg.message_type === "partial_transcript") {
          live.partial = msg.text ?? "";
        } else if (
          (msg.message_type === "committed_transcript" || msg.message_type === "committed_transcript_with_timestamps") &&
          msg.text
        ) {
          /* Straight into the draft, mid-recording. */
          live.partial = "";
          onLiveCommit(msg.text);
        } else if (
          msg.message_type === "auth_error" ||
          msg.message_type === "error" ||
          msg.message_type === "invalid_request" ||
          msg.message_type === "quota_exceeded"
        ) {
          onError(msg.error || t("dictation.liveError"));
          finishLive(live);
          return;
        }
        setLiveText(live.partial);
      } catch {
        /* non-JSON frame — ignore */
      }
    });

    ws.addEventListener("close", () => {
      /* Unexpected drop mid-recording: keep what was already transcribed. */
      if (liveRef.current === live && !pendingRef.current) {
        onError(t("dictation.connectionLost"));
        finishLive(live);
      }
    });

    return true;
  };

  const start = async () => {
    /* getUserMedia can hang on a permission prompt; a second tap during that
       wait would spin up a second recorder over the first and leak its stream. */
    if (startingRef.current || recRef.current || liveRef.current) return;
    startingRef.current = true;
    setPhase("starting");
    discardRef.current = false;
    let stream: MediaStream | null = null;
    let streamOwned = true;
    try {
      /* The token mint needs no stream, so both round-trips overlap and the
         press only waits for the slower one (usually the mic itself). A
         prewarmed token makes takeLiveToken resolve instantly. */
      const [mediaStream, token] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }),
        takeLiveToken(),
      ]);
      stream = mediaStream;
      if (!mountedRef.current || discardRef.current) return;
      setLiveText("");

      const liveStarted = token !== null && startLive(stream, token);
      if (!liveStarted) {
        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/webm")
            ? "audio/webm"
            : "";
        const rec = mimeType
          ? new MediaRecorder(stream, { mimeType, audioBitsPerSecond: BATCH_BITRATE })
          : new MediaRecorder(stream, { audioBitsPerSecond: BATCH_BITRATE });
        chunksRef.current = [];
        rec.ondataavailable = (event) => {
          if (event.data.size) chunksRef.current.push(event.data);
        };
        rec.onstop = () => {
          void finishBatch();
        };
        rec.start(250);
        recRef.current = rec;
      }
      streamOwned = false;
      startMeter(stream);
      /* A fresh recording clears any lingering cap-stopped chip / SR text from
         a previous run so the new session starts clean. */
      clearCapHold();
      setCapStopped(false);
      setSrMessage("");
      elapsedRef.current = 0;
      setElapsed(0);
      setPhase("rec");
      timerRef.current = window.setInterval(() => {
        const prev = elapsedRef.current;
        const next = prev + 1;
        elapsedRef.current = next;
        setElapsed(next);
        const cues = dictationCues(prev, next, MAX_SECONDS);
        /* Near-cap warning: announce once, then the single ping once. */
        if (cues.warn) setSrMessage(t("dictation.capWarn"));
        if (cues.ping) chime("dictWarn", 0);
        if (cues.capped) {
          flagCapStopped();
          /* The transcript is preserved and reviewed, never auto-sent: the
             stop resolves through onUnclaimedText (no pending stop() waits). */
          if (recRef.current?.state === "recording") recRef.current.stop();
          else if (liveRef.current) finishLive(liveRef.current);
        }
      }, 1_000);
    } catch {
      if (mountedRef.current) onError(stream ? t("dictation.unsupported") : t("dictation.noMic"));
    } finally {
      if (streamOwned) stopStream(stream);
      startingRef.current = false;
      /* Success flipped the phase to "rec" already; any bail-out (denied
         permission, discard mid-start, unmount race) returns to idle. */
      if (mountedRef.current) setPhase((prev) => (prev === "starting" ? "idle" : prev));
    }
  };

  const stop = (): Promise<string | null> => {
    return new Promise((resolve) => {
      const live = liveRef.current;
      if (live) {
        /* Instant: the current partial IS the tail — no waiting for the
           server to confirm it. finishLive resolves synchronously. */
        pendingRef.current = resolve;
        finishLive(live);
        return;
      }
      const rec = recRef.current;
      if (!rec || rec.state !== "recording") {
        resolve(null);
        return;
      }
      pendingRef.current = resolve;
      rec.stop();
    });
  };

  const discard = () => {
    discardRef.current = true;
    if (recRef.current?.state === "recording") recRef.current.stop();
    else if (liveRef.current) finishLive(liveRef.current);
  };

  return {
    phase,
    elapsed,
    maxSeconds: MAX_SECONDS,
    remaining: remainingSeconds(elapsed, MAX_SECONDS),
    capStopped,
    srMessage,
    liveText,
    canvasRef,
    start,
    stop,
    discard,
  };
}
