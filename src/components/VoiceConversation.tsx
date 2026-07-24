"use client";

import { AudioLines } from "lucide-react";

import { Loader2, Square } from "@/components/icons";
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

export function VoiceConversationPanel({
  phase,
  lines,
  error,
  t,
}: {
  phase: CodexRealtimePhase;
  lines: readonly CodexRealtimeLine[];
  error: string | null;
  t: TFunction;
}) {
  if (phase === "idle" && lines.length === 0 && !error) return null;
  const status = phase === "connecting"
    ? t("voice.connecting")
    : phase === "stopping"
      ? t("voice.stopping")
      : phase === "live"
        ? t("voice.live")
        : phase === "error"
          ? t("voice.failed")
          : "";
  return (
    <section
      aria-label={t("voice.panel")}
      className="max-h-48 space-y-1.5 overflow-y-auto rounded-control border border-border bg-raised/70 p-2"
    >
      {status ? (
        <div className="flex items-center gap-1.5 text-caption text-muted" role="status">
          <span className={`h-1.5 w-1.5 rounded-full ${phase === "live" ? "bg-success" : "bg-accent"}`} />
          {status}
        </div>
      ) : null}
      {lines.map((line) => (
        <div key={line.id} className="grid grid-cols-[auto_1fr] gap-1.5 text-label leading-snug">
          <span className={line.role === "progress" ? "text-accent" : "font-semibold text-secondary"}>
            {speaker(line, t)}
          </span>
          <span className={line.role === "progress" && !line.final ? "text-muted" : "text-primary"}>
            {line.text}
          </span>
        </div>
      ))}
      {error ? <p className="text-label text-danger">{error}</p> : null}
    </section>
  );
}
