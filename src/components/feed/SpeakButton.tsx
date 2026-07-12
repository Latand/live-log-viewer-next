"use client";

import { Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { translate, useLocale } from "@/lib/i18n";
import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

let activeStop: (() => void) | null = null;
type BackendId = "openai" | "elevenlabs";
interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: { id: BackendId; available: boolean; keyPath: string; model: string; voice: string; cap: number }[];
}
interface AudioCacheEntry { url: string; bytes: number }

let backendInfo: BackendInfo | null = null;
let backendInfoPromise: Promise<BackendInfo> | null = null;
const backendListeners = new Set<(value: BackendInfo) => void>();
const audioCache = new Map<string, AudioCacheEntry>();
let cachedBytes = 0;
const MAX_CACHE_ENTRIES = 8;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const SILENT_AUDIO = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA";

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

function cacheKey(info: BackendInfo, text: string): string {
  const option = info.options.find((candidate) => candidate.id === info.backend)!;
  return `${option.id}\0${option.model}\0${option.voice}\0${text.slice(0, MAX_TTS_TEXT_LENGTH)}`;
}

function cacheAudio(key: string, blob: Blob): AudioCacheEntry {
  const existing = audioCache.get(key);
  if (existing) return existing;
  const entry = { url: URL.createObjectURL(blob), bytes: blob.size };
  audioCache.set(key, entry);
  cachedBytes += entry.bytes;
  while (audioCache.size > MAX_CACHE_ENTRIES || (cachedBytes > MAX_CACHE_BYTES && audioCache.size > 1)) {
    const oldest = audioCache.entries().next().value as [string, AudioCacheEntry] | undefined;
    if (!oldest) break;
    audioCache.delete(oldest[0]);
    cachedBytes -= oldest[1].bytes;
    URL.revokeObjectURL(oldest[1].url);
  }
  return entry;
}

export function SpeakButton({ text }: { text: string }) {
  const { locale, t } = useLocale();
  const [info, setInfo] = useState<BackendInfo | null>(backendInfo);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [announcement, setAnnouncement] = useState("");
  const [timing, setTiming] = useState({ elapsed: 0, total: 0 });
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
  const key = cacheKey(info, text);
  const cached = audioCache.get(key);

  const closeConfirm = () => {
    setConfirming(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const playAudio = (audio: HTMLAudioElement, currentGeneration: number) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      audio.pause();
      if (activeStop === cleanup) activeStop = null;
      if (ownedStop.current === cleanup) ownedStop.current = null;
      if (mounted.current && generation.current === currentGeneration) {
        setPhase("idle");
        setAnnouncement(t("tts.stopped"));
        setTiming({ elapsed: 0, total: 0 });
      }
    };
    ownedStop.current = cleanup;
    activeStop = cleanup;
    audio.onloadedmetadata = () => setTiming({ elapsed: audio.currentTime, total: Number.isFinite(audio.duration) ? audio.duration : 0 });
    audio.ontimeupdate = () => setTiming({ elapsed: audio.currentTime, total: Number.isFinite(audio.duration) ? audio.duration : 0 });
    audio.onended = cleanup;
    audio.onerror = cleanup;
    setPhase("playing");
    setAnnouncement(t("tts.playing"));
    return { cleanup };
  };

  const replay = () => {
    if (!cached) return;
    audioCache.delete(key);
    audioCache.set(key, cached);
    stopActive();
    const currentGeneration = ++generation.current;
    const audio = new Audio(cached.url);
    const { cleanup } = playAudio(audio, currentGeneration);
    void audio.play().catch(() => {
      setError(t("tts.playError"));
      setAnnouncement(t("tts.playError"));
      cleanup();
    });
  };

  const synthesize = async (authorizedAudio: HTMLAudioElement, authorization: Promise<void>) => {
    stopActive();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    let cleaned = false;
    const cancel = (announce = true) => {
      if (cleaned) return;
      cleaned = true;
      controller.abort();
      authorizedAudio.pause();
      if (activeStop === cancel) activeStop = null;
      if (ownedStop.current === cancel) ownedStop.current = null;
      if (mounted.current && generation.current === currentGeneration) {
        setPhase("idle");
        if (announce) setAnnouncement(t("tts.stopped"));
      }
    };
    ownedStop.current = cancel;
    activeStop = cancel;
    setPhase("loading");
    setAnnouncement(t("tts.generating"));
    setConfirming(false);
    setError(null);
    try {
      await authorization;
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, MAX_TTS_TEXT_LENGTH) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(t("tts.requestError", { status: response.status }));
      const blob = await response.blob();
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      const entry = cacheAudio(key, blob);
      authorizedAudio.pause();
      authorizedAudio.muted = false;
      authorizedAudio.src = entry.url;
      authorizedAudio.currentTime = 0;
      cleaned = true;
      const { cleanup } = playAudio(authorizedAudio, currentGeneration);
      await authorizedAudio.play().catch(() => {
        setError(t("tts.playError"));
        setAnnouncement(t("tts.playError"));
        cleanup();
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : t("tts.requestFailed");
        setError(message);
        setAnnouncement(message);
      }
      cancel(false);
    }
  };

  const confirmPaid = () => {
    const audio = new Audio();
    audio.muted = true;
    audio.src = SILENT_AUDIO;
    const authorization = audio.play();
    void loadBackendInfo(true)
      .then((fresh) => {
        if (cacheKey(fresh, text) !== key) {
          audio.pause();
          setInfo(fresh);
          setError(t("tts.backendChanged"));
          setConfirming(false);
          return;
        }
        void synthesize(audio, authorization);
      })
      .catch(() => {
        audio.pause();
        setError(t("tts.configError"));
      });
  };

  const toggle = () => {
    if (ownedStop.current) {
      ownedStop.current();
      return;
    }
    setError(null);
    if (cached) replay();
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
    if (event.key === "Enter" && option.available) {
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

  return (
    <span className="relative">
      <button ref={triggerRef} type="button" onClick={toggle} className="rounded-md p-1 text-dim opacity-0 transition-opacity hover:bg-chip hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60" aria-label={active ? t("tts.stop") : cached ? t("tts.replay") : t("tts.read")} title={active ? t("tts.stop") : cached ? t("tts.replayFree") : t("tts.readPaid")}>
        {active ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {phase === "playing" && timing.total > 0 ? <span className="text-[10px] tabular-nums text-dim">{Math.floor(timing.elapsed)} / {Math.ceil(timing.total)}s</span> : null}
      {confirming ? (
        <span ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("tts.confirmAria")} onKeyDown={onDialogKeyDown} className="absolute right-0 top-7 z-50 block w-72 rounded-xl border border-line bg-panel p-3 text-left shadow-xl">
          <span className="block text-xs font-bold text-ink">{t("tts.confirmTitle")}</span>
          <span className="mt-1 block text-[11px] text-dim">{option.id} · {option.model} · {option.voice}</span>
          <span className="block text-[11px] text-dim">{t("tts.characters", { count: text.length.toLocaleString() })}</span>
          <span className="mt-2 block text-[11px] text-ink">{t("tts.billing", { provider: option.id })}</span>
          <span className="block text-[11px] text-ink">{t("tts.disclosure")}</span>
          {text.length > MAX_TTS_TEXT_LENGTH ? <span className="mt-2 block text-[11px] font-semibold text-err">{t("tts.shorten", { count: MAX_TTS_TEXT_LENGTH.toLocaleString() })}</span> : null}
          {!option.available ? <span className="mt-2 block break-all text-[11px] text-err">{t("tts.missingKey", { provider: option.id, path: option.keyPath })}</span> : null}
          <span className="mt-2 flex gap-1">{info.options.map((candidate) => <button key={candidate.id} type="button" disabled={info.lockedByEnv} onClick={() => void pickBackend(candidate.id)} className="rounded bg-chip px-2 py-1 text-[10px] font-semibold disabled:opacity-50">{candidate.id}{candidate.id === info.backend ? " ✓" : ""}</button>)}</span>
          <span className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={closeConfirm} className="rounded px-2 py-1 text-xs text-dim">{t("tts.cancel")}</button>
            <button type="button" disabled={!option.available} onClick={confirmPaid} className="rounded bg-accent px-2 py-1 text-xs font-bold text-white disabled:opacity-50">{t("tts.speak")}</button>
          </span>
        </span>
      ) : null}
      {error ? <span role="alert" className="absolute right-0 top-7 z-40 w-56 rounded bg-panel p-2 text-[11px] text-err shadow">{error}</span> : null}
    </span>
  );
}
