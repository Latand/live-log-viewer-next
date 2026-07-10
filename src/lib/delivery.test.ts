import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanupFailedImageDelivery, type DeliveryFailure } from "./delivery";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-test-"));
const failure: DeliveryFailure = { ok: false, outcome: "failed", error: "resume unavailable", status: 503 };

function inboxImage(name: string): string {
  const pathname = path.join(SANDBOX, name);
  fs.writeFileSync(pathname, "image");
  return pathname;
}

beforeEach(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterAll(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test("removes a direct-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("direct.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});

test("removes a relayed-delivery inbox image before returning its host failure", () => {
  const imagePath = inboxImage("relay.png");

  expect(cleanupFailedImageDelivery(failure, [imagePath])).toEqual(failure);
  expect(fs.existsSync(imagePath)).toBe(false);
});
