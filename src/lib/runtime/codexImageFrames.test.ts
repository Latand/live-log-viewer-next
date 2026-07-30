import crypto from "node:crypto";
import { expect, test } from "bun:test";

import { sanitizeCodexImageFrame, type ImageSink } from "./codexImageFrames";
import { MAX_STRUCTURED_IMAGE_ENCODED_BYTES } from "./runtimeImageStore";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd4",
  "hex",
);

function sink(): ImageSink & { stored: number } {
  const state = { stored: 0, store: () => { state.stored += 1; return "/runtime-images/stored.png"; } };
  return state as ImageSink & { stored: number };
}

function echoedItem(base64: string) {
  return {
    id: "item_1",
    item_type: "user_message",
    content: [
      { type: "input_image", image_url: `data:image/png;base64,${base64}` },
      { type: "text", text: "what is wrong with this screenshot?" },
    ],
  };
}

test("an inlined image body is replaced by its bounded reference", () => {
  const target = sink();
  const { value, captured } = sanitizeCodexImageFrame(echoedItem(PNG.toString("base64")), target);
  const parts = (value as unknown as { content: Record<string, unknown>[] }).content;

  expect(parts[0]).toEqual({
    type: "input_image",
    image_url: {
      type: "localImage",
      path: "/runtime-images/stored.png",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      mime: "image/png",
      bytes: PNG.byteLength,
    },
  });
  expect(parts[1]).toEqual({ type: "text", text: "what is wrong with this screenshot?" });
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ mime: "image/png", bytes: PNG.byteLength });
  expect(target.stored).toBe(1);
});

test("the serialized frame collapses from the whole image to a bounded reference", () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const item = echoedItem(big.toString("base64"));
  const before = Buffer.byteLength(JSON.stringify(item));
  const { value } = sanitizeCodexImageFrame(item, sink());
  const after = Buffer.byteLength(JSON.stringify(value));

  expect(before).toBeGreaterThan(4_000_000);
  expect(after).toBeLessThan(1_000);
});

test("an image set at the admission ceiling still serializes to a bounded frame", () => {
  const each = Buffer.alloc(Math.floor((MAX_STRUCTURED_IMAGE_ENCODED_BYTES / 4) * 3 / 4), 3);
  const item = {
    id: "item_1",
    content: Array.from({ length: 4 }, () => ({
      type: "input_image",
      image_url: `data:image/png;base64,${each.toString("base64")}`,
    })),
  };
  expect(Buffer.byteLength(JSON.stringify(item))).toBeGreaterThan(MAX_STRUCTURED_IMAGE_ENCODED_BYTES * 0.9);

  const { value, captured } = sanitizeCodexImageFrame(item, sink());
  expect(captured).toHaveLength(4);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(2_000);
});

test("a frame with no image body is returned by identity", () => {
  const item = { id: "item_1", content: [{ type: "text", text: "no attachment here" }] };
  const { value, captured } = sanitizeCodexImageFrame(item, sink());
  expect(value).toBe(item);
  expect(captured).toEqual([]);
});

test("text that merely looks like a data URL is left alone", () => {
  const item = { content: [{ type: "text", text: `data:image/png;base64,${PNG.toString("base64")}` }] };
  const { value, captured } = sanitizeCodexImageFrame(item, sink());
  expect(value).toBe(item);
  expect(captured).toEqual([]);
});

test("a body nested anywhere is found, including under a source object and in an array", () => {
  const base64 = PNG.toString("base64");
  const item = {
    content: [
      { type: "image", source: `data:image/png;base64,${base64}` },
      { type: "input_image", image_url: [`data:image/png;base64,${base64}`] },
    ],
  };
  const { value, captured } = sanitizeCodexImageFrame(item, sink());

  expect(captured).toHaveLength(2);
  const parts = (value as typeof item).content;
  expect((parts[0] as unknown as { source: { type: string } }).source.type).toBe("localImage");
  expect((parts[1] as unknown as { image_url: { type: string }[] }).image_url[0]!.type).toBe("localImage");
});

test("an unusable body is left as it was", () => {
  const item = {
    content: [
      { type: "input_image", image_url: "data:image/png;base64," },
      { type: "input_image", image_url: "data:application/pdf;base64,JVBERi0=" },
      { type: "input_image", image_url: "https://example.invalid/a.png" },
    ],
  };
  const { value, captured } = sanitizeCodexImageFrame(item, sink());
  expect(value).toBe(item);
  expect(captured).toEqual([]);
});

test("a store failure still yields a bounded reference", () => {
  const refusing: ImageSink = { store: () => { throw new Error("quota exceeded"); } };
  const { value, captured } = sanitizeCodexImageFrame(echoedItem(PNG.toString("base64")), refusing);
  const parts = (value as unknown as { content: Record<string, unknown>[] }).content;

  expect(parts[0]!.image_url).toMatchObject({
    type: "localImage",
    path: "",
    mime: "image/png",
    bytes: PNG.byteLength,
  });
  expect(captured).toHaveLength(1);
});

test("the reference digest names the stored image bytes", () => {
  const { captured } = sanitizeCodexImageFrame(echoedItem(PNG.toString("base64")), sink());
  expect(captured[0]!.sha256).toBe(crypto.createHash("sha256").update(PNG).digest("hex"));
});
