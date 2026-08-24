import crypto from "node:crypto";

import { expect, test } from "bun:test";

import { messageTextDigest, sha256Hex } from "./messageTextDigest";
import { structuredContent } from "./structuredContent";

/**
 * The browser-side digest must equal the registry's `contentDigest` exactly:
 * the feed's occurrence join (#1117) compares the two as opaque strings, so
 * any drift silently loses every legacy attribution.
 */

const SAMPLES = [
  "please rerun the failing check",
  "Round 2 verdict: REQUEST_CHANGES\n\n- P1 — the held command drops its origin.",
  "розкажи що плануєш робити далі, і чому саме так",
  "emoji 🚀 and surrogate pairs 𝄞 survive the encoding",
  /* Lengths around the SHA-256 block boundaries exercise every padding branch. */
  "x".repeat(55 - 24),
  "x".repeat(56 - 24),
  "x".repeat(64 - 24),
  "y".repeat(120),
  "z".repeat(12_000),
  "tab\tand \"quotes\" and back\\slash and a trailing newline\n",
];

test("messageTextDigest equals the registry's structured content digest for text-only messages", () => {
  for (const sample of SAMPLES) {
    expect(messageTextDigest(sample)).toBe(structuredContent(sample, []).contentDigest);
  }
});

test("sha256Hex matches node:crypto across block-boundary lengths and the empty input", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1_000]) {
    const bytes = new Uint8Array(length).map((_, index) => (index * 31 + 7) & 0xff);
    expect(sha256Hex(bytes)).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  }
  expect(sha256Hex(new TextEncoder().encode("abc")))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
