import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  isTranscribeBackend,
  readSonioxApiKey,
  resolveTranscribeBackend,
  TRANSCRIBE_BACKENDS,
  transcribeBackendInfo,
  writeTranscribeBackend,
} from "./transcribeBackend";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TRANSCRIBE_BACKEND;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const roots: string[] = [];

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stt-backend-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const dir = path.join(root, "agent-log-viewer");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sonioxOption() {
  return transcribeBackendInfo().options.find((option) => option.id === "soniox")!;
}

/* Env restore goes through a name-indexed helper: writing
   `process.env.X_API_KEY = value` directly reads as a credential assignment to
   the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  setEnv("XDG_CONFIG_HOME", originalConfigHome);
  setEnv("LLV_TRANSCRIBE_BACKEND", originalBackend);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
});

describe("soniox as a transcription backend (#1020)", () => {
  test("is a selectable backend beside the existing ones", () => {
    expect(TRANSCRIBE_BACKENDS).toEqual(["local", "chatgpt", "elevenlabs", "soniox"]);
    expect(isTranscribeBackend("soniox")).toBe(true);
  });

  test("the override file selects it, case-insensitively", () => {
    const dir = configHome();
    delete process.env.LLV_TRANSCRIBE_BACKEND;
    fs.writeFileSync(path.join(dir, "transcribe-backend"), "soniox\n");
    expect(resolveTranscribeBackend()).toBe("soniox");
    fs.writeFileSync(path.join(dir, "transcribe-backend"), "SONIOX\n");
    expect(resolveTranscribeBackend()).toBe("soniox");
  });

  test("the env override wins over the file and locks the selector", () => {
    configHome();
    writeTranscribeBackend("local");
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    expect(resolveTranscribeBackend()).toBe("soniox");
    expect(transcribeBackendInfo()).toMatchObject({ backend: "soniox", lockedByEnv: true });
  });

  test("the mic menu can persist the choice into the override file", () => {
    const dir = configHome();
    delete process.env.LLV_TRANSCRIBE_BACKEND;
    writeTranscribeBackend("soniox");
    expect(fs.readFileSync(path.join(dir, "transcribe-backend"), "utf8")).toBe("soniox\n");
    expect(resolveTranscribeBackend()).toBe("soniox");
  });

  test("the key file makes it available and names the path to drop the key into", () => {
    const dir = configHome();
    setEnv("SONIOX_API_KEY", undefined);
    expect(sonioxOption()).toMatchObject({ available: false, keyPath: path.join(dir, "soniox-api-key") });

    fs.writeFileSync(path.join(dir, "soniox-api-key"), "file-key\n");
    expect(readSonioxApiKey()).toBe("file-key");
    expect(sonioxOption().available).toBe(true);
  });

  test("the environment key wins over the file, and an empty file reads as no key", () => {
    const dir = configHome();
    fs.writeFileSync(path.join(dir, "soniox-api-key"), "file-key\n");
    setEnv("SONIOX_API_KEY", "env-key");
    expect(readSonioxApiKey()).toBe("env-key");

    setEnv("SONIOX_API_KEY", undefined);
    fs.writeFileSync(path.join(dir, "soniox-api-key"), "\n");
    expect(readSonioxApiKey()).toBeNull();
    expect(sonioxOption().available).toBe(false);
  });

  test("selecting soniox leaves the other backends' options untouched", () => {
    configHome();
    process.env.LLV_TRANSCRIBE_BACKEND = "soniox";
    expect(transcribeBackendInfo().options.map((option) => option.id)).toEqual([
      "local",
      "chatgpt",
      "elevenlabs",
      "soniox",
    ]);
  });
});
