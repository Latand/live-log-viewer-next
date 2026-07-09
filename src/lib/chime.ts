"use client";

/**
 * Sound notifications for agent lifecycle transitions. Short synthesized
 * bell-like arpeggios (Web Audio, no assets), stereo-panned to where the
 * pane sits on screen — a finish on the far-right column rings in the
 * right speaker, so the ear finds the column the eye should jump to.
 */

export type ChimeKind =
  | "waiting"
  | "returned"
  | "stalled"
  | "question"
  | "spawned"
  /* Dictation cap cues: a single soft near-cap ping, and a distinct descending
     two-note that marks the recording auto-stopping at the limit. */
  | "dictWarn"
  | "dictStop";

const SOUND_KEY = "llvSound";

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* private mode: sound stays session-only */
  }
}

/* ---- pane geometry registry -------------------------------------------- */

/* Panes register their DOM node so the chime of a file can be panned to its
   on-screen position even though transitions are detected app-wide in Viewer. */
const paneEls = new Map<string, HTMLElement>();

export function registerPane(path: string, el: HTMLElement): () => void {
  paneEls.set(path, el);
  return () => {
    if (paneEls.get(path) === el) paneEls.delete(path);
  };
}

/** Stereo position of a pane: -1 hard left … 1 hard right, 0 when unmounted. */
export function panForPane(path: string): number {
  const el = paneEls.get(path);
  if (!el || typeof window === "undefined") return 0;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return 0;
  const center = rect.left + rect.width / 2;
  return Math.max(-1, Math.min(1, (center / window.innerWidth) * 2 - 1));
}

/* ---- synthesis ---------------------------------------------------------- */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * Autoplay policy keeps a fresh AudioContext suspended until a user gesture;
 * unlock it on the first interaction so later poll-driven chimes can play.
 * Returns the listener cleanup.
 */
export function primeAudio(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    const audio = audioCtx();
    if (audio && audio.state !== "running") void audio.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

interface Note {
  freq: number;
  /** Seconds after the chime start. */
  at: number;
  /** Decay length in seconds. */
  dur: number;
}

/* Each state gets its own melodic gesture: rising = your move, a little
   arpeggio = a branch came home, falling = something got stuck, a quick
   low blip up = a new agent joined the tree. */
export const TUNES: Record<ChimeKind, Note[]> = {
  waiting: [
    { freq: 784, at: 0, dur: 0.5 }, // G5
    { freq: 1175, at: 0.16, dur: 0.75 }, // D6
  ],
  returned: [
    { freq: 659, at: 0, dur: 0.3 }, // E5
    { freq: 784, at: 0.09, dur: 0.3 }, // G5
    { freq: 988, at: 0.18, dur: 0.65 }, // B5
  ],
  stalled: [
    { freq: 880, at: 0, dur: 0.35 }, // A5
    { freq: 587, at: 0.14, dur: 0.7 }, // D5
  ],
  question: [
    { freq: 1047, at: 0, dur: 0.28 }, // C6
    { freq: 1319, at: 0.12, dur: 0.35 }, // E6
    { freq: 1568, at: 0.24, dur: 0.6 }, // G6
  ],
  spawned: [
    { freq: 523, at: 0, dur: 0.14 }, // C5
    { freq: 784, at: 0.06, dur: 0.4 }, // G5
  ],
  /* One gentle mid-register ping — "heads up, the cap is close" — a single
     note so it never reads as one of the multi-note lifecycle tunes. */
  dictWarn: [
    { freq: 660, at: 0, dur: 0.32 }, // E5
  ],
  /* A low, unmistakably descending two-note: recording has stopped. Pitched
     below every other tune (including the stalled A5→D5 fall) so the ear
     reads "ended", not "your move". */
  dictStop: [
    { freq: 523, at: 0, dur: 0.3 }, // C5
    { freq: 330, at: 0.17, dur: 0.62 }, // E4
  ],
};

const PEAK = 0.07;

function playNote(audio: AudioContext, dest: AudioNode, note: Note, t0: number) {
  const start = t0 + note.at;
  const osc = audio.createOscillator();
  osc.type = "sine";
  osc.frequency.value = note.freq;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(PEAK, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0004, start + note.dur);
  osc.connect(gain).connect(dest);
  osc.start(start);
  osc.stop(start + note.dur + 0.05);
  /* A quiet octave overtone gives the sine a bell-like shimmer. */
  const over = audio.createOscillator();
  over.type = "sine";
  over.frequency.value = note.freq * 2;
  const overGain = audio.createGain();
  overGain.gain.setValueAtTime(0, start);
  overGain.gain.linearRampToValueAtTime(PEAK * 0.18, start + 0.012);
  overGain.gain.exponentialRampToValueAtTime(0.0003, start + note.dur * 0.7);
  over.connect(overGain).connect(dest);
  over.start(start);
  over.stop(start + note.dur);
}

/**
 * Plays one chime panned to `pan` (-1…1). Silently dropped while the
 * context is still locked by the autoplay policy (primeAudio unlocks it on
 * the first user interaction).
 */
export function chime(kind: ChimeKind, pan: number, delayMs = 0) {
  if (!soundEnabled()) return;
  const audio = audioCtx();
  if (!audio) return;
  if (audio.state !== "running") {
    void audio.resume().catch(() => undefined);
    return;
  }
  const t0 = audio.currentTime + 0.02 + delayMs / 1000;
  let dest: AudioNode = audio.destination;
  if (typeof audio.createStereoPanner === "function") {
    const panner = audio.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(audio.destination);
    dest = panner;
  }
  for (const note of TUNES[kind]) playNote(audio, dest, note, t0);
}
