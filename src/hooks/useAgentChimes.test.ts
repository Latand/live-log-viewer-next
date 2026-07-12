import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { MAX_TRACKED_IDENTITIES, planAgentChimes, planScopedAgentChimes, type TrackedConversation } from "./useAgentChimes";

/* Deterministic fixtures: `waitingInput` forces paneState "waiting" without
   touching the wall clock; `activity: "live"` forces "live"; everything else
   idles into "done". */
function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: over.path,
    project: "proj",
    worktree: null,
    title: null,
    engine: "claude",
    kind: "conversation",
    fmt: "jsonl",
    parent: null,
    mtime: 1_700_000_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...over,
  } as FileEntry;
}

const live = (path: string, over: Partial<FileEntry> = {}) => entry({ path, activity: "live", ...over });
const waiting = (path: string, over: Partial<FileEntry> = {}) => entry({ path, waitingInput: { reason: "turn done" } as unknown as FileEntry["waitingInput"], ...over });

test("first poll seeds the baseline silently", () => {
  const plan = planAgentChimes([waiting("/a"), live("/b")], null, new Set());
  expect(plan.chimes).toEqual([]);
  expect([...plan.tracked.keys()].sort()).toEqual(["/a", "/b"]);
});

test("live → waiting rings once, then stays silent", () => {
  const seed = planAgentChimes([live("/a")], null, new Set());
  const rung = planAgentChimes([waiting("/a")], seed.tracked, seed.linked);
  expect(rung.chimes.map((chimePlan) => chimePlan.kind)).toEqual(["question"]);
  const again = planAgentChimes([waiting("/a")], rung.tracked, rung.linked);
  expect(again.chimes).toEqual([]);
});

test("an identity that churns out of the capped feed and returns does not re-ring", () => {
  const seed = planAgentChimes([live("/a"), waiting("/b")], null, new Set());
  /* /b falls out of the recency cap for one poll… */
  const middle = planAgentChimes([live("/a")], seed.tracked, seed.linked);
  expect(middle.chimes).toEqual([]);
  /* …and its baseline survives the absence: the return is not a new agent. */
  expect(middle.tracked.has("/b")).toBe(true);
  const back = planAgentChimes([live("/a"), waiting("/b")], middle.tracked, middle.linked);
  expect(back.chimes).toEqual([]);
});

test("a genuinely new conversation that appears already finished rings", () => {
  const seed = planAgentChimes([live("/a")], null, new Set());
  const plan = planAgentChimes([live("/a"), waiting("/new")], seed.tracked, seed.linked);
  expect(plan.chimes).toEqual([{ kind: "question", id: "/new" }]);
});

test("project hydration seeds unseen finished conversations without queuing a chime cascade", () => {
  const seed = planScopedAgentChimes([live("/project-a")], null, "/api/files?project=project-a");
  const hydrated = Array.from({ length: 464 }, (_, index) => waiting(`/project-b-${index}`));
  const switched = planScopedAgentChimes(hydrated, seed, "/api/files?project=project-b");
  expect(switched.chimes).toEqual([]);

  const settled = planScopedAgentChimes(hydrated, switched, "/api/files?project=project-b");
  expect(settled.chimes).toEqual([]);
  const newQuestion = planScopedAgentChimes([...hydrated, waiting("/project-b-new")], settled, "/api/files?project=project-b");
  expect(newQuestion.chimes).toEqual([{ kind: "question", id: "/project-b-new" }]);
});

test("project hydration keeps a known live to waiting transition audible", () => {
  const seed = planScopedAgentChimes([live("/shared")], null, "/api/files?project=project-a");
  const switched = planScopedAgentChimes(
    [waiting("/shared"), waiting("/already-finished")],
    seed,
    "/api/files?project=project-b",
  );
  expect(switched.chimes).toEqual([{ kind: "question", id: "/shared" }]);
});

test("archived migration predecessors neither ring nor clobber the successor's state", () => {
  const successor = live("/gen2", { conversationId: "conversation_x" });
  const predecessor = waiting("/gen1", { conversationId: "conversation_x", migratedTo: "/gen2" });
  const seed = planAgentChimes([successor, predecessor], null, new Set());
  /* Only the successor generation is tracked, under the stable identity. */
  expect([...seed.tracked.keys()]).toEqual(["conversation_x"]);
  expect(seed.tracked.get("conversation_x")?.state).toBe("live");
  /* The predecessor re-listing on a later poll stays silent. */
  const plan = planAgentChimes([successor, predecessor], seed.tracked, seed.linked);
  expect(plan.chimes).toEqual([]);
});

test("a child joining the tree blips spawned once, even across feed churn", () => {
  const seed = planAgentChimes([live("/parent")], null, new Set());
  const spawn = planAgentChimes([live("/parent"), live("/child", { parent: "/parent" })], seed.tracked, seed.linked);
  expect(spawn.chimes).toEqual([{ kind: "spawned", id: "/child" }]);
  /* The child churns out of the feed and returns: no second blip. */
  const middle = planAgentChimes([live("/parent")], spawn.tracked, spawn.linked);
  const back = planAgentChimes([live("/parent"), live("/child", { parent: "/parent" })], middle.tracked, middle.linked);
  expect(back.chimes).toEqual([]);
});

test("a subagent that lived its whole life between polls rings only the finish chime", () => {
  const prev = new Map<string, TrackedConversation>([["/parent", { state: "live", kind: undefined, parent: null }]]);
  const plan = planAgentChimes([live("/parent"), waiting("/child", { parent: "/parent" })], prev, new Set());
  expect(plan.chimes).toEqual([{ kind: "question", id: "/child" }]);
});

test("tracked history stores transition fields only", () => {
  const plan = planAgentChimes([waiting("/a", { parent: "/p" })], null, new Set());
  expect(plan.tracked.get("/a")).toEqual({ state: "waiting", kind: "question", parent: "/p" });
});

test("tracked history is bounded: oldest absent identities evict first", () => {
  const prev = new Map<string, TrackedConversation>();
  for (let index = 0; index < MAX_TRACKED_IDENTITIES + 10; index += 1) {
    prev.set(`/old-${index}`, { state: "done", kind: undefined, parent: null });
  }
  const linked = new Set(["/old-0", "/old-1"]);
  const plan = planAgentChimes([live("/current")], prev, linked);
  expect(plan.tracked.size).toBe(MAX_TRACKED_IDENTITIES);
  /* The current poll survives; the earliest-known absentees are gone, and the
     linked set never references an evicted identity. */
  expect(plan.tracked.has("/current")).toBe(true);
  expect(plan.tracked.has("/old-0")).toBe(false);
  expect(plan.linked.has("/old-0")).toBe(false);
  expect(plan.tracked.has(`/old-${MAX_TRACKED_IDENTITIES + 9}`)).toBe(true);
});

test("a current feed larger than the cap stays bounded on every return path", () => {
  const files = Array.from({ length: MAX_TRACKED_IDENTITIES + 1 }, (_, index) => live(`/f-${index}`));
  const seed = planAgentChimes(files, null, new Set());
  expect(seed.tracked.size).toBe(MAX_TRACKED_IDENTITIES);
  /* The mtime-descending head survives; the overflow tail is the one dropped. */
  expect(seed.tracked.has("/f-0")).toBe(true);
  expect(seed.tracked.has(`/f-${MAX_TRACKED_IDENTITIES}`)).toBe(false);
  const again = planAgentChimes(files, seed.tracked, seed.linked);
  expect(again.tracked.size).toBe(MAX_TRACKED_IDENTITIES);
});

test("full-cap tail churn: a recently seen identity survives eviction and stays silent on return", () => {
  /* Fill the cap: C is a waiting conversation observed from the start,
     alongside MAX-1 ancient identities never seen again. */
  const seed = planAgentChimes(
    [waiting("/C"), ...Array.from({ length: MAX_TRACKED_IDENTITIES - 1 }, (_, index) => live(`/ancient-${index}`))],
    null,
    new Set(),
  );
  /* C is refreshed by this poll (LRU moves it to the tail); ten fresh
     identities push the map over the cap, evicting ancients. */
  const p2 = planAgentChimes(
    [waiting("/C"), ...Array.from({ length: 10 }, (_, index) => live(`/fresh-${index}`))],
    seed.tracked,
    seed.linked,
  );
  /* C skips exactly one poll while a new identity forces another eviction.
     First-seen ordering would evict C here; recency ordering must not. */
  const p3 = planAgentChimes(
    [...Array.from({ length: 10 }, (_, index) => live(`/fresh-${index}`)), waiting("/B")],
    p2.tracked,
    p2.linked,
  );
  expect(p3.tracked.size).toBe(MAX_TRACKED_IDENTITIES);
  expect(p3.tracked.has("/C")).toBe(true);
  /* C returns in its unchanged waiting state: remembered, so no phantom chime. */
  const p4 = planAgentChimes(
    [...Array.from({ length: 10 }, (_, index) => live(`/fresh-${index}`)), waiting("/C")],
    p3.tracked,
    p3.linked,
  );
  expect(p4.chimes).toEqual([]);
});
