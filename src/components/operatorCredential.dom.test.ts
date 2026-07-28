import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

import {
  adoptOperatorCredential,
  forgetOperatorCredential,
  hasOperatorCredential,
  operatorCredential,
  operatorHeaders,
  purgeLegacyOperatorCredential,
  resetOperatorCredentialForTests,
  subscribeOperatorCredential,
} from "./operatorCredential";

/**
 * The operator bearer never reaches anything a same-uid worker can read (#691 round 9).
 *
 * Round 8 put it in `sessionStorage`, which reads as "per-tab, gone when the tab
 * closes" and is in fact a LevelDB directory in the Chromium profile — owned by the
 * operator's uid, and so readable by every agent on the machine, which is the same hole
 * as the capability file two rounds earlier. Round 7 put it in a URL fragment, which
 * never reaches the server but does reach the on-disk History database.
 *
 * So the assertions here are about ABSENCE, and they are deliberately written against
 * the whole store rather than against the key round 8 happened to use: a future round
 * that persists the bearer under some other name has to make these fail.
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
  resetOperatorCredentialForTests();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
  dom.history.replaceState(null, "", "/");
});

test("an adopted credential is held in memory and written to no store at all", () => {
  expect(adoptOperatorCredential(KEY)).toBe(true);

  expect(hasOperatorCredential()).toBe(true);
  expect(operatorCredential()).toBe(KEY);
  expect(operatorHeaders()).toEqual({ [VIEWER_SPAWN_CAPABILITY_HEADER]: KEY });

  /* The round-8 regression, stated as the thing it actually was: something on disk. */
  expect(persisted()).toEqual([]);
});

test("no store anywhere holds the value, under any key", () => {
  adoptOperatorCredential(KEY);
  /* Not "the key we know about is absent" — nothing that could be flushed to the
     profile contains the bearer, whatever it might be called. */
  expect(persisted().some((entry) => entry.value.includes(KEY))).toBe(false);
});

test("the URL never carries it either — a fragment is a row in the History database", () => {
  adoptOperatorCredential(KEY);
  expect(dom.location.href).not.toContain(KEY);
  expect(dom.location.hash).toBe("");
});

test("an empty paste is refused rather than silently adopted", () => {
  expect(adoptOperatorCredential("   ")).toBe(false);
  expect(hasOperatorCredential()).toBe(false);
  expect(operatorHeaders()).toEqual({});
});

test("surrounding whitespace from the terminal copy is trimmed, not presented", () => {
  adoptOperatorCredential(`  ${KEY}\n`);
  expect(operatorCredential()).toBe(KEY);
});

test("subscribers learn when the credential arrives and when the tab drops it", () => {
  const seen: boolean[] = [];
  const release = subscribeOperatorCredential(() => { seen.push(hasOperatorCredential()); });

  adoptOperatorCredential(KEY);
  forgetOperatorCredential();
  /* Already gone: nothing to announce, so no redundant render. */
  forgetOperatorCredential();
  release();
  adoptOperatorCredential(KEY);

  expect(seen).toEqual([true, false]);
});

test("a bearer left in the profile by round 8 is deleted, and never adopted from", () => {
  dom.sessionStorage.setItem(LEGACY_STORAGE_KEY, KEY);
  dom.localStorage.setItem(LEGACY_STORAGE_KEY, KEY);

  purgeLegacyOperatorCredential();

  /* Deleted, because shipping the fix while the hole it closes still sits in the
     profile would leave the credential exactly where the review found it. */
  expect(persisted()).toEqual([]);
  /* And NOT adopted: a value that has been through a file is spent, whoever else has
     already read it. */
  expect(hasOperatorCredential()).toBe(false);
});

test("a stale round-7 startup link is scrubbed from the address bar, and never adopted from", () => {
  dom.history.replaceState(null, "", `/?project=alpha#llv-operator=${encodeURIComponent(KEY)}&tab=board`);

  purgeLegacyOperatorCredential();

  expect(dom.location.href).not.toContain(KEY);
  expect(dom.location.hash).toBe("#tab=board");
  /* The query string is the caller's, not ours, and survives untouched. */
  expect(dom.location.search).toBe("?project=alpha");
  expect(hasOperatorCredential()).toBe(false);
});

test("purging is idempotent and leaves an ordinary fragment alone", () => {
  dom.history.replaceState(null, "", "/#tab=board");
  purgeLegacyOperatorCredential();
  purgeLegacyOperatorCredential();
  expect(dom.location.hash).toBe("#tab=board");
});
