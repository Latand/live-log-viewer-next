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
  expect(deliveryErrorKey(500)).toBe("common.serverUnavailable");
  expect(deliveryErrorKey(400)).toBe("question.errorRejected");
  expect(deliveryErrorKey(418)).toBe("common.failedSend");
});

/* Review finding 3: 502 is two different events. The driver throws BEFORE the
   submit (it never reached the option, or the screen never advanced), so
   nothing was answered; the route's own 502 fires AFTER Enter, with only the
   transcript's confirmation missing. Mapping both to "the answer was sent"
   asserted a delivery that usually did not happen — and contradicted the card's
   own handling of the same event. */
test("the two 502 paths produce individually true copy", () => {
  expect(deliveryErrorKey(502, { delivered: true })).toBe("question.errorUnconfirmed");
  expect(deliveryErrorKey(502, { delivered: false })).toBe("question.errorNotDelivered");
  /* An older server that sends no flag must not claim a delivery either. */
  expect(deliveryErrorKey(502)).toBe("question.errorNotDelivered");

  expect(en["question.errorUnconfirmed"]).toContain("sent");
  expect(en["question.errorNotDelivered"]).toContain("not delivered");
});

test("the answer route marks which 502 it is", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const route = fs.readFileSync(path.join(import.meta.dir, "../../app/api/answer/route.ts"), "utf8");
  /* Post-send: Enter was pressed, only confirmation is missing. */
  expect(route).toMatch(/answer was sent, but the transcript did not confirm it[^\n]*delivered: true/);
  /* Driver throw: the submit never completed. */
  expect(route).toMatch(/error instanceof DeliveryError[^\n]*delivered: false/);
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
  expect(option!.getAttribute("data-choice-state")).toBe("failed");
  /* The card still says the agent is waiting — and now that is true. */
  expect(host.textContent).toContain(en["question.waiting"]);
  /* Translated copy at the boundary; the driver's own sentence never renders. */
  expect(host.textContent).toContain(en["question.deliveryFailed"]);
  expect(host.textContent).toContain(en["question.errorMoved"]);
  expect(host.querySelector('[role="alert"] .text-danger')).not.toBeNull();
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


/* Review finding 5: the first fix cleared `answers` outright, which threw away
   work the failure never invalidated — a multi-question form is several
   decisions, and only a verbatim retry could recover them. */
test("a rejected submit keeps the picks on screen, visibly failed and still editable", async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ error: RAW_SERVER_ERROR }), { status: 409 })) as unknown as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<QuestionCard file={questionFile()} />); });

  const optionOf = (label: string) =>
    [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(label))!;

  flushSync(() => { optionOf("Terminal").click(); });
  await settle();

  /* Still there, still the operator's choice — but wearing the failure. */
  const failed = optionOf("Terminal");
  expect(failed.getAttribute("data-choice-state")).toBe("failed");
  expect(failed.className).toContain("border-danger/45");
  expect(failed.textContent).toContain(en["question.failedChoice"]);
  expect(failed.textContent).not.toContain("✓");
  expect(failed.hasAttribute("disabled")).toBe(false);

  /* Editing moves on from the failure rather than being blocked by it. */
  flushSync(() => { optionOf("Structured").click(); });
  await settle();
  expect(optionOf("Terminal").getAttribute("data-choice-state")).toBeNull();

  flushSync(() => { root.unmount(); });
  host.remove();
});
