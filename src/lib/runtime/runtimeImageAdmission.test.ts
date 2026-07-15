import { expect, test } from "bun:test";

import { admitRuntimeImagePayload } from "./runtimeImageAdmission";
import { MAX_STRUCTURED_IMAGE_BYTES, MAX_STRUCTURED_IMAGES } from "./runtimeImageStore";

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

function png(bytes = PNG_HEADER.byteLength): { base64: string; mime: string } {
  return { base64: Buffer.concat([PNG_HEADER, Buffer.alloc(Math.max(0, bytes - PNG_HEADER.byteLength))]).toString("base64"), mime: "image/png" };
}

test("runtime image admission preserves the legacy single-image field and normalizes MIME", () => {
  expect(admitRuntimeImagePayload({ image: { ...png(), mime: "IMAGE/PNG" } })).toEqual({
    images: [{ ...png(), mime: "image/png" }],
    error: null,
  });
});

test("runtime image admission maps malformed schema and non-canonical base64 to 400", () => {
  expect(admitRuntimeImagePayload({ images: "bad" }).error?.status).toBe(400);
  expect(admitRuntimeImagePayload({ images: [{}] }).error?.status).toBe(400);
  expect(admitRuntimeImagePayload({ images: [{ base64: "a===", mime: "image/png" }] }).error?.status).toBe(400);
  expect(admitRuntimeImagePayload({ images: [{ base64: "YWJjZA", mime: "image/png" }] }).error?.status).toBe(400);
});

test("runtime image admission maps count, per-image, encoded, and aggregate limits to 413", () => {
  expect(admitRuntimeImagePayload({ images: Array.from({ length: MAX_STRUCTURED_IMAGES + 1 }, () => png()) }).error?.status).toBe(413);
  expect(admitRuntimeImagePayload({ images: [png(MAX_STRUCTURED_IMAGE_BYTES)] }).error).toBeNull();
  expect(admitRuntimeImagePayload({ images: [png(MAX_STRUCTURED_IMAGE_BYTES + 1)] }).error?.status).toBe(413);
  expect(admitRuntimeImagePayload({ images: [png(9 * 1024 * 1024), png(9 * 1024 * 1024 + 1)] }).error?.status).toBe(413);
});

test("runtime image admission maps MIME and signature mismatches to 415", () => {
  expect(admitRuntimeImagePayload({ images: [{ ...png(), mime: "image/svg+xml" }] }).error?.status).toBe(415);
  expect(admitRuntimeImagePayload({ images: [{ base64: Buffer.from("plain text").toString("base64"), mime: "image/png" }] }).error?.status).toBe(415);
});
