import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";
import type { AttachCommand } from "@/lib/agent/attachCommand";

import { AttachTerminalDialogView } from "./AttachTerminalDialog";

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

const command: AttachCommand = {
  engine: "claude",
  accountId: "d",
  accountLabel: "D · claude-max",
  cwd: "/home/latand/Projects/atlas",
  command: "env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR='/x/d' claude --resume 22222222",
  cdCommand: "cd '/home/latand/Projects/atlas'",
  fullCommand: "cd '/home/latand/Projects/atlas' && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR='/x/d' claude --resume 22222222",
};

function view(over: Partial<Parameters<typeof AttachTerminalDialogView>[0]> = {}) {
  return renderToStaticMarkup(
    <AttachTerminalDialogView t={t} loading={false} error={null} command={command} onClose={() => {}} onSecondary={() => {}} {...over} />,
  );
}

test("the dialog is a labelled modal that shows the account and both copy blocks", () => {
  const html = view();
  expect(html).toContain('role="dialog"');
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain("D · claude-max");
  // the cwd block (shell-quoted) and the resume command block are both present, copyable
  expect(html).toContain("cd &#x27;/home/latand/Projects/atlas&#x27;");
  expect(html).toContain("claude --resume 22222222");
  expect(html).toContain(translate("en", "attach.copyFull"));
  expect(html).toContain(translate("en", "attach.secondaryViewer"));
});

test("the take-over warning is shown", () => {
  expect(view()).toContain(translate("en", "attach.takeoverWarning"));
});

test("a subagent command carries the root-session note", () => {
  const html = view({ command: { ...command, note: "subagent-root" } });
  expect(html).toContain(translate("en", "attach.subagentNote"));
});

test("the loading state is a polite status region, no command yet", () => {
  const html = view({ loading: true, command: null });
  expect(html).toContain('role="status"');
  expect(html).toContain(translate("en", "attach.loading"));
  expect(html).not.toContain("claude --resume");
});

test("an error is surfaced as an alert", () => {
  const html = view({ loading: false, error: "this conversation cannot be attached", command: null });
  expect(html).toContain('role="alert"');
  expect(html).toContain("this conversation cannot be attached");
});

/* ------------------------- live tmux attach (§6, finding 3) ------------------------- */

const live = { command: "tmux -L default attach -t %12", readOnlyCommand: "tmux -L default attach -r -t %12" };

test("live mode shows the attach + read-only commands, a read-only note, and NO resume/takeover", () => {
  const html = renderToStaticMarkup(
    <AttachTerminalDialogView t={t} loading={false} error={null} command={null} live={live} onClose={() => {}} onSecondary={() => {}} />,
  );
  // both the attach command and the read-only variant are copyable
  expect(html).toContain("tmux -L default attach -t %12");
  expect(html).toContain("tmux -L default attach -r -t %12");
  expect(html).toContain(translate("en", "attach.readonlyHint"));
  // a running pane is attached, not resumed — no take-over warning, no --resume
  expect(html).not.toContain(translate("en", "attach.takeoverWarning"));
  expect(html).not.toContain("--resume");
});

