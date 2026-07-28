import { afterEach, expect, test } from "bun:test";

import {
  adoptOperatorCredentialFromPaste,
  hasOperatorCredential,
  operatorCredential,
  resetOperatorCredentialForTests,
  subscribeOperatorCredential,
} from "./operatorCredential";

/**
 * The in-app way in (stage blocker): a tab opened by plain navigation adopts the
 * operator credential from a pasted link. The parsing must take the shapes an
 * operator will actually paste — the whole printed link, the fragment, the bare
 * value — and refuse shapes that are clearly a mistake, without ever being the
 * judge of the value itself (the server is).
 */

afterEach(() => {
  resetOperatorCredentialForTests();
});

test("adopts the whole printed operator link", () => {
  expect(adoptOperatorCredentialFromPaste("http://127.0.0.1:8899/#llv-operator=abc123XYZ_-")).toBe(true);
  expect(operatorCredential()).toBe("abc123XYZ_-");
  expect(hasOperatorCredential()).toBe(true);
});

test("adopts a link whose fragment carries more than the credential", () => {
  expect(adoptOperatorCredentialFromPaste("http://127.0.0.1:8899/#p=proj&llv-operator=k3y&x=1")).toBe(true);
  expect(operatorCredential()).toBe("k3y");
});

test("adopts a URL-encoded credential decoded", () => {
  expect(adoptOperatorCredentialFromPaste("#llv-operator=a%2Bb")).toBe(true);
  expect(operatorCredential()).toBe("a+b");
});

test("adopts a bare key, trimmed", () => {
  expect(adoptOperatorCredentialFromPaste("  yQ4T9v0dK  ")).toBe(true);
  expect(operatorCredential()).toBe("yQ4T9v0dK");
});

test("refuses empty input and prose, and adopts nothing", () => {
  expect(adoptOperatorCredentialFromPaste("   ")).toBe(false);
  expect(adoptOperatorCredentialFromPaste("please unlock voice for me")).toBe(false);
  expect(hasOperatorCredential()).toBe(false);
});

test("a successful paste notifies subscribers, so the gate stands down live", () => {
  let notified = 0;
  const release = subscribeOperatorCredential(() => { notified += 1; });
  adoptOperatorCredentialFromPaste("nope with spaces");
  expect(notified).toBe(0);
  adoptOperatorCredentialFromPaste("#llv-operator=fresh");
  expect(notified).toBe(1);
  release();
});
