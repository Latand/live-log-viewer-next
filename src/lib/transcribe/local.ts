import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { cacheEntryPath } from "@/lib/configDir";

import type { TranscribeResponse } from "./types";

/* Local faster-whisper path (default). Model and device are overridable per
   machine; CPU int8 keeps it dependency-free where there is no CUDA setup. */
const WHISPER_MODEL = process.env.LLV_WHISPER_MODEL || "small";
const WHISPER_DEVICE = process.env.LLV_WHISPER_DEVICE || "cpu";
const WHISPER_TIMEOUT_MS = 120_000;

/* Resolved per request so a venv created after the server started is picked up,
   and the legacy cache dir is honored when only the old venv exists. */
function whisperVenv(): string {
  return process.env.LLV_WHISPER_VENV || cacheEntryPath("whisper-venv");
}

/** Interpreter the local path would run — shown in setup hints. */
export function whisperPythonPath(): string {
  return path.join(whisperVenv(), "bin", "python");
}

/** Whether the faster-whisper venv is installed on this machine. */
export function localWhisperReady(): boolean {
  return fs.existsSync(whisperPythonPath());
}

export function localTranscribe(audioPath: string, language: string): Promise<TranscribeResponse> {
  const python = path.join(whisperVenv(), "bin", "python");
  const script = path.join(process.cwd(), "scripts", "whisper_transcribe.py");
  return new Promise((resolve, reject) => {
    execFile(
      python,
      [script, audioPath, WHISPER_MODEL, WHISPER_DEVICE, language],
      { maxBuffer: 4 * 1024 * 1024, timeout: WHISPER_TIMEOUT_MS },
      (error, stdout) => {
        if (error && !stdout) {
          const hint = (error as NodeJS.ErrnoException).code === "ENOENT" ? " (запусти scripts/setup-whisper.sh)" : "";
          reject(new Error(error.message + hint));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { text?: unknown; error?: unknown };
          if (typeof parsed.error === "string") {
            reject(new Error(parsed.error));
            return;
          }
          resolve({ text: typeof parsed.text === "string" ? parsed.text : "" });
        } catch {
          reject(new Error("локальний STT повернув некоректний вивід"));
        }
      },
    );
  });
}
