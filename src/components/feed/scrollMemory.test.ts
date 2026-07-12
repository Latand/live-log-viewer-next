import { expect, test } from "bun:test";

import { BoundedLru } from "./scrollMemory";

test("the scroll-memory boundary evicts one least-recently-used reader", () => {
  const memory = new BoundedLru<number>(300);
  memory.set("active-reader", 0);
  for (let index = 1; index < 300; index += 1) memory.set(`reader-${index}`, index);

  expect(memory.get("active-reader")).toBe(0);
  memory.set("reader-300", 300);

  expect(memory.size).toBe(300);
  expect(memory.get("active-reader")).toBe(0);
  expect(memory.get("reader-1")).toBeUndefined();
  expect(memory.get("reader-299")).toBe(299);
  expect(memory.get("reader-300")).toBe(300);
});
