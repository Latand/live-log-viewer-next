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

export interface ReplayFrameBudgets {
  /** Retained UTF-16 units per ordinary JSON string token. */
  maxStringUnits: number;
  /** Retained units for a string token that opens as a base64 image data URL. */
  maxImageStringUnits: number;
  /** Budget for the reduced line; exceeding it fails the frame. */
  maxOutputUnits: number;
  /** Budget for the raw frame across all feeds; exceeding it fails the frame. */
  maxRawUnits: number;
}

export class ReplayFrameOverflowError extends Error {
  constructor(budget: "raw" | "output") {
    super(`Codex replay frame exceeded its bounded ${budget} budget`);
  }
}

const STRING_HEAD_SNIFF_UNITS = 64;
const IMAGE_STRING_PREFIX = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;

/**
 * Streaming reducer for one admitted replay JSONL frame (a `thread/resume` or
 * `thread/read` response whose serialized history can dwarf the ordinary frame
 * guard). It rewrites the raw JSON text token by token: every string token
 * keeps a bounded prefix (plus a truncation marker), except base64 image data
 * URLs, which keep the full admissible image encoding so the post-parse image
 * sanitizer can still capture them as bounded references. Everything outside
 * string tokens passes through verbatim, so the reduced line stays valid JSON
 * with the original structure, ids, and statuses intact.
 *
 * Feeds must not contain the frame-terminating newline; JSON strings cannot
 * hold a raw newline, so the caller can split frames on `\n` before feeding.
 */
export class CodexReplayFrameReducer {
  private readonly parts: string[] = [];
  private outputUnits = 0;
  private rawUnits = 0;
  private inString = false;
  private stringParts: string[] = [];
  private stringUnits = 0;
  private stringOmitted = 0;
  private stringHead = "";
  private stringCap: number;
  private stringCapSniffed = false;
  private escapeCarry = "";

  constructor(private readonly budgets: ReplayFrameBudgets) {
    this.stringCap = budgets.maxStringUnits;
  }

  feed(chunk: string): void {
    this.rawUnits += chunk.length;
    if (this.rawUnits > this.budgets.maxRawUnits) throw new ReplayFrameOverflowError("raw");
    if (this.escapeCarry) {
      chunk = this.escapeCarry + chunk;
      this.escapeCarry = "";
    }
    let index = 0;
    while (index < chunk.length) {
      if (!this.inString) {
        const quote = chunk.indexOf('"', index);
        if (quote === -1) {
          this.append(chunk.slice(index));
          return;
        }
        this.append(chunk.slice(index, quote + 1));
        this.inString = true;
        index = quote + 1;
        continue;
      }
      const quote = chunk.indexOf('"', index);
      const backslash = chunk.indexOf("\\", index);
      const stop = quote === -1 ? backslash : backslash === -1 ? quote : Math.min(quote, backslash);
      if (stop === -1) {
        this.appendToString(chunk.slice(index));
        return;
      }
      if (stop > index) this.appendToString(chunk.slice(index, stop));
      if (stop === quote) {
        this.endString();
        index = stop + 1;
        continue;
      }
      const escapeUnits = chunk.charCodeAt(stop + 1) === 117 /* u */ ? 6 : 2;
      const escape = chunk.slice(stop, stop + escapeUnits);
      if (escape.length < escapeUnits) {
        this.escapeCarry = escape;
        return;
      }
      this.appendToString(escape, true);
      index = stop + escapeUnits;
    }
  }

  finish(): string {
    /* A frame that ends mid-string or mid-escape was malformed JSON to begin
       with; flush what was retained and let the JSON parser fail it closed. */
    if (this.escapeCarry) {
      this.appendToString(this.escapeCarry);
      this.escapeCarry = "";
    }
    if (this.inString) this.endString(false);
    return this.parts.join("");
  }

  private append(text: string): void {
    if (!text) return;
    this.outputUnits += text.length;
    if (this.outputUnits > this.budgets.maxOutputUnits) throw new ReplayFrameOverflowError("output");
    this.parts.push(text);
  }

  private appendToString(run: string, atomic = false): void {
    if (this.stringHead.length < STRING_HEAD_SNIFF_UNITS) {
      this.stringHead += run.slice(0, STRING_HEAD_SNIFF_UNITS - this.stringHead.length);
    }
    if (!this.stringCapSniffed && this.stringUnits + run.length > this.stringCap) {
      this.stringCapSniffed = true;
      if (IMAGE_STRING_PREFIX.test(this.stringHead)) this.stringCap = this.budgets.maxImageStringUnits;
    }
    const room = this.stringCap - this.stringUnits;
    if (room >= run.length) {
      this.stringParts.push(run);
      this.stringUnits += run.length;
      return;
    }
    if (atomic || room <= 0) {
      this.stringOmitted += run.length;
      return;
    }
    this.stringParts.push(run.slice(0, room));
    this.stringUnits += room;
    this.stringOmitted += run.length - room;
  }

  private endString(closeQuote = true): void {
    if (this.stringOmitted > 0) {
      const last = this.stringParts[this.stringParts.length - 1];
      const trailing = last ? last.charCodeAt(last.length - 1) : 0;
      /* Never leave a cut-off high surrogate in front of the marker. */
      if (trailing >= 0xd800 && trailing <= 0xdbff) {
        this.stringParts[this.stringParts.length - 1] = last!.slice(0, -1);
        this.stringOmitted += 1;
      }
      this.stringParts.push(`…[truncated ${this.stringOmitted} chars]`);
    }
    this.append(this.stringParts.join("") + (closeQuote ? '"' : ""));
    this.inString = false;
    this.stringParts = [];
    this.stringUnits = 0;
    this.stringOmitted = 0;
    this.stringHead = "";
    this.stringCap = this.budgets.maxStringUnits;
    this.stringCapSniffed = false;
  }
}
