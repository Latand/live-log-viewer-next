import crypto from "node:crypto";

import { normalizeStructuredImageMime, type StructuredImageMime, type StructuredImageRef } from "./structuredContent";

export interface RuntimeImageReference {
  type: "localImage";
  path: string;
  sha256: string;
  mime: string;
  bytes: number;
}

const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([\s\S]*)$/i;
const BODY_KEYS = new Set(["image_url", "imageUrl", "data", "url", "source"]);

export interface ImageSink {
  store(data: Buffer, mime: StructuredImageMime): string | null;
}

function referenceFor(data: Buffer, mime: StructuredImageMime, sink: ImageSink): RuntimeImageReference {
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  let stored: string | null = null;
  try { stored = sink.store(data, mime); }
  catch { stored = null; }
  return { type: "localImage", path: stored ?? "", sha256, mime, bytes: data.byteLength };
}

function decodeDataUrl(value: string): { data: Buffer; mime: StructuredImageMime } | null {
  const match = DATA_URL.exec(value.trim());
  if (!match) return null;
  const mime = normalizeStructuredImageMime(match[1]!);
  if (!mime) return null;
  const data = Buffer.from(match[2]!, "base64");
  return data.byteLength ? { data, mime } : null;
}

export interface SanitizeResult<T> {
  value: T;
  captured: StructuredImageRef[];
}

/**
 * Replace inline image data URLs from Codex app-server items with bounded
 * references before the frame reaches the durable event ledger.
 */
export function sanitizeCodexImageFrame<T>(value: T, sink: ImageSink): SanitizeResult<T> {
  const captured: StructuredImageRef[] = [];

  const walk = (node: unknown, keyHint: string | null): unknown => {
    if (typeof node === "string") {
      if (!keyHint || !BODY_KEYS.has(keyHint)) return node;
      const decoded = decodeDataUrl(node);
      if (!decoded) return node;
      const reference = referenceFor(decoded.data, decoded.mime, sink);
      captured.push({ sha256: reference.sha256, mime: decoded.mime, bytes: reference.bytes });
      return reference;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const next = node.map((item) => {
        const walked = walk(item, keyHint);
        if (walked !== item) changed = true;
        return walked;
      });
      return changed ? next : node;
    }
    if (!node || typeof node !== "object") return node;

    const source = node as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      const walked = walk(child, key);
      if (walked !== child) changed = true;
      next[key] = walked;
    }
    return changed ? next : node;
  };

  return { value: walk(value, null) as T, captured };
}
