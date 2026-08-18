import type { TranscribeResponse } from "./types";

/* Soniox async STT for the record-then-transcribe fallback (the realtime model
   is WebSocket-only, see sonioxLive.ts). Their async API is a four-step flow:
   upload the audio, create a transcription over it, poll until it completes,
   then read the transcript. Both server-side artifacts are deleted afterwards
   so a dictation leaves nothing behind in the account. */
const SONIOX_API_BASE = "https://api.soniox.com/v1";
const SONIOX_ASYNC_MODEL = process.env.LLV_SONIOX_STT_MODEL || "stt-async-v5";
const UPSTREAM_TIMEOUT_S = 90;
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = UPSTREAM_TIMEOUT_S * 1000;

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

async function expectOk(res: Response, step: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`${step}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
}

async function uploadFile(apiKey: string, file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file, "dictation.webm");
  const res = await fetch(`${SONIOX_API_BASE}/files`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await expectOk(res, "upload");
  const json = (await res.json()) as { id?: unknown };
  if (typeof json.id !== "string" || !json.id) throw new Error("upload: response had no file id");
  return json.id;
}

async function createTranscription(apiKey: string, fileId: string, language: string): Promise<string> {
  const res = await fetch(`${SONIOX_API_BASE}/transcriptions`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "content-type": "application/json" },
    body: JSON.stringify({
      file_id: fileId,
      model: SONIOX_ASYNC_MODEL,
      ...(language ? { language_hints: [language.slice(0, 2)] } : {}),
    }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await expectOk(res, "transcription");
  const json = (await res.json()) as { id?: unknown };
  if (typeof json.id !== "string" || !json.id) throw new Error("transcription: response had no id");
  return json.id;
}

/* Polls status until it settles. The first check happens before any wait, so a
   short clip that is already done costs no extra latency. */
async function waitForCompletion(apiKey: string, transcriptionId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(`${SONIOX_API_BASE}/transcriptions/${encodeURIComponent(transcriptionId)}`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    await expectOk(res, "transcription status");
    const json = (await res.json()) as { status?: unknown; error_message?: unknown };
    if (json.status === "completed") return;
    if (json.status === "error") {
      throw new Error(typeof json.error_message === "string" && json.error_message ? json.error_message : "transcription failed");
    }
    if (Date.now() >= deadline) throw new Error(`transcription timed out after ${UPSTREAM_TIMEOUT_S}s`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function fetchTranscript(apiKey: string, transcriptionId: string): Promise<string> {
  const res = await fetch(`${SONIOX_API_BASE}/transcriptions/${encodeURIComponent(transcriptionId)}/transcript`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  await expectOk(res, "transcript");
  const json = (await res.json()) as { text?: unknown; tokens?: unknown };
  if (typeof json.text === "string") return json.text.trim();
  /* Older responses carry only tokens; their texts already include spacing. */
  if (Array.isArray(json.tokens)) {
    return json.tokens
      .map((token) => (token && typeof token === "object" ? (token as { text?: unknown }).text : null))
      .filter((text): text is string => typeof text === "string")
      .join("")
      .trim();
  }
  return "";
}

/* Best-effort teardown: a dictation that transcribed fine must not fail
   because the cleanup DELETE did. */
async function discard(apiKey: string, url: string): Promise<void> {
  try {
    await fetch(url, { method: "DELETE", headers: authHeaders(apiKey), signal: AbortSignal.timeout(10_000) });
  } catch {
    /* the artifact expires on Soniox's side anyway */
  }
}

export async function sonioxTranscribe(apiKey: string, file: File, language: string): Promise<TranscribeResponse> {
  const fileId = await uploadFile(apiKey, file);
  let transcriptionId: string | null = null;
  try {
    transcriptionId = await createTranscription(apiKey, fileId, language);
    await waitForCompletion(apiKey, transcriptionId);
    return { text: await fetchTranscript(apiKey, transcriptionId) };
  } finally {
    if (transcriptionId) await discard(apiKey, `${SONIOX_API_BASE}/transcriptions/${encodeURIComponent(transcriptionId)}`);
    await discard(apiKey, `${SONIOX_API_BASE}/files/${encodeURIComponent(fileId)}`);
  }
}
