/*
 * Server-side helpers for the /api/artifact resource route: byte-range
 * parsing, magic-byte agreement, identity validators and configurable bounds.
 * Pure functions over buffers and numbers — the route owns all I/O.
 */

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single `bytes=` range against a known size. Returns null when the
 * request is not a (single) byte range — the caller serves the full body, as
 * HTTP permits — and "unsatisfiable" when the range names no byte of the file,
 * which must become a 416 rather than a silently different body.
 */
export function parseByteRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    /* suffix form: last N bytes */
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end };
}

const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  "application/pdf": (head) => head.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (head) => head.length >= 8 && head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG",
  "image/jpeg": (head) => head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  "image/gif": (head) => /^GIF8[79]a/.test(head.subarray(0, 6).toString("latin1")),
  "image/webp": (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP",
  /* AVIF/BMP carry boxes/headers that vary; require the well-known markers. */
  "image/avif": (head) => head.subarray(4, 8).toString("latin1") === "ftyp",
  "image/bmp": (head) => head.subarray(0, 2).toString("latin1") === "BM",
};

function looksTextual(head: Buffer): boolean {
  return !head.includes(0);
}

/**
 * Does the file's head agree with the MIME the extension claims? Binary
 * formats must present their signature; text must be NUL-free (a renamed
 * binary is refused); SVG must additionally look like markup.
 */
export function sniffAgrees(mime: string, head: Buffer): boolean {
  const signature = SIGNATURES[mime];
  if (signature) return signature(head);
  if (mime === "image/svg+xml") {
    return looksTextual(head) && /<(\?xml|svg)[\s>]/i.test(head.toString("utf8"));
  }
  /* text/plain (all bounded text/source formats) */
  return looksTextual(head);
}

/**
 * Strong validator binding the response to one on-disk identity: device,
 * inode, size and mtime. A replaced or rewritten file changes at least one of
 * these, so an If-Match round-trip detects mid-preview mutation.
 */
export function artifactEtag(stat: { dev: number; ino: number; size: number; mtimeMs: number }): string {
  return `"d${stat.dev.toString(36)}-i${stat.ino.toString(36)}-s${stat.size.toString(36)}-m${Math.round(stat.mtimeMs).toString(36)}"`;
}

export interface ArtifactLimits {
  /** Hard per-file byte bound; anything larger is refused as too-large. */
  maxBytes: number;
  /** Wall-clock budget for streaming one response. */
  timeBudgetMs: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIME_BUDGET_MS = 30_000;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Read per request so tests and operators can retune without a restart. */
export function artifactLimits(env: NodeJS.ProcessEnv = process.env): ArtifactLimits {
  return {
    maxBytes: positiveInt(env.LLV_ARTIFACT_MAX_BYTES, DEFAULT_MAX_BYTES),
    timeBudgetMs: positiveInt(env.LLV_ARTIFACT_TIME_BUDGET_MS, DEFAULT_TIME_BUDGET_MS),
  };
}

/** ASCII-safe filename for a Content-Disposition parameter. */
export function dispositionFilename(name: string): string {
  const safe = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return safe.length > 0 ? safe : "artifact";
}
