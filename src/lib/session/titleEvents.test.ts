import { expect, test } from "bun:test";

import { titleUpdateEvents } from "./titleEvents";

test("publishes an identity-based set signal and a files bump, without title text", () => {
  const events = titleUpdateEvents("conversation:conversation_abc", false, 7);
  expect(events).toHaveLength(2);

  const [title, files] = events;
  expect(title.kind).toBe("title.updated");
  expect(title.payload).toEqual({ identity: "conversation:conversation_abc", cleared: false });
  // The operational journal never carries the user's title text.
  expect(JSON.stringify(title.payload)).not.toContain("title");

  expect(files.kind).toBe("files.revision");
  // Monotonic bump other devices react to by refetching /api/files.
  expect(files.payload).toEqual({ filesRevision: 8 });
});

test("marks a clear so remote views drop the override", () => {
  const [title] = titleUpdateEvents("uuid:codex:abc", true, 0);
  expect(title.payload).toEqual({ identity: "uuid:codex:abc", cleared: true });
});
