import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftLaunchStatus } from "./DraftLaunchStatus";

/* Issue #266: a structured (pane-less) spawn has no tmux window or target, so
   every lifecycle line drops the tmux wording and the {target} reference. The
   legacy variants keep the pane-and-target copy (covered in the sibling
   DraftLaunchStatus.render.test.tsx). */

test("a structured spawn drops the tmux window/target wording across every phase (#266)", () => {
  const booting = renderToStaticMarkup(<DraftLaunchStatus phase="booting" target="sess:1.0" structured />);
  expect(booting).not.toContain("tmux");
  expect(booting).not.toContain("sess:1.0");
  expect(booting).toContain("waiting for the conversation");

  const slow = renderToStaticMarkup(<DraftLaunchStatus phase="booting-slow" target="sess:1.0" structured />);
  expect(slow).toContain("Taking a while");
  expect(slow).not.toContain("tmux");
  expect(slow).not.toContain("sess:1.0");

  const confirming = renderToStaticMarkup(<DraftLaunchStatus phase="confirming" target="sess:2.0" structured />);
  expect(confirming).toContain("send again");
  expect(confirming).not.toContain("tmux");
  expect(confirming).not.toContain("sess:2.0");

  const attention = renderToStaticMarkup(<DraftLaunchStatus phase="attention" target="sess:3.0" structured />);
  expect(attention).toContain('aria-live="assertive"');
  expect(attention).toContain("launch it again");
  expect(attention).not.toContain("tmux");
  expect(attention).not.toContain("sess:3.0");
});

test("a structured launch failure still surfaces the teaching error verbatim (#266)", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus
    phase="attention"
    target=""
    structured
    error="This account needs re-login. Open Accounts, sign in, and retry."
  />);
  expect(html).toContain("needs re-login");
  expect(html).not.toContain("launch it again");
  expect(html).not.toContain("tmux");
});
