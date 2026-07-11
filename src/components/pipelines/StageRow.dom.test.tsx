import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { RoleConfig } from "@/lib/roles/types";

import { StageRow, type RoleCatalogItem } from "./StageRow";
import type { DraftStage } from "./pipelineModel";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});

function role(id: string, config: RoleConfig): RoleCatalogItem {
  return { id, name: id, description: "", config, parameters: [], capabilities: ["read-write"], promptScaffold: "", safetyFences: [], promptPreview: "" } as unknown as RoleCatalogItem;
}
const CATALOG: RoleCatalogItem[] = [role("architect", { engine: "claude", model: "fable", effort: "high" })];
const DEFAULT_RUNTIME: RoleConfig = { engine: "codex", model: "gpt-5.6-sol", effort: "high" };
const baseStage: DraftStage = { key: "k", kind: "run", roleId: "", engine: "codex", model: "", effort: "", access: "read-write", prompt: "", roleParams: {} };

/* A controlled host so StageRow's onChange updates the stage between interactions. */
function Host({ onStage, index = 0 }: { onStage: (stage: DraftStage) => void; index?: number }) {
  const [stage, setStage] = useState<DraftStage>(baseStage);
  return (
    <StageRow
      index={index}
      total={2}
      stage={stage}
      roles={CATALOG}
      defaultRuntime={DEFAULT_RUNTIME}
      onChange={(next) => { setStage(next); onStage(next); }}
      onRemove={() => {}}
      onMove={() => {}}
    />
  );
}

afterEach(() => document.body.replaceChildren());

test("selecting a role then No role returns the runtime to the pipeline default", () => {
  let latest: DraftStage = baseStage;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<Host onStage={(s) => { latest = s; }} />); });

  const select = host.querySelector("select") as HTMLSelectElement;
  /* Pick Architect → its Claude/Fable runtime autofills. */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ roleId: "architect", engine: "claude", model: "fable", effort: "high" });

  /* Back to No role: engine/model/effort reset to the default and drop Claude/Fable. */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ roleId: "", engine: "codex", model: "", effort: "" });

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("clearing a role's model override shows the role runtime", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<Host onStage={() => {}} />); });

  const summary = () => host.querySelector(".font-mono") as HTMLElement;
  const select = host.querySelector("select") as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(summary().textContent).toContain("fable");

  /* Open the runtime editor and clear the model. The collapsed summary must fall
     back through Architect's own runtime (fable); the Builder default (sol) applies only to role-less rows. */
  const edit = host.querySelector('[aria-label="Edit runtime for stage 1"]') as HTMLElement;
  flushSync(() => { edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const modelInput = host.querySelector('input[aria-label="Model"]') as HTMLInputElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(modelInput, "");
    modelInput.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(summary().textContent).toContain("fable");
  expect(summary().textContent).not.toContain("gpt-5.6-sol");

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("the kind radiogroup follows the ARIA contract: roving tabIndex + arrow keys", () => {
  let latest: DraftStage = baseStage;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  /* index=1 so Review-loop is a valid option. */
  flushSync(() => { root.render(<Host index={1} onStage={(s) => { latest = s; }} />); });

  const group = host.querySelector('[role="radiogroup"]') as HTMLElement;
  const [runBtn, reviewBtn] = Array.from(group.querySelectorAll('[role="radio"]')) as HTMLElement[];
  /* Exactly one option is tabbable (the checked Run), the other is removed from the tab order. */
  expect(runBtn.getAttribute("tabindex")).toBe("0");
  expect(reviewBtn.getAttribute("tabindex")).toBe("-1");

  /* ArrowDown moves selection to Review-loop and the tab stop with it. */
  flushSync(() => { group.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event); });
  expect(latest.kind).toBe("review-loop");
  expect(runBtn.getAttribute("tabindex")).toBe("-1");
  expect(reviewBtn.getAttribute("tabindex")).toBe("0");

  /* ArrowLeft toggles back to Run. */
  flushSync(() => { group.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event); });
  expect(latest.kind).toBe("run");

  flushSync(() => { root.unmount(); });
  host.remove();
});

test("re-selecting a role preserves the operator's pinned runtime override", () => {
  let latest: DraftStage = baseStage;
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  flushSync(() => { root.render(<Host onStage={(s) => { latest = s; }} />); });

  const select = host.querySelector("select") as HTMLSelectElement;
  /* Pick Architect → Claude/Fable/high autofills (no pin yet). */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ engine: "claude", model: "fable" });

  /* Open the runtime editor and pin the effort to low (runtimeOverridden). */
  const edit = host.querySelector('[aria-label="Edit runtime for stage 1"]') as HTMLElement;
  flushSync(() => { edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  const effortSelect = host.querySelector('select[aria-label="Effort"]') as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(effortSelect, "low");
    effortSelect.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ effort: "low", runtimeOverridden: true });

  /* Re-select Architect: the pinned runtime survives (design §1.3). */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(select, "architect");
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(latest).toMatchObject({ roleId: "architect", effort: "low", engine: "claude", runtimeOverridden: true });

  flushSync(() => { root.unmount(); });
  host.remove();
});
