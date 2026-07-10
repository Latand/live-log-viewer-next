"use client";

import { useEffect, useRef, useState } from "react";

import { Check, Copy, Loader2, Mic, Square, X } from "@/components/icons";
import { fmtElapsed, METER_HEIGHT, METER_WIDTH, prewarmLiveToken, type UseDictationResult } from "@/hooks/useDictation";
import { micVisual } from "@/lib/dictationTimer";
import { translate, useLocale } from "@/lib/i18n";

export interface MicButtonViewProps extends UseDictationResult {
  onText: (text: string) => void;
  /** Extra external busy flag (e.g. a caller mid stop-and-send) that blocks
      starting a new recording on top of the hook's own "busy" phase. */
  busy?: boolean;
}

type BackendId = "local" | "chatgpt" | "elevenlabs";

interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: { id: BackendId; available: boolean; keyPath: string }[];
}

/**
 * Right-click menu of the mic button: pick which transcription engine handles
 * dictation. Options carry a one-line description; an option whose credential
 * is missing opens a key panel with the exact path to drop it into, copyable.
 */
function BackendMenu({ onClose }: { onClose: () => void }) {
  const { locale, t } = useLocale();
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<BackendId | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState<BackendId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcribe/backend")
      .then((res) => res.json() as Promise<BackendInfo>)
      .then((json) => {
        if (!cancelled && Array.isArray(json.options)) setInfo(json);
      })
      .catch(() => {
        if (!cancelled) setError(translate(locale, "common.serverUnavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  /* Click-away and Escape both dismiss; the menu never outlives the composer. */
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const pick = async (id: BackendId, available: boolean) => {
    if (!info || info.lockedByEnv || saving) return;
    if (!available) {
      setKeyFor(id);
      setCopied(false);
      return;
    }
    setSaving(id);
    setError(null);
    try {
      const res = await fetch("/api/transcribe/backend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend: id }),
      });
      const json = (await res.json()) as BackendInfo & { error?: string };
      if (!res.ok) {
        setError(json.error ?? t("mic.saveFailed"));
        return;
      }
      setInfo(json);
      onClose();
    } catch {
      setError(t("common.serverUnavailable"));
    } finally {
      setSaving(null);
    }
  };

  const keyOption = keyFor && info ? info.options.find((option) => option.id === keyFor) : null;

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={t("mic.menuTitle")}
      className="absolute bottom-[calc(100%+6px)] right-0 z-40 w-[300px] rounded-[12px] border border-line bg-panel p-1.5 shadow-[0_10px_36px_rgb(20_20_30/0.18)]"
    >
      {keyOption ? (
        <div className="flex flex-col gap-2 p-2">
          <span className="text-[12px] font-bold text-err">
            {t("mic.keyTitle", { name: t(`stt.${keyOption.id}.name`) })}
          </span>
          <span className="text-[11.5px] leading-snug text-ink">{t(`stt.${keyOption.id}.fix`)}</span>
          <span className="flex items-center gap-1 rounded-[8px] border border-line bg-bg px-2 py-1.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-ink">{keyOption.keyPath}</code>
            <button
              type="button"
              aria-label={t("mic.copyPath")}
              title={t("mic.copyPath")}
              className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-line bg-panel px-1.5 py-1 text-[10px] font-semibold text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              onClick={() => {
                void navigator.clipboard.writeText(keyOption.keyPath).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="h-3 w-3 text-ok" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? t("mic.copied") : t("mic.copy")}
            </button>
          </span>
          <button
            type="button"
            className="self-start rounded-[8px] px-2 py-1 text-[11px] font-semibold text-dim hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            onClick={() => setKeyFor(null)}
          >
            ← {t("mic.back")}
          </button>
        </div>
      ) : (
        <>
          <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-wide text-dim">
            {t("mic.menuTitle")}
          </div>
          {info?.lockedByEnv ? (
            <div className="px-2 pb-1 text-[10.5px] text-err">{t("mic.menuLocked")}</div>
          ) : null}
          {!info && !error ? (
            <div className="flex items-center gap-2 px-2 py-2 text-[11.5px] text-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {t("mic.menuLoading")}
            </div>
          ) : null}
          {(info?.options ?? []).map((option) => {
            const active = info?.backend === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={Boolean(info?.lockedByEnv) || saving !== null}
                onClick={() => void pick(option.id, option.available)}
                className={`flex w-full items-start gap-2 rounded-[9px] px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
                  active ? "bg-accent/10" : "hover:bg-bg"
                }`}
              >
                <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {saving === option.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-dim" aria-hidden />
                  ) : active ? (
                    <Check className="h-3.5 w-3.5 text-accent" aria-hidden />
                  ) : (
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: option.available ? "#1a8a3e" : "#e0ae45" }}
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
                    {t(`stt.${option.id}.name`)}
                    {!option.available ? (
                      <span className="rounded-full bg-[#fdf3dd] px-1.5 py-px text-[9.5px] font-bold text-[#b07d1f]">
                        {t("mic.noKey")}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[10.5px] leading-snug text-dim">{t(`stt.${option.id}.desc`)}</span>
                </span>
              </button>
            );
          })}
          {error ? <div className="px-2 py-1 text-[10.5px] font-semibold text-err">{error}</div> : null}
        </>
      )}
    </div>
  );
}

/**
 * Presentational dictation control driven by a `useDictation` instance handed
 * down by the caller, so a composer that orchestrates its own send button
 * around the same recording (see TmuxComposer) shares one hook instance.
 * Right-click (long-press on touch) opens the transcription-backend menu.
 */
export function MicButtonView({
  phase,
  elapsed,
  maxSeconds,
  remaining,
  capStopped,
  srMessage,
  canvasRef,
  start,
  stop,
  discard,
  onText,
  busy = false,
}: MicButtonViewProps) {
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const visual = micVisual({ phase, elapsed, maxSeconds, capStopped });
  const handleMain = () => {
    if (busy) return;
    if (phase === "idle") void start();
    else if (phase === "rec") {
      void stop().then((text) => {
        if (text) onText(text);
      });
    }
  };

  /* Owned here so it covers every mic-hosting surface (composers and the task
     edit field alike): the near-cap warning and the cap stop are announced to
     assistive tech even when the visual cue is off-screen. Polite, and always
     mounted so a first message isn't missed by an appearing region. */
  const srRegion = (
    <span role="status" aria-live="polite" className="sr-only">
      {srMessage}
    </span>
  );

  if (phase === "rec") {
    const warn = visual === "recWarn";
    return (
      <span className="flex shrink-0 items-center gap-1">
        {srRegion}
        <button
          type="button"
          aria-label={t("mic.stopRecognize")}
          title={warn ? t("mic.timeLeft", { time: fmtElapsed(remaining) }) : undefined}
          onClick={handleMain}
          className={`flex items-center gap-1.5 rounded-[8px] border px-2 py-2 text-[11px] font-bold tabular-nums focus-visible:outline-none focus-visible:ring-2 ${
            warn
              ? "border-[#e0ae45]/70 bg-[#fdf3dd] text-[#b07d1f] focus-visible:ring-[#e0ae45]/50"
              : "border-err/50 bg-[#fff2f2] text-err focus-visible:ring-err/40"
          }`}
        >
          <canvas ref={canvasRef} width={METER_WIDTH} height={METER_HEIGHT} className="h-4 w-14" aria-hidden />
          {warn ? `−${fmtElapsed(remaining)}` : fmtElapsed(elapsed)}
        </button>
        <button
          type="button"
          aria-label={t("mic.cancel")}
          onClick={discard}
          className="inline-flex items-center justify-center rounded-[8px] border border-line bg-panel p-2 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  /* The held "stopped at the cap" chip: distinct amber outline, and the
     transcription spinner rides inside it while a batch recording resolves. */
  if (visual === "capStopped") {
    return (
      <span className="flex shrink-0 items-center gap-1">
        {srRegion}
        <span className="flex items-center gap-1.5 rounded-[8px] border border-[#e0ae45]/70 bg-[#fdf3dd] px-2 py-2 text-[11px] font-bold text-[#b07d1f]">
          {phase === "busy" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Square className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
          )}
          {t("mic.capStopped")}
        </span>
      </span>
    );
  }

  return (
    <span className="relative inline-flex shrink-0">
      {srRegion}
      <button
        type="button"
        aria-label={phase === "busy" ? t("mic.recognizing") : phase === "starting" ? t("mic.connecting") : t("mic.dictate")}
        title={phase === "busy" ? t("mic.recognizing") : phase === "starting" ? t("mic.connecting") : t("mic.dictateHint")}
        disabled={phase !== "idle" || busy}
        onClick={handleMain}
        /* Hover/focus telegraphs an imminent press — mint the live token now
           so the press itself only waits for the microphone. */
        onPointerEnter={prewarmLiveToken}
        onFocus={prewarmLiveToken}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((open) => !open);
        }}
        className={`inline-flex shrink-0 items-center justify-center rounded-[8px] border p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60 ${
          phase === "starting" ? "border-accent/40 bg-accent/10 text-accent" : "border-line bg-panel text-dim hover:text-accent"
        }`}
      >
        {phase === "busy" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : phase === "starting" ? (
          /* No pulse under reduced-motion: the accent tint alone signals it. */
          <Mic className="h-4 w-4 animate-pulse motion-reduce:animate-none" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </button>
      {menuOpen ? <BackendMenu onClose={() => setMenuOpen(false)} /> : null}
    </span>
  );
}
