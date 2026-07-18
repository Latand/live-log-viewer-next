import { describe, expect, test } from "bun:test";

import { overlayPromptDisplayTitles, projectDisplayName, projectMatchesQuery, rolePromptDisplayTitle } from "./displayNames";
import type { FileEntry } from "./types";

/* Presentation names (issue #345): every case here mirrors an identity the
   scanner actually produces. The canonical key is never changed — only the
   text a person reads. */

describe("projectDisplayName", () => {
  test("the leading-dash viewer slug drops its container prefix", () => {
    expect(projectDisplayName("-agents-tools-live-log-viewer-next")).toBe("live-log-viewer-next");
  });

  test("worktree-derived and deleted-worktree sessions share the parent repo key, so they share one display name", () => {
    /* `projectInfoFromCwd` resolves a live checkout at
       `<repo>/.worktrees/<name>` and a deleted one replayed from the worktree
       map to the SAME canonical key. The presentation layer is a pure function
       of that key, so equal keys can never present as different projects. */
    const liveWorktreeProject = "-agents-tools-live-log-viewer-next";
    const deletedWorktreeProject = "-agents-tools-live-log-viewer-next";
    expect(projectDisplayName(liveWorktreeProject)).toBe(projectDisplayName(deletedWorktreeProject));
    expect(projectDisplayName(liveWorktreeProject)).toBe("live-log-viewer-next");
  });

  test("readable keys pass through untouched", () => {
    expect(projectDisplayName("live-log-viewer-next")).toBe("live-log-viewer-next");
    expect(projectDisplayName("latand")).toBe("latand");
    expect(projectDisplayName("other")).toBe("other");
    expect(projectDisplayName("CelestiaCompose")).toBe("CelestiaCompose");
  });

  test("an unrecognized dashed slug at least loses its leading dashes", () => {
    expect(projectDisplayName("-srv-apps-foo")).toBe("srv-apps-foo");
  });

  test("never returns an empty string", () => {
    expect(projectDisplayName("-")).toBe("-");
    expect(projectDisplayName("---")).toBe("---");
    /* A bare container prefix has no repo remainder to show. */
    expect(projectDisplayName("-agents-tools-")).toBe("agents-tools-");
  });
});

describe("projectMatchesQuery", () => {
  test("matches by canonical key and by display name, case-insensitively", () => {
    const project = "-agents-tools-live-log-viewer-next";
    expect(projectMatchesQuery(project, "-agents-tools")).toBe(true);
    expect(projectMatchesQuery(project, "Viewer")).toBe(true);
    expect(projectMatchesQuery(project, "live-log-viewer-next")).toBe(true);
    expect(projectMatchesQuery(project, "celestia")).toBe(false);
    expect(projectMatchesQuery("CelestiaCompose", "celestia")).toBe(true);
  });

  test("an empty or whitespace query matches everything", () => {
    expect(projectMatchesQuery("anything", "")).toBe(true);
    expect(projectMatchesQuery("anything", "   ")).toBe(true);
  });
});

describe("rolePromptDisplayTitle", () => {
  test("the orchestrator scaffold compacts to the role word", () => {
    expect(
      rolePromptDisplayTitle(
        "You are the Orchestrator. Drive work through the production Viewer API at http://127.0.0.1:8898. Use fresh empty sessions…",
      ),
    ).toBe("Orchestrator");
  });

  test("a mode-carrying scaffold keeps the mode", () => {
    expect(rolePromptDisplayTitle("You are a Builder in tdd mode. Implement the scoped product directive with focused checks.")).toBe(
      "Builder — tdd",
    );
    expect(rolePromptDisplayTitle("You are an Architect in design mode. Ground the design in current code.")).toBe(
      "Architect — design",
    );
  });

  test("a qualified role keeps only the role word", () => {
    expect(rolePromptDisplayTitle("You are a fresh-context Reviewer. Inspect the diff with lens correctness.")).toBe("Reviewer");
  });

  test("dashed and plain roles without modes compact to the bare role", () => {
    expect(rolePromptDisplayTitle("You are a Prod-auditor. Investigate the questions through the read wrapper only.")).toBe(
      "Prod-auditor",
    );
    expect(rolePromptDisplayTitle("You are a Cleaner. Classify the dirty checkout and preserve evidence.")).toBe("Cleaner");
    expect(rolePromptDisplayTitle("You are a Deployer. Plan the blue/green deployment for merged SHA abc.")).toBe("Deployer");
  });

  test("a legacy lowercase scaffold still resolves a known role", () => {
    expect(rolePromptDisplayTitle("You are the reviewer in an implement-review loop. Working directory: /x")).toBe("Reviewer");
  });

  test("an unresolved template placeholder is not a mode", () => {
    expect(rolePromptDisplayTitle("You are a Builder in {{mode}} mode. Implement the scoped product directive.")).toBe("Builder");
  });

  test("a truncated scan title (cleanTitle ellipsis) still compacts", () => {
    expect(rolePromptDisplayTitle("You are the Orchestrator. Drive work through the production Viewer API at http://127.0.0.1:8…")).toBe(
      "Orchestrator",
    );
  });

  test("human titles and conversational openers pass through as null", () => {
    expect(rolePromptDisplayTitle("Fix login redirect")).toBeNull();
    expect(rolePromptDisplayTitle("308 · LLV rescue · Orchestrator")).toBeNull();
    expect(rolePromptDisplayTitle("You are right, the bug is in proxy.ts")).toBeNull();
    expect(rolePromptDisplayTitle("You are the best. Thanks for the help")).toBeNull();
    expect(rolePromptDisplayTitle("You are Claude Code running in a sandbox. Do the thing")).toBeNull();
    /* A bare role intro with no directive after it is not a scaffold. */
    expect(rolePromptDisplayTitle("You are a Builder in tdd mode.")).toBeNull();
    /* Ukrainian titles are untouched. */
    expect(rolePromptDisplayTitle("Виправити редірект логіну")).toBeNull();
  });
});

function entry(overrides: Partial<FileEntry>): FileEntry {
  return {
    path: "/tmp/x.jsonl",
    root: "claude-projects",
    name: "x.jsonl",
    project: "-agents-tools-live-log-viewer-next",
    title: "Claude session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 0,
    size: 0,
    activity: "idle",
    proc: null,
    pid: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

describe("overlayPromptDisplayTitles", () => {
  test("compacts a prompt-only legacy session title in place", () => {
    const files = [
      entry({ path: "/a", title: "You are the Orchestrator. Drive work through the production Viewer API at http://127.0.0.1:8898." }),
      entry({ path: "/b", title: "Fix login redirect" }),
    ];
    overlayPromptDisplayTitles(files);
    expect(files[0]!.title).toBe("Orchestrator");
    expect(files[1]!.title).toBe("Fix login redirect");
  });

  test("a user rename keeps precedence; the compact form replaces only its Reset base", () => {
    const files = [
      entry({
        path: "/a",
        title: "My renamed worker",
        autoTitle: "You are a Builder in tdd mode. Implement the scoped product directive.",
      }),
    ];
    overlayPromptDisplayTitles(files);
    expect(files[0]!.title).toBe("My renamed worker");
    expect(files[0]!.autoTitle).toBe("Builder — tdd");
  });

  test("only agent engines are considered", () => {
    const files = [
      entry({ path: "/a", engine: "shell", kind: "background", title: "You are a Cleaner. Classify the dirty checkout now." }),
    ];
    overlayPromptDisplayTitles(files);
    expect(files[0]!.title).toBe("You are a Cleaner. Classify the dirty checkout now.");
  });

  test("a role-titled worker from the durable overlay no longer matches and stays", () => {
    const files = [entry({ path: "/a", title: "#345 mobile naming — builder" })];
    overlayPromptDisplayTitles(files);
    expect(files[0]!.title).toBe("#345 mobile naming — builder");
  });
});
