import fs from "node:fs";
import path from "node:path";

import { configFilePath } from "@/lib/configDir";
import { readElevenLabsApiKey } from "@/lib/transcribeBackend";

export type TtsBackend = "openai" | "elevenlabs";
export const TTS_BACKENDS: readonly TtsBackend[] = ["openai", "elevenlabs"];

export interface TtsBackendOption {
  id: TtsBackend;
  available: boolean;
  keyPath: string;
  model: string;
  voice: string;
  cap: number;
}

export interface TtsBackendInfo {
  backend: TtsBackend;
  lockedByEnv: boolean;
  options: TtsBackendOption[];
}

export function isTtsBackend(value: unknown): value is TtsBackend {
  return typeof value === "string" && (TTS_BACKENDS as readonly string[]).includes(value);
}

function readFile(name: string): string | null {
  try {
    return fs.readFileSync(configFilePath(name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function resolveTtsBackend(): TtsBackend {
  const env = process.env.LLV_TTS_BACKEND?.trim().toLowerCase();
  if (isTtsBackend(env)) return env;
  const saved = readFile("tts-backend")?.toLowerCase();
  return isTtsBackend(saved) ? saved : "openai";
}

export function writeTtsBackend(backend: TtsBackend): void {
  const file = configFilePath("tts-backend");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${backend}\n`);
}

export function readOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || readFile("openai-api-key");
}

export function ttsBackendInfo(): TtsBackendInfo {
  const env = process.env.LLV_TTS_BACKEND?.trim().toLowerCase();
  return {
    backend: resolveTtsBackend(),
    lockedByEnv: isTtsBackend(env),
    options: [
      {
        id: "openai",
        available: readOpenAiApiKey() !== null,
        keyPath: configFilePath("openai-api-key"),
        model: process.env.LLV_TTS_OPENAI_MODEL?.trim() || readFile("tts-model-openai") || "gpt-4o-mini-tts",
        voice: process.env.LLV_TTS_OPENAI_VOICE?.trim() || readFile("tts-voice-openai") || "alloy",
        cap: 4000,
      },
      {
        id: "elevenlabs",
        available: readElevenLabsApiKey() !== null,
        keyPath: configFilePath("elevenlabs-api-key"),
        model: process.env.LLV_TTS_ELEVENLABS_MODEL?.trim() || readFile("tts-model-elevenlabs") || "eleven_multilingual_v2",
        voice: process.env.LLV_TTS_ELEVENLABS_VOICE?.trim() || readFile("tts-voice-elevenlabs") || "21m00Tcm4TlvDq8ikWAM",
        cap: 4000,
      },
    ],
  };
}

export function activeTtsOption(): TtsBackendOption {
  const info = ttsBackendInfo();
  return info.options.find((option) => option.id === info.backend)!;
}
