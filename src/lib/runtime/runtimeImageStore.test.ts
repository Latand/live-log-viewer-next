import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import {
  MAX_STRUCTURED_IMAGES,
  MAX_STRUCTURED_IMAGE_ENCODED_BYTES,
  RuntimeImageStore,
} from "./runtimeImageStore";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408d763f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082",
  "hex",
);

function sandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-images-"));
}

test("runtime images are validated and stored as private content-addressed blobs", () => {
  const root = sandbox();
  const store = new RuntimeImageStore(root);
  const input = { base64: PNG.toString("base64"), mime: "image/png" };

  const [first] = store.putMany([input]);
  const [second] = store.putMany([input]);
  const sha256 = crypto.createHash("sha256").update(PNG).digest("hex");

  expect(first).toEqual({ sha256, mime: "image/png", bytes: PNG.byteLength });
  expect(second).toEqual(first);
  expect(store.read(first!)).toEqual(PNG);
  expect(fs.statSync(store.pathFor(first!)).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(root)).toEqual([`${sha256}.png`]);
});

test("runtime image admission rejects malformed data, MIME mismatches, and excess images", () => {
  const store = new RuntimeImageStore(sandbox());
  expect(() => store.putMany([{ base64: "%%%", mime: "image/png" }])).toThrow("base64");
  expect(() => store.putMany([{ base64: PNG.toString("base64"), mime: "image/jpeg" }])).toThrow("signature");
  expect(() => store.putMany(Array.from({ length: MAX_STRUCTURED_IMAGES + 1 }, () => ({
    base64: PNG.toString("base64"),
    mime: "image/png",
  })))).toThrow("too many images");
  expect(() => store.putMany([{
    base64: "A".repeat(MAX_STRUCTURED_IMAGE_ENCODED_BYTES + 4),
    mime: "image/png",
  }])).toThrow("encoding is too large");
});

test("runtime image reads reject missing and corrupt content-addressed refs", () => {
  const store = new RuntimeImageStore(sandbox());
  const [ref] = store.putMany([{ base64: PNG.toString("base64"), mime: "image/png" }]);
  if (!ref) throw new Error("image ref missing");
  fs.writeFileSync(store.pathFor(ref), Buffer.from("corrupt"));
  expect(() => store.read(ref)).toThrow("digest mismatch");
  fs.rmSync(store.pathFor(ref));
  expect(() => store.read(ref)).toThrow("missing");
});
