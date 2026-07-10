import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftLaunchStatus } from "./DraftLaunchStatus";

test("booting announces politely, names the target, and spins reduced-motion safe", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="booting" target="sess:1.0" />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("sess:1.0");
  expect(html).toContain("animate-spin");
  expect(html).toContain("motion-reduce:animate-none");
});

test("booting-slow adds the check-tmux hint", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="booting-slow" target="sess:1.0" />);
  expect(html).toContain("Taking a while");
  expect(html).toContain("sess:1.0");
});

test("confirming keeps the card frozen with a discourage-resend line (with a target)", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="confirming" target="sess:2.0" />);
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("sess:2.0");
  expect(html).toContain("send again");
});

test("confirming after transport loss (no target) still discourages resend", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="confirming" target="" />);
  expect(html).toContain("send again");
  expect(html).not.toContain("{target}");
});

test("attention is assertive, focusable, and discourages a relaunch by name", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="attention" target="sess:3.0" />);
  expect(html).toContain('aria-live="assertive"');
  expect(html).toContain("tabindex=\"-1\"");
  expect(html).toContain("sess:3.0");
  expect(html).toContain("launch it again");
  /* No spinner in the terminal state — a static glyph, not a false "working". */
  expect(html).not.toContain("animate-spin");
});

test("attention without a known target points the user at their tmux windows", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="attention" target="" />);
  expect(html).toContain("check your tmux windows");
  expect(html).toContain("launch it again");
  expect(html).not.toContain("{target}");
});
