import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import { setLocale, translate } from "@/lib/i18n";

import { PipelineTemplatePicker } from "./PipelineTemplatePicker";
import type { PipelineClientResult, PipelineTemplate } from "./pipelineModel";

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const realFetch = globalThis.fetch;
const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  localStorage.clear();
  globalThis.fetch = realFetch;
  setLocale("en");
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
}

const pipeline = { id: "pipeline-1" } as Pipeline;

test("checks the selected directory before enabling templates and stays mounted through creation", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" }));
  }) as unknown as typeof fetch;
  const created: Array<{ template: PipelineTemplate | null; repoDir: string }> = [];
  let completed: Pipeline | null = null;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/alias/repo"
      onCreate={async (template, repoDir) => {
        created.push({ template, repoDir });
        return { pipeline };
      }}
      onCreated={(value) => { completed = value; }}
      onClose={() => undefined}
    />,
  );

  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Plan → Build → Review"))!;
  expect(template.disabled).toBe(true);
  expect(host.textContent).toContain("Checking repository");
  await settle();

  expect(requests).toEqual(["/api/pipelines/preflight"]);
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("/canonical/repo");
  expect(template.disabled).toBe(false);
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("builder");
  expect(host.textContent).toContain("⟳ reviewer");

  flushSync(() => template.click());
  expect(host.querySelector("[data-pipeline-picker-state]")?.getAttribute("data-pipeline-picker-state")).toBe("creating");
  await settle();
  expect(created).toEqual([{ template: expect.objectContaining({ id: "planBuildReview" }), repoDir: "/canonical/repo" }]);
  expect(Boolean(completed)).toBe(true);
  expect((completed as Pipeline | null)?.id).toBe(pipeline.id);
});

test("an empty repository directory mounts blocked with a focused input and no phantom spinner", async () => {
  const requests: string[] = [];
  const resolvers = new Map<string, (response: Response) => void>();
  globalThis.fetch = ((_: string, init?: RequestInit) => {
    const repoDir = JSON.parse(String(init?.body)).repoDir as string;
    requests.push(repoDir);
    return new Promise<Response>((resolve) => resolvers.set(repoDir, resolve));
  }) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker repoDir="" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );

  const picker = host.querySelector("[data-pipeline-picker-state]")!;
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(host.textContent).not.toContain(translate("en", "pipelineTemplates.checking"));
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(translate("en", "pipelinePreflight.empty"));

  const input = host.querySelector("input") as HTMLInputElement;
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(input);
  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Plan → Build → Review"))!;
  expect(template.disabled).toBe(true);

  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(requests).toEqual([]);

  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("en", "pipelineTemplates.retry")))!;
  flushSync(() => retry.click());
  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(requests).toEqual([]);

  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "/repo");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("checking");
  await settle();
  expect(host.querySelector(".animate-spin")).not.toBeNull();
  expect(requests).toEqual(["/repo"]);
  resolvers.get("/repo")!(new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" })));
  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("ready");
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(template.disabled).toBe(false);
});

test("mount-empty and typed-empty share the same Ukrainian copy", async () => {
  setLocale("uk");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  const emptyHost = mount(
    <PipelineTemplatePicker repoDir="" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  const mountedCopy = emptyHost.querySelector('[role="alert"]')?.textContent;
  expect(mountedCopy).toContain(translate("uk", "pipelinePreflight.empty"));

  const typedHost = mount(
    <PipelineTemplatePicker repoDir="/repo" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();
  const input = typedHost.querySelector("input") as HTMLInputElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle();
  expect(typedHost.querySelector('[role="alert"]')?.textContent).toBe(mountedCopy);
});

test("keeps a localized inline admission error and retries the current directory", async () => {
  setLocale("uk");
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ error: "directory does not exist: /missing", code: "missing", field: "repoDir", path: "/missing" }), { status: 400 })
      : new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }));
  }) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker repoDir="/missing" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(translate("uk", "pipelinePreflight.missing", { path: "/missing" }));
  expect(alert?.textContent).not.toContain("directory does not exist");
  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.buildReview")))!;
  expect(template.disabled).toBe(true);

  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.retry")))!;
  flushSync(() => retry.click());
  await settle();
  expect(attempts).toBe(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(template.disabled).toBe(false);
});

test("localizes a coded create-time revalidation failure", async () => {
  setLocale("uk");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/repo"
      onCreate={async () => ({
        code: "git_metadata_unwritable",
        field: "repoDir",
        path: "/repo/.git",
        error: "Git metadata is not writable: /repo/.git",
      })}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await settle();

  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.blank")))!;
  flushSync(() => blank.click());
  await settle();

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(translate("uk", "pipelinePreflight.git_metadata_unwritable", { path: "/repo/.git" }));
  expect(alert?.textContent).not.toContain("Git metadata is not writable");
});

test("a stale preflight response cannot replace a newer edited directory", async () => {
  const resolvers = new Map<string, (response: Response) => void>();
  globalThis.fetch = ((_: string, init?: RequestInit) => {
    const repoDir = JSON.parse(String(init?.body)).repoDir as string;
    return new Promise<Response>((resolve) => resolvers.set(repoDir, resolve));
  }) as unknown as typeof fetch;
  let created: PipelineClientResult | null = null;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/slow"
      onCreate={async (_template, repoDir) => { created = { path: repoDir }; return {}; }}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await Promise.resolve();
  const input = host.querySelector("input") as HTMLInputElement;
  flushSync(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "/fast");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle();

  resolvers.get("/fast")!(new Response(JSON.stringify({ ok: true, repoDir: "/canonical/fast", gitCommonDir: "/canonical/fast/.git", worktreeParent: "/canonical" })));
  await settle();
  resolvers.get("/slow")!(new Response(JSON.stringify({ error: "not git", code: "not_git", field: "repoDir", path: "/slow" }), { status: 400 }));
  await settle();

  expect(input.value).toBe("/canonical/fast");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Blank canvas"))!;
  flushSync(() => blank.click());
  await settle();
  expect(JSON.stringify(created)).toBe(JSON.stringify({ path: "/canonical/fast" }));
});

test("Escape and the close button both close while the picker is idle", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  let closed = 0;
  const host = mount(
    <PipelineTemplatePicker repoDir="/repo" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => { closed += 1; }} />,
  );
  await settle();
  const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
  flushSync(() => close.click());
  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event));
  expect(closed).toBe(2);
});
