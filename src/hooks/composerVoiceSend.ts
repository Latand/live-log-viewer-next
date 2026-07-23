/**
 * One-tap voice send orchestration (round-1 P1#1), extracted from `useComposer`
 * so the "combine the spoken transcript with the typed draft, then hand off to
 * the SAME submit as click/Enter" contract is provable without mocking the
 * `useDictation` hook (a process-global module mock leaks across bun's shared
 * test process). Every dependency is injected, so a fake `stop()` drives the
 * whole path deterministically.
 *
 * The unification invariant: dictation never has its own delivery path — it
 * combines the spoken tail with the current draft and calls `submit`, which is
 * exactly the queue-first `submit` the Send button and the Enter key use. A
 * transcription that yields `null` (a discard or a read error) never submits.
 */

/** Combine the current draft with the recognised speech. Realtime commits and
    typing may have grown the draft while recording, so the current text is read
    live; `spoken` is appended (space-joined) when non-empty, otherwise the draft
    stands alone. */
export function combineSpokenSubmission(currentText: string, spoken: string): string {
  if (!spoken) return currentText;
  return currentText ? `${currentText.trimEnd()} ${spoken}` : spoken;
}

export interface VoiceSendDeps {
  /** True while a send or another voice send is already in flight. */
  busy: boolean;
  voiceSending: boolean;
  setVoiceSending: (value: boolean) => void;
  /** Stops the recording and resolves the recognised text, or `null` to abort. */
  stop: () => Promise<string | null>;
  /** The current draft, read live (through a ref in the hook). */
  currentText: () => string;
  setText: (value: string) => void;
  /** The one submit shared by click / Enter / dictation (queue-first). */
  submit: (overrideText?: string) => void | Promise<void>;
}

export async function performVoiceSend(deps: VoiceSendDeps): Promise<void> {
  if (deps.busy || deps.voiceSending) return;
  deps.setVoiceSending(true);
  try {
    const spoken = await deps.stop();
    if (spoken === null) return;
    const combined = combineSpokenSubmission(deps.currentText(), spoken);
    deps.setText(combined);
    await deps.submit(combined);
  } finally {
    deps.setVoiceSending(false);
  }
}
