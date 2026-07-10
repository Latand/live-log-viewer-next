import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { diffFromApplyPatch } from "../diff";
import type { ToolEvent } from "../parse";
import { DiffCard } from "./DiffCard";
import { OutputPreview } from "./OutputPreview";
import { ToolCard } from "./ToolCard";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-07-10T10:00:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "ls -la",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  };
}

test("a collapsed tool row renders its summary and status while body nodes stay lazily unmounted", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ outputPreview: "total 8\nfile.ts" })} />);
  expect(html).toContain("ls -la");
  expect(html).toContain(">ok<");
  // The body (output pre, raw-record button) is not in the DOM until expanded.
  expect(html).not.toContain("total 8");
  expect(html).not.toContain(en("tools.rawRecord"));
});

test("an auto-opened error row mounts its body and shows the compact no-output chip", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ status: "err", statusLabel: "exit 1", open: true, outputPreview: "" })} />);
  expect(html).toContain(en("tools.noOutput"));
  expect(html).toContain(en("tools.noOutputTip"));
  // No leftover apology prose.
  expect(html).not.toContain("rollout session in the left list");
  expect(html).toContain(en("tools.rawRecord"));
});

test("the summary row is a native <summary> and every icon is aria-hidden", () => {
  const html = renderToStaticMarkup(<ToolCard event={toolEvent({ open: true })} />);
  expect(html).toContain("<summary");
  expect(html).not.toMatch(/<svg(?![^>]*aria-hidden)/);
});

test("diff lines carry structural token colors and real +/- markers", () => {
  const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "@@", " keep", "-old", "+new", "*** End Patch"].join("\n");
  const body = diffFromApplyPatch(patch);
  const html = renderToStaticMarkup(<DiffCard body={{ type: "diff", files: body.files, filesTruncated: body.filesTruncated }} />);
  expect(html).toContain("bg-diff-add-soft");
  expect(html).toContain("bg-diff-del-soft");
  expect(html).toContain("+new");
  expect(html).toContain("-old");
  expect(html).toContain("a.ts");
  // no raw hex literals in the rendered markup
  expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
});

test("output preview shows content with an accessible copy control", () => {
  const html = renderToStaticMarkup(<OutputPreview output={"line1\nline2"} truncated={false} />);
  expect(html).toContain("line1");
  expect(html).toContain(en("tools.copyOutput"));
  expect(html).toContain("overflow");
});

test("an orchestration row renders nested children and the meaningful outer summary", () => {
  const html = renderToStaticMarkup(
    <ToolCard
      event={toolEvent({
        open: true,
        icon: "cmd-group",
        summary: en("tools.orchestration", { count: 3 }),
        orchestration: {
          source: "await Promise.all([...])",
          sourceTruncated: false,
          calls: [
            { id: "a#0", tool: "exec_command", family: "shell", icon: "shell", summary: "git status" },
            { id: "b#1", tool: "read_file", family: "read", icon: "file", summary: "Read a.ts" },
          ],
        },
      })}
    />,
  );
  expect(html).toContain(en("tools.nestedCalls"));
  expect(html).toContain("git status");
  expect(html).toContain("Read a.ts");
  expect(html).toContain(en("tools.source"));
});
