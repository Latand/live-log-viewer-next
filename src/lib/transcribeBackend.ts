import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TranscribeBackend = "local" | "chatgpt";

const OVERRIDE_FILE = path.join(os.homedir(), ".config", "live-log-viewer", "transcribe-backend");

/**
 * Which transcription path handles dictation. The default is the fully local
 * faster-whisper engine, which carries no third-party terms. The ChatGPT
 * backend path exists but stays off the UI: it turns on only for whoever sets
 * `LLV_TRANSCRIBE_BACKEND=chatgpt` or writes `chatgpt` into the override file,
 * so it is opt-in per machine rather than a visible toggle.
 */
export function resolveTranscribeBackend(): TranscribeBackend {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  if (env === "chatgpt" || env === "local") return env;
  try {
    const fileValue = fs.readFileSync(OVERRIDE_FILE, "utf8").trim().toLowerCase();
    if (fileValue === "chatgpt") return "chatgpt";
  } catch {
    /* no override file: stay on the local default */
  }
  return "local";
}
