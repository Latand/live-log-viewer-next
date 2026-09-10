import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
import { useConversationControl } from "./useConversationControl";

const dom = new Window();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; document.body.replaceChildren(); });
function Control({ action = "kill" }: { action?: "kill" | "interrupt" }) {
  const control = useConversationControl({ conversationId: "conversation_selected", path: "/selected.jsonl" }, action);
  return <><button disabled={control.busy} onClick={() => void control.run()}>Act</button><output>{control.outcome}:{control.error}</output></>;
}
async function mount(action: "kill" | "interrupt" = "kill") {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Control action={action} />));
  return { host, root };
}
const tick = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
for (const [action, terminal, outcome] of [["interrupt", "interrupted", "done"], ["kill", "delivered", "done"], ["kill", "failed", "failed"]] as const) {
  test(`${action} waits for its original receipt to become ${terminal}`, async () => {
    let operationId = ""; let posts = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        const body = JSON.parse(String(init.body)); operationId = body.operationId;
        expect(body).toMatchObject({ conversationId: "conversation_selected", path: "/selected.jsonl", action });
        return Response.json({ ok: true, receipt: { operationId, status: "queued" } }, { status: 202 });
      }
      return Response.json({ receipt: { operationId, conversationId: "conversation_selected", kind: action, status: terminal, error: terminal === "failed" ? "host refused" : undefined } });
    }) as typeof fetch;
    const { host, root } = await mount(action);
    try {
      await act(async () => host.querySelector("button")!.click());
      expect(host.textContent).toContain("pending:");
      expect(host.querySelector("button")!.disabled).toBe(true);
      await tick();
      expect(host.textContent).toContain(`${outcome}:`);
      expect(host.querySelector("button")!.disabled).toBe(false);
      expect(posts).toBe(1);
    } finally { await act(async () => root.unmount()); }
  });
}
test("an unrelated receipt never reports success or resends the control", async () => {
  let operationId = ""; let posts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") { posts++; operationId = JSON.parse(String(init.body)).operationId; throw new Error("lost reply"); }
    return Response.json({ receipt: { operationId, conversationId: "conversation_other", kind: "kill", status: "delivered" } });
  }) as typeof fetch;
  const { host, root } = await mount();
  try {
    await act(async () => host.querySelector("button")!.click());
    await tick();
    expect(host.textContent).toContain("unknown:");
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(posts).toBe(1);
  } finally { await act(async () => root.unmount()); }
});
test("an immediate legacy refusal stays visible and permits a deliberate new gesture", async () => {
  globalThis.fetch = (async () => Response.json({ ok: false, error: "host identity changed" }, { status: 409 })) as unknown as typeof fetch;
  const { host, root } = await mount();
  try {
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("failed:host identity changed");
    expect(host.querySelector("button")!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
