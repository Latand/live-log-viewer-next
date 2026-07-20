/**
 * Issue #499 — the pill must never clobber the persisted runtime selection.
 *
 * On a fresh pane load the runtime plane resolves in steps (bus disabled →
 * unresolved → structured), so the pill can mount, unmount, and remount while
 * the stored draft is the only carrier of the user's selection. The old
 * persist-on-render effect wrote the CURRENT liveDraft — the synthesized
 * defaults on the mount commit — before the load effect's corrective state
 * landed, so a mount/unmount cycle across the resolution steps silently
 * reverted the selection the user made earlier. The invariant: mounting the
 * pill (any surface) performs NO localStorage write of the draft key — only an
 * explicit selection commit (or an error rollback) writes it.
 */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

afterEach(() => {
  setLocale("en");
  document.body.replaceChildren();
  localStorage.clear();
});

const file: FileEntry = {
  path: "/codex-pill.jsonl", root: "codex-sessions", name: "codex-pill.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "live", proc: "running", pid: null, conversationId: "conv-pill-persist",
  model: "gpt-5.6-sol", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
} as FileEntry;

const DRAFT_KEY = "llvAgentRuntime:conv-pill-persist";
const SELECTED = { model: "gpt-5.6-sol", effort: "xhigh", fast: true };

test.each(["live-root", "structured"] as const)(
  "mounting the pill on %s never rewrites the persisted draft",
  async (surface) => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(SELECTED));
    const writes: string[] = [];
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = ((key: string, value: string) => {
      if (key === DRAFT_KEY) writes.push(value);
      realSetItem(key, value);
    }) as typeof localStorage.setItem;
    try {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => {
        root.render(
          <RuntimePill
            file={file}
            surface={surface}
            runtimeSettings={{ perTurnEffort: true, perTurnModel: false }}
            runtimeSession={null}
          />,
        );
        await new Promise((r) => setTimeout(r, 0));
      });
      /* The face reflects the stored selection… */
      const pill = host.querySelector("[data-runtime-pill]")!;
      expect(pill.getAttribute("aria-label")).toContain("Extra High");
      /* …and the mount itself wrote nothing: an unmount at ANY intermediate
         commit can never revert the selection to synthesized defaults. */
      expect(writes).toEqual([]);
      flushSync(() => root.unmount());
      expect(localStorage.getItem(DRAFT_KEY)).toBe(JSON.stringify(SELECTED));
    } finally {
      localStorage.setItem = realSetItem;
    }
  },
);
