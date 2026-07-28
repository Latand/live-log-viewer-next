import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BRIDGE_CONFIRMATION_TTL_MS,
  consumeBridgeConfirmation,
  mintBridgeConfirmation,
  verifyBridgeConfirmation,
} from "./confirmation";
import { appendBridgeReports, openBridgeChannel, readBridgeReportLog } from "./store";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-confirm-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const MINTED_AT = new Date("2026-07-27T12:00:00.000Z");

test("minting requires a full 40-hex SHA and stamps a bounded expiry", () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  expect(confirmation.sha).toBe(SHA);
  expect(confirmation.nonce).toMatch(/^[0-9a-f]{32}$/);
  expect(Date.parse(confirmation.expiresAt) - MINTED_AT.getTime()).toBe(BRIDGE_CONFIRMATION_TTL_MS);

  expect(() => mintBridgeConfirmation({ sha: SHA.slice(0, 12), now: MINTED_AT })).toThrow(/40-hex/);
  expect(() => mintBridgeConfirmation({ sha: SHA.toUpperCase(), now: MINTED_AT })).toThrow(/40-hex/);
});

test("two mints for the same SHA never share a nonce", () => {
  const first = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const second = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  expect(first.nonce).not.toBe(second.nonce);
});

test("verification accepts only the exact nonce and SHA, inside the window", () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const inWindow = new Date(MINTED_AT.getTime() + 60_000);

  expect(verifyBridgeConfirmation(confirmation, { sha: SHA, nonce: confirmation.nonce }, inWindow))
    .toEqual({ ok: true });
  expect(verifyBridgeConfirmation(confirmation, { sha: OTHER_SHA, nonce: confirmation.nonce }, inWindow))
    .toEqual({ ok: false, reason: "sha_mismatch" });
  expect(verifyBridgeConfirmation(confirmation, { sha: SHA, nonce: "wrong" }, inWindow))
    .toEqual({ ok: false, reason: "nonce_mismatch" });
});

test("a SHA that differs only in case is a mismatch, not a match", () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const answer = { sha: SHA.toUpperCase(), nonce: confirmation.nonce };
  expect(verifyBridgeConfirmation(confirmation, answer, MINTED_AT))
    .toEqual({ ok: false, reason: "sha_mismatch" });
});

test("expiry is checked at execution time, not at answer time", () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const late = new Date(MINTED_AT.getTime() + BRIDGE_CONFIRMATION_TTL_MS + 1);
  expect(verifyBridgeConfirmation(confirmation, { sha: SHA, nonce: confirmation.nonce }, late))
    .toEqual({ ok: false, reason: "expired" });
});

test("an already-consumed confirmation cannot authorize a second deploy", () => {
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const consumed = { ...confirmation, consumedAt: MINTED_AT.toISOString() };
  expect(verifyBridgeConfirmation(consumed, { sha: SHA, nonce: confirmation.nonce }, MINTED_AT))
    .toEqual({ ok: false, reason: "consumed" });
});

test("consuming through the log is atomic: one yes authorizes one SHA once (§7.7)", () => {
  sandbox();
  openBridgeChannel("root_abc");
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const { appended } = appendBridgeReports([{
    key: "confirm-deploy-726",
    class: "confirmation_request",
    at: MINTED_AT.toISOString(),
    body: "gates green; deploy?",
    confirmation,
  }]);
  const seq = appended[0]!.seq;
  const answeredAt = new Date(MINTED_AT.getTime() + 30_000);

  const first = consumeBridgeConfirmation(seq, { sha: SHA, nonce: confirmation.nonce }, answeredAt);
  expect(first).toEqual({ ok: true, sha: SHA });

  const replay = consumeBridgeConfirmation(seq, { sha: SHA, nonce: confirmation.nonce }, answeredAt);
  expect(replay).toEqual({ ok: false, reason: "consumed" });

  const stored = readBridgeReportLog().reports.find((report) => report.seq === seq);
  expect(stored?.confirmation?.consumedAt).toBe(answeredAt.toISOString());
});

test("consuming refuses a seq that is not a confirmation request", () => {
  sandbox();
  openBridgeChannel("root_abc");
  const { appended } = appendBridgeReports([{
    key: "plain-status",
    class: "status",
    at: MINTED_AT.toISOString(),
    body: "working",
  }]);

  expect(consumeBridgeConfirmation(appended[0]!.seq, { sha: SHA, nonce: "x" }, MINTED_AT))
    .toEqual({ ok: false, reason: "no_confirmation" });
  expect(consumeBridgeConfirmation(9999, { sha: SHA, nonce: "x" }, MINTED_AT))
    .toEqual({ ok: false, reason: "no_confirmation" });
});

test("an expired request leaves no consumption mark, so the record shows it never authorized anything", () => {
  sandbox();
  openBridgeChannel("root_abc");
  const confirmation = mintBridgeConfirmation({ sha: SHA, now: MINTED_AT });
  const { appended } = appendBridgeReports([{
    key: "confirm-expired",
    class: "confirmation_request",
    at: MINTED_AT.toISOString(),
    confirmation,
  }]);
  const late = new Date(MINTED_AT.getTime() + BRIDGE_CONFIRMATION_TTL_MS + 1_000);

  expect(consumeBridgeConfirmation(appended[0]!.seq, { sha: SHA, nonce: confirmation.nonce }, late))
    .toEqual({ ok: false, reason: "expired" });
  const stored = readBridgeReportLog().reports.find((report) => report.seq === appended[0]!.seq);
  expect(stored?.confirmation?.consumedAt).toBeUndefined();
});
