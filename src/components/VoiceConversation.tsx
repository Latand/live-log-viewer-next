"use client";

import { useEffect, useRef, useState } from "react";

import { AudioLines } from "lucide-react";

import { Loader2, RotateCw, Square } from "@/components/icons";
import { Hint } from "@/components/Hint";
import type { TFunction } from "@/lib/i18n";
import type {
  CodexRealtimeLine,
  CodexRealtimePhase,
} from "@/lib/realtime/codexRealtimeClient";

export function VoiceConversationButton({
  phase,
  start,
  stop,
  t,
}: {
  phase: CodexRealtimePhase;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  t: TFunction;
}) {
  const active = phase === "connecting" || phase === "live" || phase === "stopping";
  const busy = phase === "connecting" || phase === "stopping";
  const label = phase === "connecting"
    ? t("voice.connecting")
    : phase === "stopping"
      ? t("voice.stopping")
      : active
        ? t("voice.stop")
        : t("voice.start");
  return (
    <Hint label={label} align="right">
      <button
        type="button"
        data-testid="voice-call-button"
        aria-label={label}
        aria-pressed={active}
        onClick={() => void (active ? stop() : start())}
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          active
            ? "border-danger/60 bg-danger/10 text-danger hover:bg-danger/20"
            : "border-border text-muted hover:bg-sunken hover:text-accent"
        }`}
      >
        {busy
          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          : active
            ? <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
            : <AudioLines className="h-4 w-4" aria-hidden />}
      </button>
    </Hint>
  );
}

function speaker(line: CodexRealtimeLine, t: TFunction): string {
  if (line.role === "user") return t("voice.you");
  if (line.role === "progress") return t("voice.progress");
  return t("voice.agent");
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Wall-clock length of the current call. A call is the one thing on this
    surface with no other visible duration: without it a stalled connection and
    a working one look identical. */
function CallTimer({ startedAt, t }: { startedAt: number; t: TFunction }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span
      className="font-mono tabular-nums text-caption text-secondary"
      aria-label={t("voice.elapsed")}
      data-testid="voice-elapsed"
    >
      {clock((now - startedAt) / 1000)}
    </span>
  );
}

const METER_BARS = [0, 1, 2, 3] as const;

/**
 * Live microphone level, drawn straight to the DOM from a rAF loop.
 *
 * The operator's first question on a voice surface is whether the machine can
 * hear them at all; a transcript answers that only after the backend has
 * already decided. Level metering runs outside React on purpose — sixty state
 * updates a second through `useSyncExternalStore` would re-render the whole
 * composer for an animation.
 */
function MicLevelMeter({ stream, t }: { stream: MediaStream | null; t: TFunction }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    const Ctor = typeof window === "undefined"
      ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!stream || !Ctor || typeof requestAnimationFrame !== "function") return;
    let context: AudioContext;
    try {
      context = new Ctor();
    } catch {
      /* No audio graph available (locked-down browser, test DOM): the static
         bars below still communicate that a call is up. */
      return;
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const draw = () => {
      analyser.getByteFrequencyData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.min(1, Math.sqrt(sum / samples.length) / 90);
      bars.current.forEach((bar, index) => {
        if (!bar) return;
        /* Outer bars need more signal than inner ones, so quiet speech still
           reads as movement instead of an all-or-nothing flash. */
        const threshold = 0.25 + index * 0.12;
        const height = 3 + Math.max(0, level - threshold * 0.4) * 26;
        bar.style.height = `${Math.min(14, height).toFixed(1)}px`;
        bar.style.opacity = level > threshold * 0.5 ? "1" : "0.45";
      });
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      void context.close().catch(() => undefined);
    };
  }, [stream]);
  return (
    <span
      className="flex h-4 items-center gap-[2px]"
      role="img"
      aria-label={t("voice.micLevel")}
      data-testid="voice-mic-level"
    >
      {METER_BARS.map((index) => (
        <span
          key={index}
          ref={(node) => { bars.current[index] = node; }}
          className="w-[2px] rounded-full bg-success/80 transition-[height] duration-75"
          style={{ height: "3px", opacity: 0.45 }}
        />
      ))}
    </span>
  );
}

/** The transcript follows the newest line unless the operator has scrolled up
    to read something — hijacking their scroll position mid-call is worse than
    a missed line they can reach in one gesture. */
function useFollowLatest(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const node = ref.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };
  return { ref, onScroll };
}

export function VoiceConversationPanel({
  phase,
  lines,
  error,
  startedAt = null,
  stream = null,
  onRetry,
  t,
}: {
  phase: CodexRealtimePhase;
  lines: readonly CodexRealtimeLine[];
  error: string | null;
  /** Epoch ms the current call went live; null before it does. */
  startedAt?: number | null;
  /** The live microphone stream, for the level meter. */
  stream?: MediaStream | null;
  onRetry?: () => void;
  t: TFunction;
}) {
  const { ref, onScroll } = useFollowLatest(lines);
  if (phase === "idle" && lines.length === 0 && !error) return null;
  const live = phase === "live";
  const status = phase === "connecting"
    ? t("voice.connecting")
    : phase === "stopping"
      ? t("voice.stopping")
      : live
        ? t("voice.live")
        : phase === "error"
          ? t("voice.failed")
          : t("voice.ended");
  return (
    <section
      aria-label={t("voice.panel")}
      data-phase={phase}
      className={`overflow-hidden rounded-control border bg-raised/70 ${
        phase === "error" ? "border-danger/40" : live ? "border-success/40" : "border-border"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            live
              ? "animate-pulse bg-success"
              : phase === "error"
                ? "bg-danger"
                : phase === "idle"
                  ? "bg-muted"
                  : "bg-accent"
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-caption text-muted" role="status">{status}</span>
        {live && startedAt !== null ? <CallTimer startedAt={startedAt} t={t} /> : null}
        {live ? <MicLevelMeter stream={stream} t={t} /> : null}
      </header>

      <div
        ref={ref}
        onScroll={onScroll}
        aria-live="polite"
        className="max-h-48 space-y-1.5 overflow-y-auto p-2"
      >
        {lines.map((line, index) => {
          /* Consecutive turns from one speaker carry one label, chat-style. A
             fixed label column would have to fit the longest word in every
             translation ("ПЕРЕБІГ" overruns what "YOU" needs), and a rigid
             column that wide steals the text's width on a phone. */
          const opensTurn = lines[index - 1]?.role !== line.role;
          return (
            <div key={line.id} className={opensTurn && index > 0 ? "pt-1" : undefined}>
              {opensTurn ? (
                <span
                  className={`block text-caption uppercase tracking-wide ${
                    line.role === "progress"
                      ? "text-accent"
                      : line.role === "user"
                        ? "text-secondary"
                        : "text-success"
                  }`}
                >
                  {speaker(line, t)}
                </span>
              ) : null}
              <span
                className={`block text-label leading-snug ${
                  line.role === "progress" && !line.final ? "text-muted" : "text-primary"
                }`}
              >
                {line.text}
                {!line.final ? (
                  <span className="ml-0.5 inline-block h-3 w-px animate-pulse bg-current align-middle" aria-hidden />
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {/* A failed call is the one state that needs an action attached: the
          reason comes from the backend verbatim (#664) and the operator's next
          move is almost always to try again. */}
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-danger/30 bg-danger/5 px-2 py-1.5"
        >
          <p className="min-w-0 flex-1 text-label text-danger">{error}</p>
          {onRetry ? (
            <button
              type="button"
              data-testid="voice-retry"
              onClick={onRetry}
              className="inline-flex shrink-0 items-center gap-1 rounded-control border border-danger/40 px-1.5 py-0.5 text-caption text-danger hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
            >
              <RotateCw className="h-3 w-3" aria-hidden />
              {t("voice.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
