import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { readOpenAiApiKey, resolveTtsBackend, ttsBackendInfo, writeTtsBackend } from "./ttsBackend";

const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const roots: string[] = [];

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tts-backend-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  return path.join(root, "agent-log-viewer");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  if (originalBackend === undefined) delete process.env.LLV_TTS_BACKEND;
  else process.env.LLV_TTS_BACKEND = originalBackend;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
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
    delete process.env.OPENAI_API_KEY;
    expect(readOpenAiApiKey()).toBe("file-key");
    expect(ttsBackendInfo().options[0]).toMatchObject({ available: true, model: "tts-1-hd", voice: "nova" });
  });
});
