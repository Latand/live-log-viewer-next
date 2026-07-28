"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

import { useLocale } from "@/lib/i18n";

import {
  adoptOperatorCredential,
  hasOperatorCredential,
  purgeLegacyOperatorCredential,
  subscribeOperatorCredential,
} from "./operatorCredential";

/**
 * How the operator key gets into the tab (#691 round 9).
 *
 * The key cannot arrive over HTTP (the page is fetched anonymously over loopback), and
 * it cannot arrive in a link (Chromium writes the committed URL, fragment included, to
 * the History database on disk). Both of those are readable by a worker running as the
 * operator's uid, which is every worker. What is left is the operator's own hands: the
 * server prints the key to the terminal it was launched from, and it is pasted here.
 *
 * The paste is the whole security argument — it is the one step in this feature a local
 * process cannot perform for itself — so the affordance stays deliberately dull: no
 * autofill name, no persistence, `type="password"` so a screen share or a screenshot
 * does not spend it. Reading without a key is the honest resting state: the Viewer
 * shows everything, and only designation and voice transport controls stand down.
 *
 * UNCONTROLLED on purpose. A controlled input would put the key in React state, which
 * means the fiber tree, the update queue, and every dev-tools snapshot of them — more
 * copies of the one value this feature is trying to keep to a single heap slot. The DOM
 * node holds it for the moment between paste and submit, and is cleared immediately
 * after.
 *
 * Rendered collapsed, because the operator pastes at most once per page load and every
 * other visitor to this surface is just reading.
 */
export function OperatorKeyGate() {
  const { t } = useLocale();
  const authorized = useSyncExternalStore(
    subscribeOperatorCredential,
    hasOperatorCredential,
    /* Server render has no credential and no way to get one; matching that on the
       first client render is what keeps hydration quiet. */
    () => false,
  );
  const field = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(false);

  const close = useCallback(() => {
    if (field.current) field.current.value = "";
    setRefused(false);
    setOpen(false);
  }, []);

  const submit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    if (!adoptOperatorCredential(field.current?.value ?? "")) {
      setRefused(true);
      return;
    }
    /* Out of the DOM the moment it is adopted: the node's value is one more place the
       key would otherwise sit for the life of the tab. */
    close();
  }, [close]);

  /* The key is adopted for the life of the tab, so once it is in there is nothing left
     to ask for and nothing worth showing. */
  if (authorized) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="fixed bottom-3 right-3 z-40 rounded-md border border-neutral-700/60 bg-neutral-900/80 px-2 py-1 text-xs text-neutral-400 backdrop-blur transition-colors hover:text-neutral-100"
        onClick={() => { purgeLegacyOperatorCredential(); setOpen(true); }}
      >
        {t("operator.keyPrompt")}
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="fixed bottom-3 right-3 z-40 flex max-w-[min(28rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-md border border-neutral-700/60 bg-neutral-900/95 p-3 text-xs text-neutral-300 shadow-lg backdrop-blur"
    >
      <label className="flex flex-col gap-1">
        <span>{t("operator.keyPrompt")}</span>
        <input
          ref={field}
          type="password"
          autoComplete="off"
          autoFocus
          spellCheck={false}
          onChange={() => setRefused(false)}
          className="w-72 max-w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-neutral-100 outline-none focus:border-neutral-500"
        />
      </label>
      <p className="text-neutral-500">{t("operator.keyHint")}</p>
      {refused ? <p className="text-amber-400">{t("operator.keyRefused")}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className="rounded border border-neutral-600 px-2 py-1 hover:bg-neutral-800">
          {t("operator.keyApply")}
        </button>
        <button
          type="button"
          onClick={close}
          className="rounded border border-transparent px-2 py-1 text-neutral-500 hover:text-neutral-200"
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
