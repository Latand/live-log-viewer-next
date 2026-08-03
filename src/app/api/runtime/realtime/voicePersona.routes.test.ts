import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

test("canonical voice persona transcripts are discoverable through files and readable through log", async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-voice-routes-"));
  const codexHome = path.join(isolated, "codex");
  const sessions = path.join(codexHome, "sessions", "2026", "08", "02");
  const sessionId = ["00000000", "0000", "4000", "8000", "000000000857"].join("-");
  const transcript = path.join(
    sessions,
    `rollout-2026-08-02T10-00-00-${sessionId}.jsonl`,
  );
  const persona = "Your name is Alik. Speak the operator's language.";
  const itemId = `msg_voice_persona_${"a".repeat(64)}`;
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-08-02T10:00:00.000Z",
      payload: {
        id: sessionId,
        timestamp: "2026-08-02T10:00:00.000Z",
        cwd: "/workspace/example",
        model: "test-model",
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-02T10:00:00.100Z",
      payload: {
        type: "message",
        id: itemId,
        role: "developer",
        content: [{ type: "input_text", text: persona }],
      },
    }),
  ].join("\n") + "\n");

  const previous = {
    state: process.env.LLV_STATE_DIR,
    codex: process.env.LLV_CODEX_HOME,
    claude: process.env.LLV_CLAUDE_HOME,
  };
  process.env.LLV_STATE_DIR = path.join(isolated, "state");
  process.env.LLV_CODEX_HOME = codexHome;
  process.env.LLV_CLAUDE_HOME = path.join(isolated, "claude");
  try {
    const [{ GET: filesGet }, { GET: logGet }] = await Promise.all([
      import("@/app/api/files/route"),
      import("@/app/api/log/route"),
    ]);
    const filesResponse = await filesGet(new Request(
      `http://127.0.0.1/api/files?path=${encodeURIComponent(transcript)}`,
    ));
    expect(filesResponse.status).toBe(200);
    const filesBody = await filesResponse.json() as { files: Array<{ path: string; engine: string }> };
    expect(filesBody.files).toContainEqual(expect.objectContaining({ path: transcript, engine: "codex" }));

    const logResponse = await logGet(new NextRequest(
      `http://127.0.0.1/api/log?path=${encodeURIComponent(transcript)}&offset=0`,
    ));
    expect(logResponse.status).toBe(200);
    const logBody = await logResponse.json() as { data: string };
    expect(logBody.data).toContain(itemId);
    expect(logBody.data).toContain(persona);
  } finally {
    if (previous.state === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous.state;
    if (previous.codex === undefined) delete process.env.LLV_CODEX_HOME;
    else process.env.LLV_CODEX_HOME = previous.codex;
    if (previous.claude === undefined) delete process.env.LLV_CLAUDE_HOME;
    else process.env.LLV_CLAUDE_HOME = previous.claude;
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});
