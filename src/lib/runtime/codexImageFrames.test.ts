import crypto from "node:crypto";
import { expect, test } from "bun:test";

import { CodexReplayFrameReducer, ReplayFrameOverflowError, sanitizeCodexImageFrame, shrinkReducedReplayFrame, type ImageSink, type ReplayFrameBudgets } from "./codexImageFrames";
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

const budgets = (overrides: Partial<ReplayFrameBudgets> = {}): ReplayFrameBudgets => ({
  maxStringUnits: 32,
  maxImageStringUnits: 4096,
  maxOutputUnits: 1024 * 1024,
  maxRawUnits: 16 * 1024 * 1024,
  ...overrides,
});

function reduce(line: string, limits = budgets(), chunkUnits?: number): string {
  const reducer = new CodexReplayFrameReducer(limits);
  if (chunkUnits === undefined) reducer.feed(line);
  else for (let offset = 0; offset < line.length; offset += chunkUnits) reducer.feed(line.slice(offset, offset + chunkUnits));
  return reducer.finish();
}

test("a frame with only short strings is reproduced verbatim", () => {
  const line = JSON.stringify({ id: 5, result: { thread: { id: "t-1", turns: [{ id: "turn", status: "completed" }] } } });
  for (const chunk of [undefined, 1, 3, 7]) {
    expect(reduce(line, budgets(), chunk)).toBe(line);
  }
});

test("a long string token keeps a bounded prefix and a truncation marker", () => {
  const line = JSON.stringify({ result: { text: "a".repeat(500), after: "intact" } });
  const reduced = reduce(line);
  const parsed = JSON.parse(reduced) as { result: { text: string; after: string } };
  expect(parsed.result.text.startsWith("a".repeat(32))).toBeTrue();
  expect(parsed.result.text).toContain("…[truncated 468 chars]");
  expect(parsed.result.after).toBe("intact");
});

test("escape sequences at the cut point stay atomic and the frame stays valid JSON", () => {
  const noisy = "\\\"\n".repeat(64);
  const line = JSON.stringify({ result: { text: noisy, tail: "kept" } });
  for (const chunk of [undefined, 1, 2, 5]) {
    const reduced = reduce(line, budgets(), chunk);
    const parsed = JSON.parse(reduced) as { result: { text: string; tail: string } };
    expect(parsed.result.text).toContain("truncated");
    expect(parsed.result.tail).toBe("kept");
  }
});

test("a surrogate pair is never split in front of the marker", () => {
  const line = JSON.stringify({ result: { text: `${"x".repeat(31)}😀${"y".repeat(64)}` } });
  const reduced = reduce(line);
  const parsed = JSON.parse(reduced) as { result: { text: string } };
  expect(parsed.result.text.startsWith("x".repeat(31))).toBeTrue();
  expect(parsed.result.text).not.toContain("😀"[0]! + "…");
});

test("an image data URL is exempt from the ordinary string budget", () => {
  const body = PNG.toString("base64").repeat(8);
  const line = JSON.stringify({ result: { image_url: `data:image/png;base64,${body}` } });
  expect(body.length).toBeGreaterThan(64);
  const reduced = reduce(line, budgets(), 11);
  const parsed = JSON.parse(reduced) as { result: { image_url: string } };
  expect(parsed.result.image_url).toBe(`data:image/png;base64,${body}`);
});

test("an image beyond even the image budget is still cut, not passed through", () => {
  const line = JSON.stringify({ result: { image_url: `data:image/png;base64,${"A".repeat(8192)}` } });
  const reduced = reduce(line);
  const parsed = JSON.parse(reduced) as { result: { image_url: string } };
  expect(parsed.result.image_url.length).toBeLessThan(4200);
  expect(parsed.result.image_url).toContain("truncated");
});

test("a structured-user digest prefix survives reduction of a long user text", () => {
  const digest = "0123456789abcdef".repeat(4);
  const wire = `<!-- llv:structured-user sha256=${digest} -->\n${"body ".repeat(200)}`;
  const reduced = reduce(JSON.stringify({ result: { text: wire } }), budgets({ maxStringUnits: 256 }));
  const parsed = JSON.parse(reduced) as { result: { text: string } };
  expect(parsed.result.text.startsWith(`<!-- llv:structured-user sha256=${digest} -->`)).toBeTrue();
});

test("the raw budget fails the frame closed", () => {
  const reducer = new CodexReplayFrameReducer(budgets({ maxRawUnits: 100 }));
  expect(() => reducer.feed("x".repeat(101))).toThrow(ReplayFrameOverflowError);
});

test("the output budget fails the frame closed", () => {
  const line = JSON.stringify({ result: { items: Array.from({ length: 64 }, () => ({ text: "t".repeat(31) })) } });
  const reducer = new CodexReplayFrameReducer(budgets({ maxOutputUnits: 256 }));
  expect(() => { reducer.feed(line); reducer.finish(); }).toThrow(ReplayFrameOverflowError);
});

test("shrinkReducedReplayFrame re-reduces a frame until it fits the byte budget", () => {
  const frame = JSON.stringify({ id: 7, result: { items: Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, text: "\u0449".repeat(4096) })) } });
  const shrunk = shrinkReducedReplayFrame(frame, 300 * 1024, budgets({ maxStringUnits: 4096, maxOutputUnits: 64 * 1024 * 1024, maxRawUnits: 256 * 1024 * 1024 }));
  expect(Buffer.byteLength(shrunk)).toBeLessThanOrEqual(300 * 1024);
  const parsed = JSON.parse(shrunk) as { id: number; result: { items: Array<{ id: string; text: string }> } };
  expect(parsed.id).toBe(7);
  expect(parsed.result.items).toHaveLength(100);
  expect(parsed.result.items[0]!.id).toBe("item-0");
  expect(parsed.result.items[0]!.text).toContain("truncated");
});

test("shrinkReducedReplayFrame returns a frame already inside the budget untouched", () => {
  const frame = JSON.stringify({ id: 1, result: { text: "short" } });
  expect(shrinkReducedReplayFrame(frame, 1024, budgets({}))).toBe(frame);
});
