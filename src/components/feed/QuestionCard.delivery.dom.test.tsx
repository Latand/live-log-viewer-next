import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

import { QuestionCard, deliveryErrorKey } from "./QuestionCard";

/* Issue #697: a rejected answer used to stay visually checked while the card's
   own strip still read "waiting for a reply", and the server's exception text
   was rendered as the operator's error copy. */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

/* The exact 409 body the audit captured: untranslated driver text, ending on a
   colon because the pane screen was empty. */
const RAW_SERVER_ERROR = "screen does not match this question: ";

function questionFile(): FileEntry {
  return {
    path: "/sessions/q.jsonl",
    root: "claude-projects",
    name: "q.jsonl",
    project: "demo",
    title: "Question",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 4_242,
    model: null,
    waitingInput: null,
    pendingQuestion: {
      kind: "question",
      toolUseId: "tool-1",
      transcriptPath: "/sessions/q.jsonl",
      pid: 4_242,
      paneTarget: "%1",
      askedAt: "2026-07-26T00:00:00.000Z",
      questions: [
        {
          question: "Which transport?",
          header: "Transport",
          multiSelect: false,
          options: [
            { label: "Structured", description: "pane-less", recommended: true },
            { label: "Terminal", description: "tmux pane" },
          ],
        },
      ],
    },
  } as unknown as FileEntry;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

test("delivery errors map to translated copy by status, never the server string", () => {
  expect(deliveryErrorKey(409)).toBe("question.errorMoved");
  expect(deliveryErrorKey(409, { noPane: true })).toBe("question.noPane");
  expect(deliveryErrorKey(403)).toBe("question.errorNotRunning");
  expect(deliveryErrorKey(502)).toBe("question.errorUnconfirmed");
  expect(deliveryErrorKey(500)).toBe("common.serverUnavailable");
  expect(deliveryErrorKey(400)).toBe("question.errorRejected");
  expect(deliveryErrorKey(418)).toBe("common.failedSend");
});

test("a rejected answer clears the selection, hides the raw error and offers a retry", async () => {
  let posts = 0;
  globalThis.fetch = mock(async () => {
    posts += 1;
    return new Response(JSON.stringify({ error: RAW_SERVER_ERROR }), { status: 409 });
  }) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<QuestionCard file={questionFile()} />); });

  const option = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Structured"));
  expect(option).toBeTruthy();
  flushSync(() => { option!.click(); });
  await settle();

  expect(posts).toBe(1);
  /* The option no longer asserts an acceptance that never happened. */
  expect(option!.textContent).not.toContain("✓");
  expect(option!.className).not.toContain("bg-accent/10");
  /* The card still says the agent is waiting — and now that is true. */
  expect(host.textContent).toContain(en["question.waiting"]);
  /* Translated copy at the boundary; the driver's own sentence never renders. */
  expect(host.textContent).toContain(en["question.deliveryFailed"]);
  expect(host.textContent).toContain(en["question.errorMoved"]);
  expect(host.textContent).not.toContain(RAW_SERVER_ERROR);
  expect(host.textContent).not.toContain("screen does not match");

  /* An explicit, labelled recovery — re-tapping the option worked before, but
     nothing said so and the ✓ said the opposite. */
  const retry = [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(en["question.retryAnswer"]));
  expect(retry).toBeTruthy();
  flushSync(() => { retry!.click(); });
  await settle();
  expect(posts).toBe(2);

  flushSync(() => { root.unmount(); });
  host.remove();
});
