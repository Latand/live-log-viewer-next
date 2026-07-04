"use client";

import { useEffect, useRef, useState } from "react";

import { Loader2, Mic, X } from "@/components/icons";

type Phase = "idle" | "rec" | "busy";

const MAX_SECONDS = 120;
/* Sub-2KB blobs are a misclick, not speech — dropped without a server call. */
const MIN_BLOB_BYTES = 2_000;

function fmtElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Dictation button for composers: press to record (getUserMedia + MediaRecorder,
 * webm/opus), press again to stop and transcribe through /api/transcribe, which
 * proxies to the ChatGPT backend with the local Codex credentials.
 */
export function MicButton({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const stopTimer = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopTimer();
      discardRef.current = true;
      const rec = recRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      rec?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const finish = async () => {
    stopTimer();
    const rec = recRef.current;
    recRef.current = null;
    rec?.stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    chunksRef.current = [];
    if (discardRef.current || blob.size < MIN_BLOB_BYTES) {
      setPhase("idle");
      return;
    }
    setPhase("busy");
    try {
      const form = new FormData();
      form.append("file", blob, "dictation.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const json = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || typeof json.text !== "string") {
        onError(json.error ?? "не вдалося розпізнати");
        return;
      }
      const text = json.text.trim();
      if (text) onText(text);
      else onError("тиша — нічого не розпізналось");
    } catch {
      onError("сервер недоступний");
    } finally {
      setPhase("idle");
    }
  };

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    } catch {
      onError("немає доступу до мікрофона");
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];
    discardRef.current = false;
    rec.ondataavailable = (event) => {
      if (event.data.size) chunksRef.current.push(event.data);
    };
    rec.onstop = () => {
      void finish();
    };
    rec.start(250);
    recRef.current = rec;
    setElapsed(0);
    setPhase("rec");
    timerRef.current = window.setInterval(() => {
      setElapsed((seconds) => {
        const next = seconds + 1;
        if (next >= MAX_SECONDS && recRef.current?.state === "recording") recRef.current.stop();
        return next;
      });
    }, 1_000);
  };

  const handleMain = () => {
    if (phase === "idle") void start();
    else if (phase === "rec" && recRef.current?.state === "recording") recRef.current.stop();
  };

  const handleDiscard = () => {
    discardRef.current = true;
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  if (phase === "rec") {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label="Зупинити запис і розпізнати"
          onClick={handleMain}
          className="flex items-center gap-1.5 rounded-[8px] border border-err/50 bg-[#fff2f2] px-2 py-1 text-[11px] font-bold text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-err/40"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-err" />
          {fmtElapsed(elapsed)}
        </button>
        <button
          type="button"
          aria-label="Скасувати запис"
          onClick={handleDiscard}
          className="inline-flex items-center rounded-[8px] border border-line bg-panel px-1.5 py-1 text-dim hover:text-err focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={phase === "busy" ? "Розпізнаю…" : "Надиктувати"}
      title={phase === "busy" ? "розпізнаю…" : "надиктувати (до 2 хв)"}
      disabled={phase === "busy"}
      onClick={handleMain}
      className="inline-flex shrink-0 items-center rounded-[8px] border border-line bg-panel px-2 py-1 text-dim hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-60"
    >
      {phase === "busy" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
    </button>
  );
}
