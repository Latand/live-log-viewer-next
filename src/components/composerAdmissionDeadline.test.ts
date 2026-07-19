import { expect, test } from "bun:test";

import { ComposerAdmissionTimeoutError, withComposerAdmissionDeadline } from "./composerAdmissionDeadline";

test("a request without an admission response releases the composer deadline", async () => {
  const neverSettles = new Promise<Response>(() => {});

  await expect(withComposerAdmissionDeadline(neverSettles, 5))
    .rejects.toBeInstanceOf(ComposerAdmissionTimeoutError);
});

test("a durable admission response wins before the deadline", async () => {
  const response = { ok: true, status: 202 } as Response;

  await expect(withComposerAdmissionDeadline(Promise.resolve(response), 50))
    .resolves.toBe(response);
});
