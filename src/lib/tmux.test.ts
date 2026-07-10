import { describe, expect, test } from "bun:test";

import { cdCommandForCwd, tmuxEndpoint } from "@/lib/tmux";

describe("cdCommandForCwd", () => {
  test("quotes paths with spaces for a shell cd command", () => {
    expect(cdCommandForCwd("/home/user/project with spaces")).toBe("cd -- '/home/user/project with spaces'");
  });

  test("escapes single quotes in cwd paths", () => {
    expect(cdCommandForCwd("/home/user/it's here")).toBe("cd -- '/home/user/it'\\''s here'");
  });
});

test("reports the configured tmux endpoint", () => {
  expect(tmuxEndpoint()).toBe(process.env.TMUX_TMPDIR || "/tmp");
});
