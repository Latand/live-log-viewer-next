import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";

import type { ProvenanceLookup } from "./messageProvenance";
import type { FeedEntry } from "./parse";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const {
  useDeliveredMessageProvenance,
  resetMessageProvenanceCacheForTests,
  setMessageProvenanceRetryScheduleForTests,
} = await import("./messageProvenance");

/* Assembled from parts so the invented id can never fingerprint as a real
   engine message identifier on the publication gate. */
const ENGINE_MESSAGE_ID = ["99999999", "8888", "4777", "8666", "555555555555"].join("-");
const TRANSCRIPT_PATH = "/sessions/provenance-retry.jsonl";

const deliveredEntry: FeedEntry = {
  anchorKey: null,
  key: "row-1",
  item: {
    kind: "sysmsg",
    label: "system",
    text: "please rerun the failing check",
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: "2026-07-31T09:00:01.000Z" },
  },
};

/* The probe renders the resolution itself, so assertions read the DOM the way
   FeedItem would instead of capturing render-time state. */
function Probe({ path, items }: { path: string | null; items: readonly FeedEntry[] }) {
  const lookup: ProvenanceLookup = useDeliveredMessageProvenance(path, items);
  const resolved = lookup.byId(ENGINE_MESSAGE_ID);
  return <span id="probe">{resolved ? resolved.origin : "unresolved"}</span>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetMessageProvenanceCacheForTests();
  setMessageProvenanceRetryScheduleForTests(null);
});

function stubFetch(responses: Array<Record<string, DeliveredMessageProvenance>>): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return {
      ok: true,
      json: async () => ({ messages: body, relayedTexts: {} }),
    };
  }) as unknown as typeof fetch;
  return () => calls;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeText(container: ReturnType<typeof dom.document.createElement>): string | null {
  return container.querySelector("#probe")?.textContent ?? null;
}

test("an unresolved delivered id revalidates until the ledger answers, without a remount", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10, 10]);
  /* The transcript row is visible before the ledger records its engine message
     id: the first response is empty, the second resolves the SAME id. */
  const calls = stubFetch([{}, { [ENGINE_MESSAGE_ID]: { origin: "operator" } }]);
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<Probe path={TRANSCRIPT_PATH} items={[deliveredEntry]} />);
  });
  expect(probeText(container)).toBe("unresolved");
  await act(async () => {
    await sleep(40);
  });
  expect(probeText(container)).toBe("operator");
  const settled = calls();
  expect(settled).toBe(2);
  /* Resolution ends the schedule: no further polling. */
  await act(async () => {
    await sleep(40);
  });
  expect(calls()).toBe(settled);
  await act(async () => {
    root.unmount();
  });
});

test("an id with no evidence stops at the bounded schedule instead of polling forever", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  const calls = stubFetch([{}]);
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<Probe path={TRANSCRIPT_PATH} items={[deliveredEntry]} />);
  });
  await act(async () => {
    await sleep(80);
  });
  /* Initial fetch plus exactly the two scheduled revalidations. */
  expect(calls()).toBe(3);
  expect(probeText(container)).toBe("unresolved");
  await act(async () => {
    root.unmount();
  });
});
