import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { DeviceAttentionOffer } from "@/lib/attention/service";
import { expiryFrom } from "@/lib/attention/machine";
import type { AttentionRequestV1 } from "@/lib/attention/types";
import { digestChips } from "@/lib/overlay/digest";
import { ARRANGEMENT_THRESHOLD, PIP_DEFAULT_SIZE } from "@/lib/overlay/layout";
import type { OverlayTurn } from "@/lib/overlay/timeline";
import { translate } from "@/lib/i18n";

import { RootOverlay, type RootOverlayProps } from "./RootOverlay";

/*
 * #691 — the one overlay component, and the #688 decisions it makes visible.
 *
 * The point of these tests is that the SAME component renders every surface, so
 * the arrangement is a fact about the measured size rather than a mode anybody
 * sets, and the consent contract is answerable wherever it is rendered.
 */

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const root of roots) flushSync(() => root.unmount()); roots = []; await settle(); });

const t = ((key: string, vars?: Record<string, string | number>) => translate("en", key as "overlay.title", vars)) as RootOverlayProps["t"];

const turns: OverlayTurn[] = [
  { id: "t1", role: "user", text: "What happened with the login fix?", at: "2026-07-01T10:00:00.000Z" },
  { id: "t2", role: "agent", text: "The reviewer finished.", at: "2026-07-01T10:00:10.000Z" },
  { id: "t3", role: "agent", text: "Verdict is request-changes.", at: "2026-07-01T10:00:20.000Z" },
  { id: "t4", role: "agent", text: "Want to look?", at: "2026-07-01T10:00:30.000Z" },
];

function request(overrides: Partial<AttentionRequestV1> = {}): AttentionRequestV1 {
  const created = new Date("2026-07-01T10:00:00.000Z");
  return {
    id: "attention_1",
    createdAt: created.toISOString(),
    requestedBy: { rootId: "root_fixed" },
    origin: "root-agent",
    target: { kind: "conversation", path: "/tmp/reviewer.jsonl" },
    frameAtCreation: { project: "demo", rect: { x: 0, y: 0, w: 600, h: 780 }, boardRevision: 4 },
    intent: "show",
    zoom: "situate",
    reason: "The reviewer finished with request-changes.",
    state: "offered",
    stateChangedAt: created.toISOString(),
    expiresAt: expiryFrom(created),
    offeredTo: ["device-a"],
    returnPoints: [],
    revision: 1,
    ...overrides,
  };
}

const offer = (overrides: Partial<DeviceAttentionOffer> = {}): DeviceAttentionOffer => ({
  request: request(),
  status: "actionable",
  returnAvailable: false,
  ...overrides,
});

interface Answers {
  accepted: string[];
  previewed: string[];
  declined: string[];
  dismissed: string[];
  returned: string[];
}

function mount(props: Partial<RootOverlayProps> = {}): Answers {
  const answers: Answers = { accepted: [], previewed: [], declined: [], dismissed: [], returned: [] };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(
    <RootOverlay
      surface="dock"
      height={PIP_DEFAULT_SIZE.height}
      state="idle"
      turns={turns}
      onAcceptAttention={(entry) => answers.accepted.push(entry.id)}
      onPreviewAttention={(entry) => answers.previewed.push(entry.id)}
      onDeclineAttention={(entry) => answers.declined.push(entry.id)}
      onDismissAttention={(entry) => answers.dismissed.push(entry.id)}
      onReturnAttention={(entry) => answers.returned.push(entry.id)}
      t={t}
      {...props}
    />,
  ));
  roots.push(root);
  return answers;
}

const one = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const all = (selector: string) => [...dom.document.querySelectorAll(selector)] as unknown as HTMLElement[];
const click = (element: HTMLElement) => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

test("the arrangement is decided by measured height, with no mode control to find", () => {
  mount({ height: PIP_DEFAULT_SIZE.height });
  expect(one("[data-testid='root-overlay']")!.getAttribute("data-arrangement")).toBe("compact");
  /* Resizing the window IS the expand gesture. */
  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ height: ARRANGEMENT_THRESHOLD });
  expect(one("[data-testid='root-overlay']")!.getAttribute("data-arrangement")).toBe("expanded");
});

test("the window and the dock are the same component in a different container", () => {
  mount({ surface: "window", height: PIP_DEFAULT_SIZE.height });
  const windowMarkup = one("[data-testid='root-overlay']")!.innerHTML;
  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  dom.document.body.replaceChildren();

  mount({ surface: "dock", height: PIP_DEFAULT_SIZE.height });
  const dockMarkup = one("[data-testid='root-overlay']")!.innerHTML;

  /* Only the label on the one control that crosses the boundary differs. */
  expect(dockMarkup.replace(/Pop out into its own window/g, "Dock back into the page"))
    .toBe(windowMarkup.replace(/Pop out into its own window/g, "Dock back into the page"));
});

test("the action row does not exist until something needs an answer", () => {
  mount();
  expect(one("[data-testid='overlay-action-row']")).toBeNull();

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ attention: offer() });
  expect(one("[data-testid='overlay-action-row']")).not.toBeNull();
});

test("the operator hears which of show or open they are agreeing to, before agreeing", () => {
  mount({ attention: offer() });
  expect(one("[data-testid='attention-intent']")!.textContent).toBe("It will bring it into view.");
  expect(one("[data-testid='attention-accept']")!.textContent).toBe("Take me there");

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ attention: offer({ request: request({ intent: "open" }) }) });
  expect(one("[data-testid='attention-intent']")!.textContent).toBe("It will open it.");
  expect(one("[data-testid='attention-accept']")!.textContent).toBe("Open it");
});

test("accept, preview and decline each answer the request they are showing", () => {
  const answers = mount({ attention: offer() });

  click(one("[data-testid='attention-preview']")!);
  click(one("[data-testid='attention-decline']")!);
  click(one("[data-testid='attention-accept']")!);

  expect(answers).toEqual({
    accepted: ["attention_1"],
    previewed: ["attention_1"],
    declined: ["attention_1"],
    dismissed: [],
    returned: [],
  });
});

test("closing a preview refuses after looking, which is not the same event as declining unseen", () => {
  const answers = mount({
    attention: offer({ request: request({ state: "previewing" }) }),
    attentionPreview: { title: "Reviewer", project: "demo", detail: null },
  });

  /* `decline` is refused from `previewing` by the machine, so a close wired to
     it would be a dead control and the request would run to its TTL — recorded
     as silence rather than as the refusal it was. */
  expect(one("[data-testid='attention-decline']")).toBeNull();
  click(one("[data-testid='attention-preview-close']")!);

  expect(answers.dismissed).toEqual(["attention_1"]);
  expect(answers.declined).toEqual([]);
});

test("an answer the record refused is said on the surface that sent it", () => {
  mount({ attention: offer(), attentionRefused: true });
  expect(one("[data-testid='attention-refused']")!.textContent).toContain("did not go through");

  /* And the band stays open for the message even once the offer it belonged to
     has gone terminal — that is the case the operator most needs told about. */
  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  dom.document.body.replaceChildren();
  mount({ attention: null, attentionRefused: true });
  expect(one("[data-testid='overlay-action-row']")).not.toBeNull();
  expect(one("[data-testid='attention-refused']")).not.toBeNull();
});

test("a refusal can be got rid of, and a handoff with nowhere to go says that instead", () => {
  const dismissals: number[] = [];
  mount({
    attention: null,
    attentionRefused: true,
    attentionRefusedReason: "lost-target",
    onDismissAttentionRefusal: () => dismissals.push(1),
  });

  /* Nothing was refused — there was simply nowhere to take them — and saying
     "that did not go through" would describe the wrong thing. */
  expect(one("[data-testid='attention-refused']")!.textContent).toContain("nowhere to take you");
  click(one("[data-testid='attention-refused-dismiss']")!);
  expect(dismissals).toEqual([1]);
});

test("a preview shows a text card and never moves the view", () => {
  mount({
    attention: offer({ request: request({ state: "previewing" }) }),
    attentionPreview: { title: "Reviewer", project: "demo", detail: "Finished, request-changes." },
  });

  expect(one("[data-testid='attention-preview-card']")!.textContent).toContain("Reviewer");
  /* Previewing is a state the agent can observe, so the offer stays answerable
     rather than collapsing into silence. */
  expect(one("[data-testid='attention-accept']")).not.toBeNull();
  expect(one("[data-testid='attention-preview']")).toBeNull();
});

test("a degraded destination says so on the card", () => {
  mount({ attention: offer({ request: request({ resolution: "approximate" }) }) });

  expect(one("[data-testid='attention-approximate']")!.textContent).toContain("this is where it was");
});

test("while following, the return control is offered and then collapses to a line", () => {
  const answers = mount({
    attention: offer({ request: request({ state: "following", acknowledgedBy: "device-a" }), status: "following", returnAvailable: true }),
  });
  expect(one("[data-testid='attention-return']")!.textContent).toBe("Back to where you were");
  click(one("[data-testid='attention-return']")!);
  expect(answers.returned).toEqual(["attention_1"]);

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ attention: offer({ request: request({ state: "following", acknowledgedBy: "device-a" }), status: "following", returnAvailable: false }) });
  /* Past its window it still restores the same point when tapped. */
  expect(one("[data-testid='attention-return']")!.textContent).toBe("Go back to where you were");
});

test("a device that did not accept sees a note, not a stale card", () => {
  mount({ attention: offer({ status: "withdrawn" }) });

  expect(one("[data-testid='attention-withdrawn']")!.textContent).toBe("Followed on another device");
  expect(one("[data-testid='attention-accept']")).toBeNull();
});

test("standing consent is visible where it applies and revocable from there", () => {
  mount({ autoFollow: { scope: "project", label: "this project" } });

  expect(one("[data-testid='attention-auto-follow']")!.textContent).toContain("Auto-follow is on");
  expect(one("[data-testid='attention-auto-follow-revoke']")).not.toBeNull();
});

test("compact holds one chip plus a counter; expanded shows them all inline", () => {
  const chips = digestChips([
    { eventId: "e1", kind: "stage-started", summary: "Stage started.", at: "2026-07-01T10:00:05.000Z" },
    { eventId: "e2", kind: "stage-started", summary: "Another stage started.", at: "2026-07-01T10:00:12.000Z" },
    { eventId: "e3", kind: "review-verdict", summary: "Review: request-changes.", at: "2026-07-01T10:00:25.000Z" },
  ]);

  mount({ chips, height: PIP_DEFAULT_SIZE.height });
  expect(all("[data-testid='overlay-chip']")).toHaveLength(1);
  expect(one("[data-testid='overlay-chip-counter']")!.textContent).toBe("+2 updates");

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ chips, height: 560 });
  expect(all("[data-testid='overlay-chip']")).toHaveLength(3);
  expect(one("[data-testid='overlay-chip-counter']")).toBeNull();
});

test("a chip carries the journal's line and taps as an operator command", () => {
  const commanded: string[] = [];
  mount({
    chips: digestChips([{ eventId: "e1", kind: "review-verdict", summary: "Review: request-changes.", at: "2026-07-01T10:00:25.000Z" }]),
    onChipCommand: (chip) => commanded.push(chip.eventId),
  });

  const chip = one("[data-testid='overlay-chip']")!;
  expect(chip.textContent).toBe("Review: request-changes.");
  expect(chip.getAttribute("data-class")).toBe("prompt");
  click(chip);
  expect(commanded).toEqual(["e1"]);
});

test("a rollover shows the continuity marker in compact as well as expanded", () => {
  const opened: string[] = [];
  const continuity = { previousConversationId: "conversation_a", at: "2026-07-01T09:00:00.000Z" };

  for (const height of [PIP_DEFAULT_SIZE.height, 560]) {
    mount({ continuity, height, onOpenPreviousSession: (id) => opened.push(id) });
    const marker = one("[data-testid='overlay-continuity']")!;
    expect(marker.textContent).toBe("Continued from earlier");
    click(marker);
    flushSync(() => roots.at(-1)!.unmount());
    roots.pop();
    dom.document.body.replaceChildren();
  }

  /* Reachable from both, because a rollover is exactly when the operator needs
     to know why the agent's memory looks shorter than expected. */
  expect(opened).toEqual(["conversation_a", "conversation_a"]);
});

test("scrolled back, the overlay offers a way to the latest rather than jumping there", () => {
  const followed: number[] = [];
  mount({ atTail: false, lastSeenTurnId: "t2", onFollowLatest: () => followed.push(1) });

  const chip = one("[data-testid='overlay-new-turns']")!;
  expect(chip.textContent).toBe("2 new");
  click(chip);
  expect(followed).toHaveLength(1);
});

test("turns clamp harder in compact than expanded, and a partial never adds a row", () => {
  mount({ height: PIP_DEFAULT_SIZE.height });
  expect(all("[data-testid='overlay-turn']")[0]!.getAttribute("data-clamp")).toBe("3");

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  const settling: OverlayTurn[] = [...turns, { id: "t5", role: "user", text: "show me", at: "2026-07-01T10:00:40.000Z", partial: true }];
  mount({ height: 560, turns: settling });
  const rendered = all("[data-testid='overlay-turn']");
  expect(rendered).toHaveLength(5);
  expect(rendered.at(-1)!.getAttribute("data-partial")).toBe("true");
  expect(rendered[0]!.getAttribute("data-clamp")).toBe("6");
});

test("the state word is always beside the dot, and reduced motion drops only the motion", () => {
  mount({ state: "speaking", reducedMotion: true });

  expect(one("[data-testid='overlay-state']")!.textContent).toBe("Speaking");
  const identity = one("[data-testid='overlay-identity']")!;
  expect(identity.getAttribute("data-motion")).toBe("static");
  expect(identity.getAttribute("data-state")).toBe("speaking");
  /* The information survives; only the animated halo goes. */
  expect(identity.textContent).toBe("Speaking");
});

test("stop, permission and Computer Use appear only when they are true", () => {
  mount();
  expect(one("[data-testid='overlay-stop']")).toBeNull();
  expect(one("[data-testid='overlay-computer-use']")).toBeNull();

  flushSync(() => roots.at(-1)!.unmount());
  roots.pop();
  mount({ onStop: () => {}, computerUse: true });
  /* A row of permanently inert indicators is how a calm surface becomes a
     status board, so each one is conditional. */
  expect(one("[data-testid='overlay-stop']")).not.toBeNull();
  expect(one("[data-testid='overlay-computer-use']")).not.toBeNull();
});

test("the overlay offers no way to change which conversation it is bound to", () => {
  mount({ attention: offer(), chips: digestChips([{ eventId: "e1", kind: "progress", summary: "Working.", at: "2026-07-01T10:00:05.000Z" }]) });

  /* D1: it is permanently bound to the root and never follows the focused
     worker. Everything omitted here exists in the Viewer already, and each one
     is how this window would quietly become a small second Viewer. */
  const text = one("[data-testid='root-overlay']")!.textContent ?? "";
  for (const forbidden of ["Projects", "Board", "Settings", "Switch conversation"]) {
    expect(text).not.toContain(forbidden);
  }
  expect(all("select")).toHaveLength(0);
});
