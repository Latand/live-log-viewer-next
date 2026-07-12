"use client";

import { Square, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";

import { tr } from "./parse";

let activeAudio: HTMLAudioElement | null = null;
let activeStop: (() => void) | null = null;
let availabilityPromise: Promise<boolean> | null = null;

function ttsAvailable(): Promise<boolean> {
  availabilityPromise ??= fetch("/api/tts")
    .then((response) => response.json() as Promise<{ available?: unknown }>)
    .then((info) => info.available === true)
    .catch(() => false);
  return availabilityPromise;
}

export function SpeakButton({ text }: { text: string }) {
  const [available, setAvailable] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let current = true;
    void ttsAvailable().then((value) => { if (current) setAvailable(value); });
    return () => { current = false; };
  }, []);

  if (!available || !text) return null;

  const stop = () => {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = "";
    }
    activeAudio = null;
    activeStop?.();
    activeStop = null;
  };

  const toggle = async () => {
    if (playing) {
      stop();
      return;
    }
    stop();
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      activeAudio = audio;
      activeStop = () => { URL.revokeObjectURL(url); setPlaying(false); };
      audio.onended = stop;
      audio.onerror = stop;
      setPlaying(true);
      await audio.play();
    } catch {
      stop();
    }
  };

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      className="rounded-md p-1 text-dim opacity-0 transition-opacity hover:bg-chip hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-60"
      aria-label={playing ? tr("feed.stopSpeaking") : tr("feed.speak")}
      title={playing ? tr("feed.stopSpeaking") : tr("feed.speak")}
    >
      {playing ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Volume2 className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
