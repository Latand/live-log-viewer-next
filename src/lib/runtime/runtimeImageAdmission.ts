import {
  hasRuntimeImageSignature,
  MAX_STRUCTURED_IMAGE_BYTES,
  MAX_STRUCTURED_IMAGE_ENCODED_BYTES,
  MAX_STRUCTURED_IMAGE_TOTAL_BYTES,
  MAX_STRUCTURED_IMAGES,
  type RuntimeImageUpload,
} from "./runtimeImageStore";
import { normalizeStructuredImageMime } from "./structuredContent";

export type RuntimeImageAdmissionStatus = 400 | 413 | 415;

export interface RuntimeImageAdmissionFailure {
  error: string;
  status: RuntimeImageAdmissionStatus;
}

export interface RuntimeImageAdmissionResult {
  images: RuntimeImageUpload[];
  error: RuntimeImageAdmissionFailure | null;
}

function failure(error: string, status: RuntimeImageAdmissionStatus): RuntimeImageAdmissionResult {
  return { images: [], error: { error, status } };
}

function canonicalBase64(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const data = Buffer.from(value, "base64");
  return data.length > 0 && data.toString("base64") === value ? data : null;
}

export function admitRuntimeImagePayload(body: { image?: unknown; images?: unknown }): RuntimeImageAdmissionResult {
  let raw: unknown[];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) return failure("images must be an array", 400);
    raw = body.images;
  } else if (body.image !== undefined) {
    if (!body.image || typeof body.image !== "object" || Array.isArray(body.image)) return failure("invalid image", 400);
    raw = [body.image];
  } else {
    raw = [];
  }
  if (raw.length > MAX_STRUCTURED_IMAGES) return failure(`too many images (${MAX_STRUCTURED_IMAGES} limit)`, 413);

  const images: RuntimeImageUpload[] = [];
  let encodedBytes = 0;
  let rawBytes = 0;
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return failure("invalid image", 400);
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.base64 !== "string" || typeof candidate.mime !== "string") return failure("invalid image", 400);
    encodedBytes += Buffer.byteLength(candidate.base64);
    if (encodedBytes > MAX_STRUCTURED_IMAGE_ENCODED_BYTES) return failure("runtime image request encoding is too large", 413);
    const data = canonicalBase64(candidate.base64);
    if (!data) return failure("runtime image base64 is invalid", 400);
    const mime = normalizeStructuredImageMime(candidate.mime);
    if (!mime) return failure("unsupported image type", 415);
    if (data.byteLength > MAX_STRUCTURED_IMAGE_BYTES) return failure("image is too large (10 MB limit)", 413);
    if (!hasRuntimeImageSignature(data, mime)) return failure("runtime image signature does not match MIME", 415);
    rawBytes += data.byteLength;
    if (rawBytes > MAX_STRUCTURED_IMAGE_TOTAL_BYTES) return failure("runtime image request is too large", 413);
    images.push({ base64: candidate.base64, mime });
  }
  return { images, error: null };
}
