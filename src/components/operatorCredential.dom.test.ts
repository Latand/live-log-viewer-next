import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import * as operatorCredentialModule from "./operatorCredential";
import { purgeLegacyOperatorCredential } from "./operatorCredential";

/**
 * THE CEREMONY IS GONE, AND ITS LEAVINGS ARE ERASED.
 *
 * Rounds 7–9 of #691 built an operator bearer: printed at startup, pasted into a
 * gate, held in one volatile slot, lost on reload. The operator rejected it on
 * stage — it broke one-click manager and one-click voice, which is what the
 * product is for — so nothing in the browser holds, stores or presents a
 * credential any more (see `operatorAuthority`: same-origin IS the operator).
 *
 * Two things are asserted. That no credential API exists to come back through,
 * written against the module's whole surface so a future round cannot reintroduce
 * one under a new name. And that a profile which ran an earlier round has its
 * leavings removed — a bearer in web storage, a key in a bookmarked fragment (and
 * so in Chromium's on-disk History database).
 */

const dom = new Window({ url: "http://127.0.0.1:8898/" });
Object.assign(globalThis, { window: dom, document: dom.document });

const LEGACY_STORAGE_KEY = "llv.operator.capability";
const KEY = "zx8Kq2-operator-key-value_09";

/** Everything the profile would carry to disk, as one list. */
function persisted(): { where: string; key: string; value: string }[] {
  const out: { where: string; key: string; value: string }[] = [];
  for (const [where, store] of [["sessionStorage", dom.sessionStorage], ["localStorage", dom.localStorage]] as const) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null) continue;
      out.push({ where, key, value: store.getItem(key) ?? "" });
    }
  }
  return out;
}

afterEach(() => {
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.history.replaceState(null, "", "/");
});

test("no credential mechanism exists in the browser at all — the eraser is the whole module", () => {
  expect(Object.keys(operatorCredentialModule).sort()).toEqual(["purgeLegacyOperatorCredential"]);
  /* Named individually too, so reintroducing any one of them fails here rather
     than quietly widening the surface. */
  for (const banned of [
    "adoptOperatorCredential",
    "forgetOperatorCredential",
    "hasOperatorCredential",
    "operatorCredential",
    "operatorHeaders",
    "subscribeOperatorCredential",
  ]) {
    expect(operatorCredentialModule).not.toHaveProperty(banned);
  }
});

test("a bearer left in the profile by round 8 is deleted", () => {
  dom.sessionStorage.setItem(LEGACY_STORAGE_KEY, KEY);
  dom.localStorage.setItem(LEGACY_STORAGE_KEY, KEY);

  purgeLegacyOperatorCredential();

  /* Deleted, because removing the mechanism while its bearer still sits in the
     profile would leave the value exactly where the review found it. */
  expect(persisted()).toEqual([]);
});

test("a stale round-7 startup link is scrubbed from the address bar", () => {
  dom.history.replaceState(null, "", `/?project=alpha#llv-operator=${encodeURIComponent(KEY)}&tab=board`);

  purgeLegacyOperatorCredential();

  expect(dom.location.href).not.toContain(KEY);
  expect(dom.location.hash).toBe("#tab=board");
  /* The query string is the caller's, not ours, and survives untouched. */
  expect(dom.location.search).toBe("?project=alpha");
});

test("purging is idempotent and leaves an ordinary fragment alone", () => {
  dom.history.replaceState(null, "", "/#tab=board");
  purgeLegacyOperatorCredential();
  purgeLegacyOperatorCredential();
  expect(dom.location.hash).toBe("#tab=board");
});
