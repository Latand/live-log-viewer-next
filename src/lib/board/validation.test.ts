import { expect, test } from "bun:test";

import { MAX_BOARD_BODY_BYTES, validateBoardPatchRequest } from "./validation";

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/board", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the body cap admits the worst-case validator-legal mutation under maximal JSON escaping", async () => {
  /* Control characters serialize to six bytes each ("\u0007"): two full
     512-path lists of 4095-char control-heavy paths ≈ 25.2 MB — the largest
     mutation the item validators accept must never be size-refused. */
  const path = (prefix: string, index: number) => `/${prefix}-${String(index).padStart(4, "0")}${"\u0007".repeat(4080)}`;
  const roots = Array.from({ length: 512 }, (_, index) => path("r", index));
  const removeManual = Array.from({ length: 512 }, (_, index) => path("m", index));
  const body = {
    schemaVersion: 1,
    project: "proj",
    baseRevision: 0,
    mutations: [{ kind: "reconcile-roots", roots, removeManual }],
  };
  const serialized = new TextEncoder().encode(JSON.stringify(body)).length;
  expect(serialized).toBeGreaterThan(25 * 1000 * 1000);
  expect(serialized).toBeLessThanOrEqual(MAX_BOARD_BODY_BYTES);
  const parsed = await validateBoardPatchRequest(patchRequest(body));
  expect(parsed.mutations).toHaveLength(1);
});

test("the body cap admits the maximal validator-legal legacy-seed patch", async () => {
  /* The whole-preferences patch form carries three 512-path lists
     (manual/hidden/expanded); under maximal escaping that is ~37.7 MB and it
     must clear the cap so the one-time legacy seed survives on arrangements
     of any legal size. */
  const path = (prefix: string, index: number) => `/${prefix}-${String(index).padStart(4, "0")}${"\u0007".repeat(4080)}`;
  const list = (prefix: string) => Array.from({ length: 512 }, (_, index) => path(prefix, index));
  const body = {
    schemaVersion: 1,
    project: "proj",
    baseRevision: 0,
    patch: { manual: list("a"), hidden: list("b"), expanded: list("c") },
  };
  const serialized = new TextEncoder().encode(JSON.stringify(body)).length;
  expect(serialized).toBeGreaterThan(37 * 1000 * 1000);
  expect(serialized).toBeLessThanOrEqual(MAX_BOARD_BODY_BYTES);
  const parsed = await validateBoardPatchRequest(patchRequest(body));
  expect(parsed.patch?.manual).toHaveLength(512);
});
