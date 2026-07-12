"use client";

import { Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

import { tr } from "./parse";

let activeStop: (() => void) | null = null;
type BackendId = "openai" | "elevenlabs";
interface BackendInfo {
  backend: BackendId;
  lockedByEnv: boolean;
  options: { id: BackendId; available: boolean; keyPath: string; model: string; voice: string; cap: number }[];
}

function stopActive(): void {
  const stop = activeStop;
  activeStop = null;
  stop?.();
}

export function SpeakButton({ text }: { text: string }) {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "playing">("idle");
  const generation = useRef(0);
  const mounted = useRef(true);
  const ownedStop = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void fetch("/api/tts/backend")
      .then((response) => response.json() as Promise<BackendInfo>)
      .then((value) => { if (current) setInfo(value); })
      .catch(() => { if (current) setError("TTS configuration unavailable"); });
    return () => {
      current = false;
      mounted.current = false;
      generation.current += 1;
      if (activeStop === ownedStop.current) stopActive();
    };
  }, []);

  if (!info || !text) return null;
  const option = info.options.find((candidate) => candidate.id === info.backend);
  if (!option) return null;

  const start = async () => {
    stopActive();
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    let audio: HTMLAudioElement | null = null;
    let url: string | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      controller.abort();
      audio?.pause();
      if (url) URL.revokeObjectURL(url);
      if (activeStop === cleanup) activeStop = null;
      if (ownedStop.current === cleanup) ownedStop.current = null;
      if (mounted.current && generation.current === currentGeneration) setPhase("idle");
    };
    ownedStop.current = cleanup;
    activeStop = cleanup;
    setPhase("loading");
    setConfirming(false);
    setError(null);

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, MAX_TTS_TEXT_LENGTH) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`TTS request failed (${response.status})`);
      const blob = await response.blob();
      if (controller.signal.aborted || generation.current !== currentGeneration) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.onended = cleanup;
      audio.onerror = cleanup;
      setPhase("playing");
      await audio.play();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "TTS request failed");
      cleanup();
    }
  };

  const toggle = () => {
    if (ownedStop.current) {
      ownedStop.current();
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const pickBackend = async (backend: BackendId) => {
    if (info.lockedByEnv) return;
    const response = await fetch("/api/tts/backend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backend }),
    });
    if (response.ok) setInfo((await response.json()) as BackendInfo);
  };

  const active = phase !== "idle";
  return (
    <span className="relative">
      <button
        type="button"
        onClick={toggle}
        className="rounded-md p-1 text-dim opacity-0 transition-opacity hover:bg-chip hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60"
        aria-label={active ? tr("feed.stopSpeaking") : tr("feed.speak")}
        title={active ? tr("feed.stopSpeaking") : "Read aloud (paid)"}
      >
        {active ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-3.5 w-3.5" aria-hidden />}
      </button>
      {confirming ? (
        <span role="dialog" aria-label="Confirm paid text-to-speech" className="absolute right-0 top-7 z-50 block w-72 rounded-xl border border-line bg-panel p-3 text-left shadow-xl">
          <span className="block text-xs font-bold text-ink">Confirm paid read-aloud</span>
          <span className="mt-1 block text-[11px] text-dim">{option.id} · {option.model} · {option.voice}</span>
          <span className="block text-[11px] text-dim">{text.length.toLocaleString()} characters</span>
          <span className="mt-2 block text-[11px] text-ink">Billed to your {option.id} account per character.</span>
          <span className="block text-[11px] text-ink">You’ll hear an AI-generated voice, not a human voice.</span>
          {text.length > MAX_TTS_TEXT_LENGTH ? (
            <span className="mt-2 block text-[11px] font-semibold text-err">Speak the first {MAX_TTS_TEXT_LENGTH.toLocaleString()} characters?</span>
          ) : null}
          {!option.available ? <span className="mt-2 block break-all text-[11px] text-err">Add the {option.id} API key at {option.keyPath}</span> : null}
          <span className="mt-2 flex gap-1">
            {info.options.map((candidate) => (
              <button key={candidate.id} type="button" disabled={info.lockedByEnv} onClick={() => void pickBackend(candidate.id)} className="rounded bg-chip px-2 py-1 text-[10px] font-semibold disabled:opacity-50">
                {candidate.id}{candidate.id === info.backend ? " ✓" : ""}
              </button>
            ))}
          </span>
          <span className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(false)} className="rounded px-2 py-1 text-xs text-dim">Cancel</button>
            <button type="button" disabled={!option.available} onClick={() => void start()} className="rounded bg-accent px-2 py-1 text-xs font-bold text-white disabled:opacity-50">Speak</button>
          </span>
        </span>
      ) : null}
      {error ? <span role="alert" className="absolute right-0 top-7 z-40 w-56 rounded bg-panel p-2 text-[11px] text-err shadow">{error}</span> : null}
    </span>
  );
}
