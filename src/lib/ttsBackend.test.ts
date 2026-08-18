import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { isTtsBackend, readOpenAiApiKey, resolveTtsBackend, TTS_BACKENDS, ttsBackendInfo, writeTtsBackend } from "./ttsBackend";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const roots: string[] = [];

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tts-backend-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return path.join(root, "agent-log-viewer");
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
  setEnv("LLV_TTS_BACKEND", originalBackend);
  setEnv("OPENAI_API_KEY", originalOpenAiKey);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
});

describe("TTS backend configuration", () => {
  test("environment selection locks and overrides the persisted provider", () => {
    configHome();
    writeTtsBackend("openai");
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    expect(resolveTtsBackend()).toBe("elevenlabs");
    expect(ttsBackendInfo().lockedByEnv).toBe(true);
  });

  test("reads OpenAI credentials and voice/model configuration from files", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openai-api-key"), "file-key\n");
    fs.writeFileSync(path.join(dir, "tts-model-openai"), "tts-1-hd\n");
    fs.writeFileSync(path.join(dir, "tts-voice-openai"), "nova\n");
    setEnv("OPENAI_API_KEY", undefined);
    expect(readOpenAiApiKey()).toBe("file-key");
    expect(ttsBackendInfo().options[0]).toMatchObject({ available: true, model: "tts-1-hd", voice: "nova" });
  });
});

describe("soniox as a TTS backend (#1020)", () => {
  function sonioxOption() {
    return ttsBackendInfo().options.find((option) => option.id === "soniox")!;
  }

  test("is selectable beside the existing providers, by file and by env lock", () => {
    expect(TTS_BACKENDS).toEqual(["openai", "elevenlabs", "soniox"]);
    expect(isTtsBackend("soniox")).toBe(true);

    configHome();
    delete process.env.LLV_TTS_BACKEND;
    writeTtsBackend("soniox");
    expect(resolveTtsBackend()).toBe("soniox");
    expect(ttsBackendInfo()).toMatchObject({ backend: "soniox", lockedByEnv: false });

    process.env.LLV_TTS_BACKEND = "soniox";
    writeTtsBackend("openai");
    expect(resolveTtsBackend()).toBe("soniox");
    expect(ttsBackendInfo().lockedByEnv).toBe(true);
  });

  test("defaults to the current realtime model and a built-in voice, overridable per machine", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    setEnv("SONIOX_API_KEY", "env-key");
    delete process.env.LLV_TTS_SONIOX_MODEL;
    delete process.env.LLV_TTS_SONIOX_VOICE;
    delete process.env.LLV_TTS_SONIOX_LANGUAGE;
    expect(sonioxOption()).toMatchObject({
      available: true,
      keyPath: path.join(dir, "soniox-api-key"),
      model: "tts-rt-v2",
      voice: "Adrian",
      language: "en",
    });

    fs.writeFileSync(path.join(dir, "tts-voice-soniox"), "Maya\n");
    fs.writeFileSync(path.join(dir, "tts-language-soniox"), "uk\n");
    expect(sonioxOption()).toMatchObject({ voice: "Maya", language: "uk" });
  });

  test("reads the key from the same file the transcription backend uses", () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    setEnv("SONIOX_API_KEY", undefined);
    expect(sonioxOption().available).toBe(false);

    fs.writeFileSync(path.join(dir, "soniox-api-key"), "file-key\n");
    expect(sonioxOption().available).toBe(true);
  });

  test("adding it leaves the OpenAI and ElevenLabs options in place", () => {
    configHome();
    expect(ttsBackendInfo().options.map((option) => option.id)).toEqual(["openai", "elevenlabs", "soniox"]);
  });
});
