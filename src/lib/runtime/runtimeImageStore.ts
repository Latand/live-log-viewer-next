import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import {
  normalizeStructuredImageMime,
  CODEX_STRUCTURED_IMAGE_REASON,
  STRUCTURED_IMAGE_MIMES,
  STRUCTURED_IMAGE_PROTOCOL_REASON,
  type RuntimeImageCapability,
  type StructuredImageMime,
  type StructuredImageRef,
} from "./structuredContent";

export const MAX_STRUCTURED_IMAGES = 16;
export const MAX_STRUCTURED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_STRUCTURED_IMAGE_TOTAL_BYTES = 18 * 1024 * 1024;
export const MAX_STRUCTURED_IMAGE_ENCODED_BYTES = 24 * 1024 * 1024;

export interface RuntimeImageUpload {
  base64: string;
  mime: string;
}

export function runtimeImageCapability(engine: "claude" | "codex", protocolAdvertised: boolean): RuntimeImageCapability {
  const supported = engine === "claude" && protocolAdvertised;
  const reason = supported
    ? null
    : engine === "codex"
      ? CODEX_STRUCTURED_IMAGE_REASON
      : STRUCTURED_IMAGE_PROTOCOL_REASON;
  return {
    supported,
    reason,
    formats: [...STRUCTURED_IMAGE_MIMES],
    maxImages: MAX_STRUCTURED_IMAGES,
    maxRawBytesPerImage: MAX_STRUCTURED_IMAGE_BYTES,
    maxEncodedBytesPerRequest: MAX_STRUCTURED_IMAGE_ENCODED_BYTES,
  };
}

const MIME_EXT: Record<StructuredImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function hasImageSignature(data: Buffer, mime: StructuredImageMime): boolean {
  if (mime === "image/png") {
    return data.length >= 24
      && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      && data.subarray(12, 16).toString("ascii") === "IHDR";
  }
  if (mime === "image/jpeg") {
    return data.length >= 4
      && data[0] === 0xff
      && data[1] === 0xd8
      && data[2] === 0xff
      && data.at(-2) === 0xff
      && data.at(-1) === 0xd9;
  }
  if (mime === "image/gif") {
    const header = data.subarray(0, 6).toString("ascii");
    return data.length >= 10 && (header === "GIF87a" || header === "GIF89a");
  }
  return data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP";
}

function decodeBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("runtime image base64 is invalid");
  }
  const data = Buffer.from(value, "base64");
  if (data.length === 0 || data.toString("base64") !== value) throw new Error("runtime image base64 is invalid");
  return data;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export class RuntimeImageStore {
  constructor(private readonly root = statePath("runtime-images")) {}

  putMany(uploads: readonly RuntimeImageUpload[]): StructuredImageRef[] {
    if (uploads.length > MAX_STRUCTURED_IMAGES) throw new Error("too many images");
    const encodedBytes = uploads.reduce((sum, upload) => sum + Buffer.byteLength(upload.base64), 0);
    if (encodedBytes > MAX_STRUCTURED_IMAGE_ENCODED_BYTES) throw new Error("runtime image request encoding is too large");
    const decoded = uploads.map((upload) => this.validateUpload(upload));
    const total = decoded.reduce((sum, item) => sum + item.data.byteLength, 0);
    if (total > MAX_STRUCTURED_IMAGE_TOTAL_BYTES) throw new Error("runtime image request is too large");
    return decoded.map(({ data, mime }) => this.put(data, mime));
  }

  read(ref: StructuredImageRef): Buffer {
    const filename = this.pathFor(ref);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(filename); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`runtime image ${ref.sha256.slice(0, 12)} is missing`);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("runtime image ref is unsafe");
    const data = fs.readFileSync(filename);
    if (data.byteLength !== ref.bytes || crypto.createHash("sha256").update(data).digest("hex") !== ref.sha256) {
      throw new Error(`runtime image ${ref.sha256.slice(0, 12)} digest mismatch`);
    }
    if (!hasImageSignature(data, ref.mime)) throw new Error(`runtime image ${ref.sha256.slice(0, 12)} signature mismatch`);
    return data;
  }

  pathFor(ref: StructuredImageRef): string {
    const mime = normalizeStructuredImageMime(ref.mime);
    if (!mime || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      throw new Error("runtime image ref is invalid");
    }
    return path.join(this.root, `${ref.sha256}.${MIME_EXT[mime]}`);
  }

  private validateUpload(upload: RuntimeImageUpload): { data: Buffer; mime: StructuredImageMime } {
    const mime = normalizeStructuredImageMime(upload.mime);
    if (!mime) throw new Error("runtime image MIME is unsupported");
    const data = decodeBase64(upload.base64);
    if (data.byteLength > MAX_STRUCTURED_IMAGE_BYTES) throw new Error("runtime image exceeds 10 MB");
    if (!hasImageSignature(data, mime)) throw new Error("runtime image signature does not match MIME");
    return { data, mime };
  }

  private put(data: Buffer, mime: StructuredImageMime): StructuredImageRef {
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const ref = { sha256, mime, bytes: data.byteLength };
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    const filename = this.pathFor(ref);
    if (fs.existsSync(filename)) {
      this.read(ref);
      fs.chmodSync(filename, 0o600);
      return ref;
    }
    const temporary = path.join(this.root, `.${sha256}.${crypto.randomUUID()}.partial`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, filename);
      fs.chmodSync(filename, 0o600);
      syncDirectory(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.read(ref);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return ref;
  }
}

let defaultStore: RuntimeImageStore | null = null;

export function runtimeImageStore(): RuntimeImageStore {
  return defaultStore ??= new RuntimeImageStore();
}
