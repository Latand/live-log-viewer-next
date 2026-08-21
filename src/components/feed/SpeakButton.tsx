"use client";

import { RotateCw, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { translate, useLocale } from "@/lib/i18n";
import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { wordSpanAt } from "@/lib/ttsAlignment";
import { chunkSpeech } from "@/lib/ttsChunks";

import { SpeakAlert, SpeakMenu, type BackendId, type BackendInfo } from "./SpeakMenu";
import { createKaraoke, karaokeRoots, type Karaoke } from "./ttsKaraoke";
import {
  chunksCached,
  hasBeenSpoken,
  markSpoken,
  synthesizeChunk,
  TtsPlaybackError,
  TtsRequestError,
  TtsSession,
  voiceKey,
  type VoiceKey,
} from "./ttsSession";

let activeStop: (() => void) | null = null;

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

/* The page-wide "only one control speaks at a time" latch. Assigned through a
   module function like `stopActive` above rather than from the component body,
   where the React Compiler reads a bare `activeStop = stop` as a global mutated
   during render — `begin` is only ever called from a click, but nothing in the
   source says so. */
function claimActive(stop: () => void): void {
  activeStop = stop;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const [announcement, setAnnouncement] = useState("");
  const [progress, setProgress] = useState({ elapsed: 0, total: 0, chunk: 0, chunks: 0 });
  /* Only a re-render trigger: whether a replay is free is answered by the tts
     cache module, so a completed message keeps its replay control across
     mounts — and loses it when its chunks are evicted. */
  const [, setSpokenTick] = useState(0);
  const chunks = useMemo(() => chunkSpeech(text), [text]);
  const generation = useRef(0);
  const mounted = useRef(true);
  const ownedStop = useRef<(() => void) | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  const closeMenu = useCallback((restoreFocus?: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  /* The refusal alert's way out (#1030): the same click-away and Escape the
     menu installs, so a refusal that nothing else clears does not have to be
     bought off with another synthesis. Stable, or the alert would rebind its
     listeners on every render. */
  const dismissError = useCallback(() => setError(null), []);

  if (!info || !text) return null;
  const option = info.options.find((candidate) => candidate.id === info.backend);
  if (!option) return null;
  const key = messageKey(info, text);
  /* "Replay aloud (free)" has to be TRUE when it is shown, so it takes both: a
     message read to the end, and every one of its chunks still in the cache.
     Anything else — stopped after the first of twenty-five chunks, or evicted
     since — is a paid synthesis, and says so in the control's tooltip and in
     the right-click menu. Asked again at click time, because another card's
     long answer can evict these chunks without re-rendering this one. */
  const freeReplay = () => hasBeenSpoken(key) && chunksCached(chunks.map((chunk) => voiceKey(option, chunk.text)));
  const replayable = freeReplay();
  const tooLong = text.length > MAX_TTS_MESSAGE_LENGTH;

  /**
   * Runs one message end to end: chunks it, keeps a couple of syntheses ahead
   * of the voice, highlights the word being spoken in the rendered markdown and
   * lets a click in that text jump the audio there.
   */
  const begin = (elements: HTMLAudioElement[], playbackUnlock: Promise<unknown>, fromChar = 0) => {
    if (!chunks.length) return;
    stopActive();
    const currentGeneration = ++generation.current;
    const alive = () => mounted.current && generation.current === currentGeneration;
    const roots = triggerRef.current ? karaokeRoots(triggerRef.current) : [];
    const karaoke: Karaoke | null = roots.length ? createKaraoke(roots, text) : null;

    /* Who the route says it actually billed, once it has answered. The page's
       copy of the configuration is a page-load-old singleton, so a tab open
       across a provider switch asks for one provider and is charged another —
       and everything downstream of this session (the cache key, the record
       that the message was voiced, the provider the surface names) follows the
       answer rather than the belief. */
    let billed: VoiceKey | null = null;
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
      key: (chunkText, voice) => voiceKey(voice ?? option, chunkText),
      synthesize: synthesizeChunk,
      elements,
      onPhase: (next) => {
        if (!alive()) return;
        setPhase(next);
        setAnnouncement(next === "loading" ? t("tts.generating") : t("tts.playing"));
      },
      onVoice: (voice) => {
        if (voice.id === option.id && voice.model === option.model && voice.voice === option.voice) return;
        billed = voice;
        if (alive()) {
          const notice = t("tts.backendChanged", { provider: voice.id });
          setError(notice);
          setAnnouncement(notice);
        }
        /* Re-reads the configuration and broadcasts it to every control on the
           page, so the tooltip and the menu name the provider that was charged
           — off the play path, which is where that wait belongs. */
        void loadBackendInfo(true).catch(() => undefined);
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
        /* Read to the end: from here the control may offer a replay — for as
           long as the chunks it would replay are still cached. */
        markSpoken(billed ? voiceKey(billed, text) : key);
        if (alive()) {
          setSpokenTick((tick) => tick + 1);
          setAnnouncement(t("tts.finished"));
        }
        stop(false);
      },
    });

    ownedStop.current = stop;
    claimActive(stop);
    setPhase("loading");
    setAnnouncement(t("tts.generating"));
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

  const refuse = (message: string) => {
    setError(message);
    setAnnouncement(message);
  };

  /**
   * The left click, and the whole of it (#1024): stop what this control is
   * playing, or start playing right now. No dialog stands between the click and
   * the first chunk — what it costs is on the control's tooltip and in the
   * right-click menu, decided before the click rather than after it. Cached
   * chunks are replayed by the session itself, so the free replay and the paid
   * synthesis are one path.
   */
  const toggle = () => {
    closeMenu(false);
    if (ownedStop.current) {
      ownedStop.current();
      return;
    }
    if (tooLong) {
      refuse(t("tts.tooLong", { count: MAX_TTS_MESSAGE_LENGTH.toLocaleString() }));
      return;
    }
    if (!option.available) {
      refuse(t("tts.missingKey", { provider: option.id, path: option.keyPath }));
      return;
    }
    /* The tooltip promising a free replay is only as fresh as the last render,
       and another card's long answer can evict these chunks in between. Asked
       once more here: the audio still starts on this click, but a replay that
       turned back into a paid synthesis says so instead of passing for free.
       Set after `begin`, which clears the notice slot on its way in. */
    const soldAsFree = replayable && !freeReplay();
    /* The user gesture is spent here, synchronously: the elements have to be
       unlocked in the click itself, before anything awaits. */
    const { elements, playbackUnlock } = unlockedElements();
    setError(null);
    begin(elements, playbackUnlock);
    if (soldAsFree) setError(t("tts.replayExpired"));
  };

  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu(false);
      return;
    }
    setMenuOpen(true);
    /* The menu is the surface that must be right about provider and price, so
       it asks the server again — off the play path, where the wait was. */
    void loadBackendInfo(true)
      .then((fresh) => { if (mounted.current) setInfo(fresh); })
      .catch(() => { if (mounted.current) setError(t("tts.configError")); });
  };

  const pickBackend = async (backend: BackendId): Promise<boolean> => {
    if (info.lockedByEnv) return false;
    try {
      const response = await fetch("/api/tts/backend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      if (!response.ok) return false;
      const value = (await response.json()) as BackendInfo;
      storeBackendInfo(value);
      setInfo(value);
      return true;
    } catch {
      return false;
    }
  };

  const active = phase !== "idle";
  const Icon = active ? Square : replayable ? RotateCw : Volume2;
  /* The tooltip is where the paid/free truth lives now, next to the hint that
     the menu is a right-click away — the same split MicButton uses. It runs the
     click's own order of refusals, so it says what the click will actually do:
     a provider with no key cannot read anything, paid or otherwise, and
     promising a paid read there was the last place this control oversold
     itself (#1030). */
  const title = active
    ? t("tts.stop")
    : tooLong
      ? t("tts.tooLong", { count: MAX_TTS_MESSAGE_LENGTH.toLocaleString() })
      : !option.available
        ? t("tts.missingKey", { provider: option.id, path: option.keyPath })
        : t("tts.triggerTitle", { action: replayable ? t("tts.replayFree") : t("tts.readPaid") });
  return (
    <span className="relative">
      <button ref={triggerRef} data-tts-trigger type="button" onClick={toggle} onContextMenu={(event) => { event.preventDefault(); toggleMenu(); }} aria-haspopup="menu" aria-expanded={menuOpen} className={`inline-flex items-center justify-center rounded-md text-muted transition-opacity hover:bg-sunken hover:text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${isMobile ? "h-11 w-11" : "p-1"} opacity-70 hover:opacity-100 group-hover/msg:opacity-100`} aria-label={active ? t("tts.stop") : replayable ? t("tts.replay") : t("tts.read")} title={title}>
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {phase === "playing" && progress.total > 0 ? (
        <span className="text-[10px] tabular-nums text-muted">
          {Math.floor(progress.elapsed)} / {Math.ceil(progress.total)}s
          {progress.chunks > 1 ? <span className="ml-1" title={t("tts.partOf", { index: progress.chunk, count: progress.chunks })}>{progress.chunk}/{progress.chunks}</span> : null}
        </span>
      ) : null}
      {menuOpen ? (
        <SpeakMenu
          anchorRef={triggerRef}
          info={info}
          option={option}
          chars={text.length}
          notice={error}
          freeReplay={freeReplay}
          active={active}
          tooLong={tooLong}
          onPick={pickBackend}
          onClose={closeMenu}
        />
      ) : null}
      {error && !menuOpen ? <SpeakAlert anchorRef={triggerRef} onDismiss={dismissError}>{error}</SpeakAlert> : null}
    </span>
  );
}
