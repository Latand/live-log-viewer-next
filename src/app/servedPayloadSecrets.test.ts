import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";

import { ensureOperatorSpawnCapability, operatorSpawnCapabilityPath } from "@/lib/agent/operatorCapability";

import Home from "./page";

/**
 * Nothing a local process can FETCH may carry the operator capability.
 *
 * This is the test that was missing when the credential shipped inside the page. The
 * page is served anonymously over loopback, so anything able to issue a GET could read
 * it and become the operator — an unforgeable credential handed out for free.
 *
 * Rendered rather than requested over HTTP so the assertion runs without a server, and
 * because what matters is the PAYLOAD: whatever the server render produces is what an
 * anonymous fetch receives.
 */

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-served-payload-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

test("an anonymously fetched page carries no capability material", () => {
  /* A real capability exists on disk, exactly as in production — the point is that it
     does not travel. */
  const capability = ensureOperatorSpawnCapability();
  expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const markup = renderToStaticMarkup(Home());

  /* The secret itself. */
  expect(markup).not.toContain(capability);
  /* And nothing else of that shape, so a regenerated or differently-derived value
     cannot slip through under a different name. */
  expect(markup).not.toMatch(/[A-Za-z0-9_-]{43}/);
  /* Nor the words that would accompany it, which is how a well-meaning prop gets
     added back. */
  for (const word of ["capability", "Capability", "operatorCredential", "llv-operator"]) {
    expect(markup).not.toContain(word);
  }
});

test("the page renders the same payload whether or not a capability exists on disk", () => {
  /* If the two differed, the difference would be the leak. */
  const withoutCapability = renderToStaticMarkup(Home());
  ensureOperatorSpawnCapability();
  const withCapability = renderToStaticMarkup(Home());
  expect(withCapability).toBe(withoutCapability);
});

test("the capability file stays private on disk", () => {
  ensureOperatorSpawnCapability();
  const mode = fs.statSync(operatorSpawnCapabilityPath()).mode & 0o777;
  expect(mode).toBe(0o600);
});
