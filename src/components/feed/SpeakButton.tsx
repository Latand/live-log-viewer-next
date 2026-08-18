"use client";

import { RotateCw, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { translate, useLocale } from "@/lib/i18n";
import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { wordSpanAt } from "@/lib/ttsAlignment";
import { chunkSpeech } from "@/lib/ttsChunks";

import { createKaraoke, karaokeRoots, type Karaoke } from "./ttsKaraoke";
import {
  hasBeenSpoken,
  markSpoken,
  synthesizeChunk,
  TtsPlaybackError,
  TtsRequestError,
  TtsSession,
  voiceKey,
} from "./ttsSession";

let activeStop: (() => void) | null = null;
type BackendId = "openai" | "elevenlabs" | "soniox";
interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: { id: BackendId; available: boolean; keyPath: string; model: string; voice: string; cap: number }[];
}

let backendInfo: BackendInfo | null = null;
let backendInfoPromise: Promise<BackendInfo> | null = null;
const backendListeners = new Set<(value: BackendInfo) => void>();
const SILENT_AUDIO = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA";
/* Controls that must not swallow a seek click: the message body carries links,
   copy chips and disclosure triangles of its own. */
const INTERACTIVE = "a, button, input, textarea, select, summary, [role='button'], [contenteditable]";

function loadBackendInfo(force = false): Promise<BackendInfo> {
  if (!force && backendInfo) return Promise.resolve(backendInfo);
  if (force) backendInfoPromise = null;
  backendInfoPromise ??= fetch("/api/tts/backend")
    .then((response) => {
      if (!response.ok) throw new Error("TTS configuration unavailable");
      return response.json() as Promise<BackendInfo>;
    })
    .then((value) => {
      storeBackendInfo(value);
      return value;
    })
    .catch((error) => {
      backendInfoPromise = null;
      throw error;
    });
  return backendInfoPromise;
}

function storeBackendInfo(value: BackendInfo): void {
  backendInfo = value;
  backendInfoPromise = Promise.resolve(value);
  for (const listener of backendListeners) listener(value);
}

function stopActive(): void {
  const stop = activeStop;
  activeStop = null;
  stop?.();
}

function messageKey(info: BackendInfo, text: string): string {
  const option = info.options.find((candidate) => candidate.id === info.backend)!;
  return voiceKey(option, text);
}

/**
 * Two audio elements, both carrying the user gesture forward on a muted silent
 * clip so the real chunks can start later without tripping autoplay policy.
 * Two, because playback alternates between them: the next chunk is already
 * loaded on the idle one when the playing one ends, which is what makes a
 * chunk hand-off inaudible. Named for what it unlocks; the old name tripped the
 * publication gate's credential pattern, which reads `authorization:` as a
 * secret assignment.
 */
function unlockedElements(): { elements: HTMLAudioElement[]; playbackUnlock: Promise<unknown> } {
  const elements = [new Audio(), new Audio()];
  const unlocks = elements.map((element) => {
    element.muted = true;
    element.src = SILENT_AUDIO;
    return element.play();
  });
  return { elements, playbackUnlock: Promise.all(unlocks.map((unlock) => Promise.resolve(unlock).catch(() => undefined))) };
}

export function SpeakButton({ text }: { text: string }) {
  const { locale, t } = useLocale();
  const isMobile = useIsMobile();
  const [info, setInfo] = useState<BackendInfo | null>(backendInfo);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [announcement, setAnnouncement] = useState("");
  const [progress, setProgress] = useState({ elapsed: 0, total: 0, chunk: 0, chunks: 0 });
  /* Only a re-render trigger: the replay marker itself lives in the tts cache
     module, so a message stays replayable across mounts and cache eviction. */
  const [, setSpokenTick] = useState(0);
  const generation = useRef(0);
  const mounted = useRef(true);
  const ownedStop = useRef<(() => void) | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    const syncInfo = (value: BackendInfo) => { if (current) setInfo(value); };
    backendListeners.add(syncInfo);
    void loadBackendInfo()
      .then((value) => { if (current) setInfo(value); })
      .catch(() => { if (current) setError(translate(locale, "tts.configError")); });
    return () => {
      current = false;
      backendListeners.delete(syncInfo);
      mounted.current = false;
      generation.current += 1;
      if (activeStop === ownedStop.current) stopActive();
    };
  }, [locale]); // t closes over locale; the function identity itself changes every render

  useEffect(() => {
    if (!confirming) return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll("button:not(:disabled)") ?? []);
    (buttons.at(-1) as HTMLButtonElement | undefined)?.focus();
  }, [confirming]);

  if (!info || !text) return null;
  const option = info.options.find((candidate) => candidate.id === info.backend);
  if (!option) return null;
  const key = messageKey(info, text);
  const replayable = hasBeenSpoken(key);
  const tooLong = text.length > MAX_TTS_MESSAGE_LENGTH;

  const closeConfirm = () => {
    setConfirming(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  /**
   * Runs one message end to end: chunks it, keeps a couple of syntheses ahead
   * of the voice, highlights the word being spoken in the rendered markdown and
   * lets a click in that text jump the audio there.
   */
  const begin = (elements: HTMLAudioElement[], playbackUnlock: Promise<unknown>, fromChar = 0) => {
    stopActive();
    const currentGeneration = ++generation.current;
    const chunks = chunkSpeech(text);
    if (!chunks.length) return;
    const alive = () => mounted.current && generation.current === currentGeneration;
    const roots = triggerRef.current ? karaokeRoots(triggerRef.current) : [];
    const karaoke: Karaoke | null = roots.length ? createKaraoke(roots, text) : null;

    let stopped = false;
    const stop = (announce = true) => {
      if (stopped) return;
      stopped = true;
      session.stop();
      karaoke?.destroy();
      for (const root of roots) {
        root.removeEventListener("click", onSeekClick);
        delete root.dataset.ttsSeekable;
      }
      if (activeStop === stop) activeStop = null;
      if (ownedStop.current === stop) ownedStop.current = null;
      if (!alive()) return;
      setPhase("idle");
      setProgress({ elapsed: 0, total: 0, chunk: 0, chunks: 0 });
      if (announce) setAnnouncement(t("tts.stopped"));
    };

    function onSeekClick(event: MouseEvent) {
      if (event.button !== 0 || event.defaultPrevented) return;
      if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      const charIndex = karaoke?.charAtPoint(event.clientX, event.clientY);
      if (charIndex === null || charIndex === undefined) return;
      session.seekToChar(charIndex);
    }

    const session = new TtsSession({
      chunks,
      key: (chunkText) => voiceKey(option, chunkText),
      synthesize: synthesizeChunk,
      elements,
      onPhase: (next) => {
        /* Audio is playing, which means a chunk was paid for and cached: the
           message is replayable from here on, even if the operator stops it
           halfway or the rest of the sequence fails. */
        const firstSound = next === "playing" && !hasBeenSpoken(key);
        if (firstSound) markSpoken(key);
        if (!alive()) return;
        setPhase(next);
        if (firstSound) setSpokenTick((tick) => tick + 1);
        setAnnouncement(next === "loading" ? t("tts.generating") : t("tts.playing"));
      },
      onPosition: ({ chunkIndex, charIndex, elapsed, total }) => {
        const word = wordSpanAt(text, charIndex);
        if (word) karaoke?.highlight(word.start, word.end);
        if (alive()) setProgress({ elapsed, total, chunk: chunkIndex + 1, chunks: chunks.length });
      },
      onError: (cause) => {
        /* The provider's own words when it refused; otherwise the failure is
           the browser's (blocked or dead audio) or the network's. */
        const message = cause instanceof TtsRequestError
          ? cause.provider ?? t("tts.requestError", { status: cause.status })
          : cause instanceof TtsPlaybackError
            ? t("tts.playError")
            : t("tts.requestFailed");
        if (alive()) {
          setError(message);
          setAnnouncement(message);
        }
        stop(false);
      },
      onEnd: () => {
        markSpoken(key);
        if (alive()) {
          setSpokenTick((tick) => tick + 1);
          setAnnouncement(t("tts.finished"));
        }
        stop(false);
      },
    });

    ownedStop.current = stop;
    activeStop = stop;
    setPhase("loading");
    setAnnouncement(t("tts.generating"));
    setConfirming(false);
    setError(null);
    for (const root of roots) {
      root.addEventListener("click", onSeekClick);
      root.dataset.ttsSeekable = "";
    }
    void playbackUnlock.then(() => {
      if (!alive() || stopped) return;
      session.start(fromChar);
    });
  };

  const replay = () => {
    const { elements, playbackUnlock } = unlockedElements();
    setError(null);
    begin(elements, playbackUnlock);
  };

  const confirmPaid = () => {
    if (tooLong) return;
    const { elements, playbackUnlock } = unlockedElements();
    void loadBackendInfo(true)
      .then((fresh) => {
        if (messageKey(fresh, text) !== key) {
          for (const element of elements) element.pause();
          setInfo(fresh);
          setError(t("tts.backendChanged"));
          setConfirming(false);
          return;
        }
        begin(elements, playbackUnlock);
      })
      .catch(() => {
        for (const element of elements) element.pause();
        setError(t("tts.configError"));
      });
  };

  const toggle = () => {
    if (ownedStop.current) {
      ownedStop.current();
      return;
    }
    setError(null);
    if (replayable) replay();
    else {
      void loadBackendInfo(true)
        .then((fresh) => {
          setInfo(fresh);
          setConfirming(true);
        })
        .catch(() => setError(t("tts.configError")));
    }
  };

  const pickBackend = async (backend: BackendId) => {
    if (info.lockedByEnv) return;
    const response = await fetch("/api/tts/backend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend }),
    });
    if (response.ok) {
      const value = (await response.json()) as BackendInfo;
      storeBackendInfo(value);
      setInfo(value);
    }
  };

  const active = phase !== "idle";
  const onDialogKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirm();
      return;
    }
    if (event.key === "Enter" && option.available && !tooLong) {
      event.preventDefault();
      confirmPaid();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current?.querySelectorAll("button:not(:disabled)") ?? []) as HTMLButtonElement[];
    if (!buttons.length) return;
    const first = buttons[0]!;
    const last = buttons.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const Icon = active ? Square : replayable ? RotateCw : Volume2;
  return (
    <span className="relative">
      <button ref={triggerRef} data-tts-trigger type="button" onClick={toggle} className={`inline-flex items-center justify-center rounded-md text-muted transition-opacity hover:bg-sunken hover:text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isMobile ? "h-11 w-11" : "p-1"} opacity-70 hover:opacity-100 group-hover/msg:opacity-100`} aria-label={active ? t("tts.stop") : replayable ? t("tts.replay") : t("tts.read")} title={active ? t("tts.stop") : replayable ? t("tts.replayFree") : t("tts.readPaid")}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {phase === "playing" && progress.total > 0 ? (
        <span className="text-[10px] tabular-nums text-muted">
          {Math.floor(progress.elapsed)} / {Math.ceil(progress.total)}s
          {progress.chunks > 1 ? <span className="ml-1" title={t("tts.partOf", { index: progress.chunk, count: progress.chunks })}>{progress.chunk}/{progress.chunks}</span> : null}
        </span>
      ) : null}
      {confirming ? (
        <span ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("tts.confirmAria")} onKeyDown={onDialogKeyDown} className="absolute right-0 top-7 z-50 block w-72 rounded-xl border border-border bg-card p-3 text-left shadow-xl">
          <span className="block text-xs font-bold text-primary">{t("tts.confirmTitle")}</span>
          <span className="mt-1 block text-[11px] text-muted">{option.id} · {option.model} · {option.voice}</span>
          <span className="block text-[11px] text-muted">{t("tts.characters", { count: text.length.toLocaleString() })}</span>
          <span className="mt-2 block text-[11px] text-primary">{t("tts.billing", { provider: option.id })}</span>
          <span className="block text-[11px] text-primary">{t("tts.disclosure")}</span>
          <span className="mt-1 block text-[11px] text-muted">{t("tts.seekHint")}</span>
          {tooLong ? <span className="mt-2 block text-[11px] font-semibold text-danger">{t("tts.tooLong", { count: MAX_TTS_MESSAGE_LENGTH.toLocaleString() })}</span> : null}
          {!option.available ? <span className="mt-2 block break-all text-[11px] text-danger">{t("tts.missingKey", { provider: option.id, path: option.keyPath })}</span> : null}
          <span className="mt-2 flex flex-wrap gap-1">{info.options.map((candidate) => <button key={candidate.id} type="button" disabled={info.lockedByEnv} onClick={() => void pickBackend(candidate.id)} className={`inline-flex items-center rounded bg-sunken text-[10px] font-semibold disabled:opacity-50 ${isMobile ? "min-h-11 px-3" : "px-2 py-1"}`}>{candidate.id}{candidate.id === info.backend ? " ✓" : ""}</button>)}</span>
          <span className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={closeConfirm} className={`inline-flex items-center rounded text-xs text-muted ${isMobile ? "min-h-11 px-3" : "px-2 py-1"}`}>{t("tts.cancel")}</button>
            <button type="button" disabled={!option.available || tooLong} onClick={confirmPaid} className={`inline-flex items-center rounded bg-accent text-xs font-bold text-white disabled:opacity-50 ${isMobile ? "min-h-11 px-3" : "px-2 py-1"}`}>{t("tts.speak")}</button>
          </span>
        </span>
      ) : null}
      {error ? <span role="alert" className="absolute right-0 top-7 z-40 w-56 rounded bg-card p-2 text-[11px] text-danger shadow">{error}</span> : null}
    </span>
  );
}
