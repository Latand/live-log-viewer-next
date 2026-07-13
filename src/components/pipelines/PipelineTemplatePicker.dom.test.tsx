import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { PipelineTemplatePicker } from "./PipelineTemplatePicker";
import { PIPELINE_TEMPLATES, type PipelineTemplate } from "./pipelineModel";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});

afterEach(() => document.body.replaceChildren());

function mount(node: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(node);
  });
  return { host, root };
}

test("lists every stage-carrying template as a role chain and picks the chosen one", () => {
  let picked: PipelineTemplate | null | undefined;
  const { host, root } = mount(
    <PipelineTemplatePicker busy={false} onPick={(template) => { picked = template; }} onClose={() => {}} />,
  );
  /* Every non-blank template gets a row; the blank path is its own labeled row. */
  const rows = [...host.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label") === null);
  expect(host.textContent).toContain("Plan → Build → Review");
  /* The role chain is previewed on the row — the operator sees the shape before picking. */
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("builder");
  expect(host.textContent).toContain("⟳ reviewer");

  const target = rows.find((button) => button.textContent?.includes("architect"))!;
  flushSync(() => {
    target.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  expect(picked?.id).toBe("planBuildReview");
  expect(PIPELINE_TEMPLATES.some((template) => template.id === picked?.id)).toBe(true);
  flushSync(() => root.unmount());
  host.remove();
});

test("the blank-canvas row picks null (the #136 empty-draft path)", () => {
  let picked: PipelineTemplate | null | undefined = undefined;
  const { host, root } = mount(
    <PipelineTemplatePicker busy={false} onPick={(template) => { picked = template; }} onClose={() => {}} />,
  );
  const blank = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Blank canvas"))!;
  flushSync(() => {
    blank.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  expect(picked).toBeNull();
  flushSync(() => root.unmount());
  host.remove();
});

test("Escape and the close button both close without picking", () => {
  let closed = 0;
  let picked = false;
  const { host, root } = mount(
    <PipelineTemplatePicker busy={false} onPick={() => { picked = true; }} onClose={() => { closed += 1; }} />,
  );
  const close = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label"))!;
  flushSync(() => {
    close.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  flushSync(() => {
    window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
  });
  expect(closed).toBe(2);
  expect(picked).toBe(false);
  flushSync(() => root.unmount());
  host.remove();
});
