import crypto from "node:crypto";
import readline from "node:readline";

import {
  normalizeStructuredImageMime,
  structuredContentDigest,
  type StructuredImageRef,
} from "../structuredContent";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function verifyContent(value: unknown): { blocks: unknown[]; digest: string } {
  if (!Array.isArray(value) || value.length === 0) throw new Error("content blocks are required");
  const images: StructuredImageRef[] = [];
  let text = "";
  let sawText = false;
  for (const [index, block] of value.entries()) {
    const item = object(block);
    if (item?.type === "text") {
      if (sawText || index !== value.length - 1 || typeof item.text !== "string" || !item.text) {
        throw new Error("text block order is invalid");
      }
      sawText = true;
      text = item.text;
      continue;
    }
    if (sawText || item?.type !== "image") throw new Error("image block order is invalid");
    const source = object(item.source);
    const mime = typeof source?.media_type === "string" ? normalizeStructuredImageMime(source.media_type) : null;
    if (source?.type !== "base64" || !mime || typeof source.data !== "string") throw new Error("image source is invalid");
    const data = Buffer.from(source.data, "base64");
    if (!data.length || data.toString("base64") !== source.data) throw new Error("image data is invalid");
    images.push({
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      mime,
      bytes: data.byteLength,
    });
  }
  if (images.length === 0) throw new Error("fixture requires image content");
  return { blocks: value, digest: structuredContentDigest({ text, images }) };
}

const sessionId = process.env.LLV_FIXTURE_SESSION_ID ?? "";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line) continue;
  const frame = object(JSON.parse(line));
  const message = object(frame?.message);
  if (frame?.type !== "user" || frame.session_id !== sessionId || message?.role !== "user") {
    throw new Error("user frame is invalid");
  }
  const verified = verifyContent(message.content);
  process.stdout.write(`${JSON.stringify({
    type: "user",
    isReplay: true,
    session_id: sessionId,
    uuid: crypto.randomUUID(),
    message: { role: "user", content: verified.blocks },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", content: [{ type: "text", text: `digest:${verified.digest}` }] },
  })}\n`);
  await Bun.sleep(20);
  process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: sessionId })}\n`);
}
