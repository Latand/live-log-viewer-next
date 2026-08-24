import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { DeliveredMessageOccurrence, DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import type { ProvenanceLookup } from "./messageProvenance";
import type { FeedEntry, Item } from "./parse";

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
const TEXT = "please rerun the failing check";

const deliveredEntry: FeedEntry = {
  anchorKey: null,
  key: "row-1",
  item: {
    kind: "sysmsg",
    label: "system",
    text: TEXT,
    deliveredMessage: { engineMessageId: ENGINE_MESSAGE_ID, ts: "2026-07-31T09:00:01.000Z" },
  },
};

/* The probe renders the resolution itself, so assertions read the DOM the way
   FeedItem would instead of capturing render-time state. */
function Probe({ path, items, probe }: { path: string | null; items: readonly FeedEntry[]; probe: Item }) {
  const lookup: ProvenanceLookup = useDeliveredMessageProvenance(path, items);
  const resolved = lookup.forItem(probe);
  return <span id="probe">{resolved ? resolved.origin : "unresolved"}</span>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetMessageProvenanceCacheForTests();
  setMessageProvenanceRetryScheduleForTests(null);
});

interface Response {
  messages?: Record<string, DeliveredMessageProvenance>;
  occurrences?: DeliveredMessageOccurrence[];
}

function stubFetch(responses: Response[]): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const body = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return {
      ok: true,
      json: async () => ({ messages: body.messages ?? {}, occurrences: body.occurrences ?? [] }),
    };
  }) as unknown as typeof fetch;
  return () => calls;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeText(container: ReturnType<typeof dom.document.createElement>): string | null {
  return container.querySelector("#probe")?.textContent ?? null;
}

async function mount(items: readonly FeedEntry[], probe: Item) {
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(<Probe path={TRANSCRIPT_PATH} items={items} probe={probe} />);
  });
  return {
    text: () => probeText(container),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

test("an unresolved delivered id revalidates until the ledger answers, without a remount", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10, 10]);
  /* The transcript row is visible before the ledger records its engine message
     id: the first response is empty, the second resolves the SAME id. */
  const calls = stubFetch([{}, { messages: { [ENGINE_MESSAGE_ID]: { origin: "operator" } } }]);
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  expect(probe.text()).toBe("unresolved");
  await act(async () => {
    await sleep(40);
  });
  expect(probe.text()).toBe("operator");
  const settled = calls();
  expect(settled).toBe(2);
  /* Resolution ends the schedule: no further polling. */
  await act(async () => {
    await sleep(40);
  });
  expect(calls()).toBe(settled);
  await probe.unmount();
});

test("an id with no evidence stops at the bounded schedule instead of polling forever", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10]);
  const calls = stubFetch([{}]);
  const probe = await mount([deliveredEntry], deliveredEntry.item);
  await act(async () => {
    await sleep(80);
  });
  /* Initial fetch plus exactly the two scheduled revalidations. */
  expect(calls()).toBe(3);
  expect(probe.text()).toBe("unresolved");
  await probe.unmount();
});

test("a fresh legacy row revalidates until its receipt settles; a historical one fetches once", async () => {
  setMessageProvenanceRetryScheduleForTests([10, 10, 10]);
  /* A legacy paste's row lands before the registry settles the receipt: the
     first response has no occurrence, the second carries the settled one. */
  const now = new Date().toISOString();
  const freshRow: FeedEntry = { anchorKey: null, key: "row-2", item: { kind: "user", ts: now, text: TEXT } };
  const settled: DeliveredMessageOccurrence = {
    textDigest: messageTextDigest(TEXT),
    deliveredAt: now,
    origin: "agent",
    senderRole: "orchestrator",
  };
  const calls = stubFetch([{}, { occurrences: [settled] }]);
  const probe = await mount([freshRow], freshRow.item);
  expect(probe.text()).toBe("unresolved");
  await act(async () => {
    await sleep(40);
  });
  expect(probe.text()).toBe("agent");
  expect(calls()).toBe(2);
  await probe.unmount();

  resetMessageProvenanceCacheForTests();
  const historicalRow: FeedEntry = {
    anchorKey: null,
    key: "row-3",
    item: { kind: "user", ts: "2026-01-01T00:00:00.000Z", text: TEXT },
  };
  const historicalCalls = stubFetch([{}]);
  const historical = await mount([historicalRow], historicalRow.item);
  await act(async () => {
    await sleep(80);
  });
  /* Settled absence: one fetch, no revalidation. */
  expect(historicalCalls()).toBe(1);
  expect(historical.text()).toBe("unresolved");
  await historical.unmount();
});
