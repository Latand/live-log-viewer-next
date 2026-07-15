import crypto from "node:crypto";

export const STRUCTURED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const STRUCTURED_IMAGE_CAPABILITY = "structured-image-v1";
export type StructuredImageMime = (typeof STRUCTURED_IMAGE_MIMES)[number];

export interface StructuredImageRef {
  sha256: string;
  mime: StructuredImageMime;
  bytes: number;
}

export interface StructuredMessageContent {
  text: string;
  images: StructuredImageRef[];
}

export interface StructuredContentEnvelope {
  content: StructuredMessageContent;
  contentDigest: string;
}

export interface RuntimeImageCapability {
  supported: boolean;
  reason: string | null;
  formats: StructuredImageMime[];
  maxImages: number;
  maxRawBytesPerImage: number;
  maxEncodedBytesPerRequest: number;
}

export const CODEX_STRUCTURED_IMAGE_REASON = "The selected Codex model does not advertise image input through app-server.";
export const STRUCTURED_IMAGE_PROTOCOL_REASON = "Structured image protocol is unavailable for this host.";

export function normalizeStructuredImageMime(value: string): StructuredImageMime | null {
  const mime = value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase();
  return STRUCTURED_IMAGE_MIMES.includes(mime as StructuredImageMime) ? mime as StructuredImageMime : null;
}

export function parseStructuredImageRef(value: unknown): StructuredImageRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StructuredImageRef>;
  const mime = typeof candidate.mime === "string" ? normalizeStructuredImageMime(candidate.mime) : null;
  if (!mime || typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256)) return null;
  if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes! <= 0) return null;
  return { sha256: candidate.sha256, mime, bytes: candidate.bytes! };
}

export function parseStructuredImageRefs(value: unknown, maxImages: number): StructuredImageRef[] | null {
  if (!Array.isArray(value) || value.length > maxImages) return null;
  const refs = value.map(parseStructuredImageRef);
  return refs.every((ref): ref is StructuredImageRef => ref !== null) ? refs : null;
}

export function structuredContentDigest(content: StructuredMessageContent): string {
  const canonical = JSON.stringify({
    text: content.text,
    images: content.images.map(({ sha256, mime, bytes }) => ({ sha256, mime, bytes })),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function structuredContent(text: string, images: readonly StructuredImageRef[]): StructuredContentEnvelope {
  const content = { text, images: images.map((image) => ({ ...image })) };
  if (!content.text.trim() && content.images.length === 0) throw new Error("message content is required");
  return { content, contentDigest: structuredContentDigest(content) };
}
