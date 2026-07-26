import { expect, test } from "bun:test";

import { forgetReturnProject, readReturnProject, rememberReturnProject } from "./returnProjectMemory";

/*
 * The per-device half of a return point (#688 D8).
 *
 * The record cannot hold this: return points are per-device, and a project
 * written into the shared record by the device that accepted would be read by
 * every other device's restore. A component ref cannot hold it either — the
 * device id is in localStorage and therefore shared by every tab, so a reload
 * or a second tab renders the same return control with the memory gone.
 */

/** localStorage, near enough: the same three methods, and a throwing variant
    for the private-mode case. */
function storage(initial: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get length() { return Object.keys(data).length; },
    clear() { for (const key of Object.keys(data)) delete data[key]; },
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value; },
    removeItem: (key: string) => { delete data[key]; },
    key: (index: number) => Object.keys(data)[index] ?? null,
  } as Storage & { data: Record<string, string> };
}

test("what one tab remembers, the next one reads — that is the whole point of it being durable", () => {
  const shared = storage();

  rememberReturnProject(shared, "device-a", "attention_1", "demo");

  expect(readReturnProject(shared, "device-a", "attention_1")).toBe("demo");
});

test("the memory is per device, so one device's capture never steers another's restore", () => {
  const shared = storage();
  rememberReturnProject(shared, "device-a", "attention_1", "demo");

  expect(readReturnProject(shared, "device-b", "attention_1")).toBeNull();
});

test("an unknown request reads as nothing remembered, which is what refuses a foreign camera", () => {
  const shared = storage();

  expect(readReturnProject(shared, "device-a", "attention_1")).toBeNull();
  expect(readReturnProject(null, "device-a", "attention_1")).toBeNull();
  expect(readReturnProject(shared, null, "attention_1")).toBeNull();
});

test("a return forgets its own entry and leaves the others alone", () => {
  const shared = storage();
  rememberReturnProject(shared, "device-a", "attention_1", "demo");
  rememberReturnProject(shared, "device-a", "attention_2", "other");

  forgetReturnProject(shared, "device-a", "attention_1");

  expect(readReturnProject(shared, "device-a", "attention_1")).toBeNull();
  expect(readReturnProject(shared, "device-a", "attention_2")).toBe("other");
});

test("the memory is bounded, and it is the oldest entries that fall away", () => {
  const shared = storage();
  for (let index = 0; index < 12; index += 1) {
    rememberReturnProject(shared, "device-a", `attention_${index}`, `project_${index}`);
  }

  expect(readReturnProject(shared, "device-a", "attention_0")).toBeNull();
  expect(readReturnProject(shared, "device-a", "attention_11")).toBe("project_11");
});

test("a mode with no camera is remembered as its project all the same", () => {
  /* The overview has no project and no camera. Remembering that is a different
     fact from never having captured anything, but both restore the same way —
     what matters is that neither invents a project to restore a camera into. */
  const shared = storage();
  rememberReturnProject(shared, "device-a", "attention_1", null);

  expect(readReturnProject(shared, "device-a", "attention_1")).toBeNull();
});

test("unreadable storage is an empty memory rather than a thrown return", () => {
  const broken = {
    getItem: () => "{not json",
    setItem: () => { throw new Error("quota"); },
    removeItem: () => {},
  } as unknown as Storage;

  expect(readReturnProject(broken, "device-a", "attention_1")).toBeNull();
  /* Private mode refuses the write; the return still happens, it just cannot
     restore a camera afterwards. */
  expect(() => rememberReturnProject(broken, "device-a", "attention_1", "demo")).not.toThrow();
  expect(() => forgetReturnProject(broken, "device-a", "attention_1")).not.toThrow();
});
