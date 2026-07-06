import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCodexAuth } from "@/lib/codexAuth";
import { configFilePath } from "@/lib/configDir";
import { localWhisperReady, whisperPythonPath } from "@/lib/transcribe/local";

export type TranscribeBackend = "local" | "chatgpt" | "elevenlabs";

export const TRANSCRIBE_BACKENDS: readonly TranscribeBackend[] = ["local", "chatgpt", "elevenlabs"];

export function isTranscribeBackend(value: unknown): value is TranscribeBackend {
  return typeof value === "string" && (TRANSCRIBE_BACKENDS as readonly string[]).includes(value);
}

/**
 * Which transcription path handles dictation. The default is the fully local
 * faster-whisper engine, which carries no third-party terms. The cloud paths
 * (ChatGPT, ElevenLabs Scribe) turn on via the `LLV_TRANSCRIBE_BACKEND` env
 * (highest priority, locks the UI selector) or via the override file the mic
 * right-click menu writes.
 */
export function resolveTranscribeBackend(): TranscribeBackend {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  if (isTranscribeBackend(env)) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("transcribe-backend"), "utf8").trim().toLowerCase();
    if (isTranscribeBackend(fileValue)) return fileValue;
  } catch {
    /* no override file: stay on the local default */
  }
  return "local";
}

/** Persists the mic-menu choice; the env override, when set, still wins. */
export function writeTranscribeBackend(backend: TranscribeBackend): void {
  const file = configFilePath("transcribe-backend");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, backend + "\n");
}

export interface TranscribeBackendOption {
  id: TranscribeBackend;
  /** The credential/setup this backend needs is present on this machine. */
  available: boolean;
  /** Where the missing credential must go — shown copyable in the key popup. */
  keyPath: string;
}

export interface TranscribeBackendInfo {
  backend: TranscribeBackend;
  /** "env" locks the selector: the file override cannot beat the variable. */
  lockedByEnv: boolean;
  options: TranscribeBackendOption[];
}

export function transcribeBackendInfo(): TranscribeBackendInfo {
  const env = process.env.LLV_TRANSCRIBE_BACKEND?.trim().toLowerCase();
  return {
    backend: resolveTranscribeBackend(),
    lockedByEnv: isTranscribeBackend(env),
    options: [
      { id: "local", available: localWhisperReady(), keyPath: whisperPythonPath() },
      { id: "chatgpt", available: readCodexAuth() !== null, keyPath: codexAuthPath() },
      { id: "elevenlabs", available: readElevenLabsApiKey() !== null, keyPath: configFilePath("elevenlabs-api-key") },
    ],
  };
}

/** Mirrors readCodexAuth()'s fixed location. */
function codexAuthPath(): string {
  return path.join(os.homedir(), ".codex", "auth.json");
}

/** Read at request time so a key drop-in works without a server restart. */
export function readElevenLabsApiKey(): string | null {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  try {
    const fileValue = fs.readFileSync(configFilePath("elevenlabs-api-key"), "utf8").trim();
    return fileValue || null;
  } catch {
    return null;
  }
}
