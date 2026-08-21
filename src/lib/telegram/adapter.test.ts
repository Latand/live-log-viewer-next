import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-adapter-"));
const OLD_ENV = {
  HOME: process.env.HOME,
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_TELEGRAM_API_ID: process.env.LLV_TELEGRAM_API_ID,
  LLV_TELEGRAM_API_HASH: process.env.LLV_TELEGRAM_API_HASH,
  PATH: process.env.PATH,
};
const fakeBin = path.join(SANDBOX, "bin");
fs.mkdirSync(fakeBin, { recursive: true });
const fakeUv = path.join(fakeBin, "uv");
fs.writeFileSync(fakeUv, [
  "#!/bin/sh",
  "set -eu",
  "if [ \"${1:-}\" = \"--version\" ]; then exit 0; fi",
  "mkdir -p \"$UV_PROJECT_ENVIRONMENT/bin\"",
  "printf '%s\\n' '#!/bin/sh' 'if [ \"${1:-}\" = \"-c\" ]; then exit 0; fi' \"printf '%s\\n' '{\\\"event\\\":\\\"qr\\\",\\\"url\\\":\\\"tg://login?token=fixture\\\",\\\"expiresAt\\\":\\\"2026-08-20T20:00:00.000Z\\\"}'\" 'sleep 30' > \"$UV_PROJECT_ENVIRONMENT/bin/python\"",
  "chmod 700 \"$UV_PROJECT_ENVIRONMENT/bin/python\"",
  "",
].join("\n"), { mode: 0o700 });

process.env.HOME = path.join(SANDBOX, "home");
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_TELEGRAM_API_ID = "12345";
process.env.LLV_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
process.env.PATH = `${fakeBin}:${OLD_ENV.PATH ?? ""}`;
fs.mkdirSync(process.env.HOME, { recursive: true });
const toolsDir = path.join(process.env.LLV_STATE_DIR, "telegram", "tools");
fs.mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
fs.copyFileSync(fakeUv, path.join(toolsDir, "uv"));
fs.chmodSync(path.join(toolsDir, "uv"), 0o700);

const { processTelegramAdapter } = await import("./adapter");
const { telegramVenvPython } = await import("./packaging");

afterAll(() => {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("a clean product login provisions the packaged connector before emitting QR", async () => {
  expect(fs.existsSync(telegramVenvPython())).toBe(false);
  expect(processTelegramAdapter.unavailableReason()).toBeNull();

  let handle: ReturnType<typeof processTelegramAdapter.startEnrollment>;
  const event = await new Promise<{ type: string; url?: string; expiresAt?: string }>((resolve) => {
    handle = processTelegramAdapter.startEnrollment((next) => {
      if (next.type === "qr" || next.type === "failed") resolve(next);
    });
  });

  expect(event).toEqual({
    type: "qr",
    url: "tg://login?token=fixture",
    expiresAt: "2026-08-20T20:00:00.000Z",
  });
  expect(fs.existsSync(telegramVenvPython())).toBe(true);
  expect(fs.statSync(path.dirname(path.dirname(path.dirname(telegramVenvPython())))).mode & 0o777).toBe(0o700);
  handle!.cancel();
}, 5_000);
