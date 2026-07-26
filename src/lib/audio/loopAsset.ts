/**
 * The ambient loop asset.
 *
 * Shipped LOSSLESS on purpose. Every lossy codec adds encoder priming and
 * padding to the head and tail of the stream, and a loop whose buffer carries
 * that padding has an audible seam on every pass — exactly the restart gap this
 * bed must not have. So the master ships as the PCM WAV it was authored as, and
 * playback loops the decoded {@link AudioBuffer} on the audio clock rather than
 * re-triggering anything (see `webAudioTransport`).
 *
 * `AMBIENT_LOOP_ASSET` may be `null`: that is a supported state — the loop
 * controller never starts a voice and the UI omits its controls entirely rather
 * than showing a dead toggle. It is not the state this release ships.
 */
export const AMBIENT_LOOP_ASSET: string | null = "/audio/ambient/voice-call-loop.wav";

/** Whether a loop asset exists to play. */
export function ambientLoopConfigured(asset: string | null = AMBIENT_LOOP_ASSET): boolean {
  return typeof asset === "string" && asset.length > 0;
}
