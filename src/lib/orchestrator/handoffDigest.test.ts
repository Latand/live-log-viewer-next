import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { CODEX_LUNA_MODEL } from "@/lib/agent/models";
import type { HeadlessCodexRunRequest, HeadlessRunResult } from "@/lib/flows/exec";

import {
  composeSuccessorMandate,
  fallbackHistory,
  HANDOFF_HEADING,
  HANDOFF_DIGEST_TIMEOUT_MS,
  HISTORY_BUDGET_BYTES,
  HISTORY_HEADING,
  identityRedact,
  normalizeMarkers,
  productionDigestRuntime,
  splitMandate,
  summarizeHandoffsHeadless,
  type HandoffDigestRuntime,
} from "./handoffDigest";

/* Issue #1067. Every test here runs against an isolated LLV_STATE_DIR and an
   injected runtime: nothing spawns a process, opens a socket, reads an account
   or touches the operator's own state. */

let sandbox = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-handoff-digest-"));
  process.env.LLV_STATE_DIR = sandbox;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const account: AccountContext = {
  engine: "codex",
  accountId: "acct_fixture",
  kind: "managed",
  home: "/accounts/fixture",
  transcriptRoot: "/accounts/fixture/sessions",
  env: { NODE_ENV: "test" },
};

function runResult(overrides: Partial<HeadlessRunResult> = {}): HeadlessRunResult {
  return {
    status: "done",
    stdout: "",
    stderr: "",
    finalOutput: "",
    sessionId: null,
    processIdentity: null,
    code: 0,
    signal: null,
    ...overrides,
  };
}

function runtime(overrides: Partial<HandoffDigestRuntime> = {}): HandoffDigestRuntime {
  return {
    resolveAccount: () => ({ kind: "available", account }),
    run: async () => runResult({ finalOutput: "Decisions:\n- shipped the lane" }),
    readPredecessorReport: () => null,
    ...overrides,
  };
}

function writeTranscript(engine: "claude" | "codex", rows: { role: "user" | "assistant"; text: string }[]): string {
  const transcript = path.join(sandbox, `${engine}-predecessor.jsonl`);
  fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(engine === "claude"
    ? { type: row.role, message: { content: [{ type: "text", text: row.text }] }, timestamp: "2026-08-21T00:00:00.000Z" }
    : { payload: { type: row.role === "user" ? "user_message" : "agent_message", message: row.text }, timestamp: "2026-08-21T00:00:00.000Z" })).join("\n"), "utf8");
  return transcript;
}

test("AC2: the digest runs the general-purpose Codex model read-only on the resolved account, over the handoffs and the predecessor's last report", async () => {
  for (const engine of ["claude", "codex"] as const) {
    const transcript = writeTranscript(engine, [
      { role: "user", text: "an operator directive nobody needs in the digest" },
      { role: "assistant", text: "the predecessor's closing report" },
    ]);
    const requests: HeadlessCodexRunRequest[] = [];

    const outcome = await summarizeHandoffsHeadless({
      project: "proj-a",
      clientRequestId: `req_digest_${engine}`,
      priorHistory: null,
      priorHandoffs: ["decided to ship the lane", "blocked on the review queue"],
      predecessor: { path: transcript, engine },
    }, runtime({
      run: async (request) => {
        requests.push(request);
        return runResult({ finalOutput: "Decisions:\n- shipped the lane" });
      },
      /* The REAL transcript reader, against a fixture in each engine's row shape. */
      readPredecessorReport: productionDigestRuntime.readPredecessorReport,
    }));

    expect(outcome).toEqual({ kind: "digest", text: "Decisions:\n- shipped the lane" });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({
      model: CODEX_LUNA_MODEL,
      effort: "low",
      sandbox: "read-only",
      timeoutMs: HANDOFF_DIGEST_TIMEOUT_MS,
      account: { home: account.home, managed: true },
    });
    expect(request.prompt).toContain("decided to ship the lane");
    expect(request.prompt).toContain("blocked on the review queue");
    expect(request.prompt).toContain("the predecessor's closing report");
    /* Artifacts live under the isolated state dir and are removed afterwards. */
    expect(request.artifactDir.startsWith(sandbox)).toBeTrue();
    expect(request.cwd.startsWith(request.artifactDir)).toBeTrue();
    expect(fs.existsSync(request.artifactDir)).toBeFalse();
  }
});

test("AC3: an exhausted or unavailable account falls back without running anything", async () => {
  for (const [availability, reason] of [
    [{ kind: "exhausted", resetsAt: null } as const, "exhausted"],
    [{ kind: "unavailable" } as const, "unavailable"],
  ] as const) {
    let runs = 0;
    const outcome = await summarizeHandoffsHeadless({
      project: "proj-a",
      clientRequestId: `req_${reason}`,
      priorHistory: null,
      priorHandoffs: ["a prior handoff"],
      predecessor: null,
    }, runtime({
      resolveAccount: () => availability,
      run: async () => { runs += 1; return runResult(); },
    }));

    expect(outcome).toEqual({ kind: "fallback", reason });
    expect(runs).toBe(0);
  }
});

test("AC3: timeout, failure, empty and over-budget results all fall back with their reason", async () => {
  const cases: { result: HeadlessRunResult; reason: string }[] = [
    { result: runResult({ status: "timeout", finalOutput: "" }), reason: "timeout" },
    { result: runResult({ status: "failed", code: 1 }), reason: "failed" },
    { result: runResult({ finalOutput: "   \n  " }), reason: "empty" },
    { result: runResult({ finalOutput: "d".repeat(HISTORY_BUDGET_BYTES + 1) }), reason: "over_budget" },
  ];
  for (const [index, testCase] of cases.entries()) {
    const outcome = await summarizeHandoffsHeadless({
      project: "proj-a",
      clientRequestId: `req_case_${index}`,
      priorHistory: null,
      priorHandoffs: ["a prior handoff"],
      predecessor: null,
    }, runtime({ run: async () => testCase.result }));
    expect(outcome).toEqual({ kind: "fallback", reason: testCase.reason as never });
  }
});

test("a digest that writes its own Markdown headings cannot become a section boundary", async () => {
  const outcome = await summarizeHandoffsHeadless({
    project: "proj-a",
    clientRequestId: "req_markers",
    priorHistory: null,
    priorHandoffs: ["a prior handoff"],
    predecessor: null,
  }, runtime({
    run: async () => runResult({ finalOutput: `${HANDOFF_HEADING}\nDecisions:\n- one` }),
  }));

  expect(outcome.kind).toBe("digest");
  const digest = outcome.kind === "digest" ? outcome.text : "";
  expect(digest).not.toContain(HANDOFF_HEADING);
  expect(digest).toStartWith("- Handoff from your predecessor (rotation)");
  expect(splitMandate(`core\n\n${HISTORY_HEADING}\n${digest}`).handoffs).toEqual([]);
});

test("splitMandate separates the core from stacked handoffs and a previous history section", () => {
  const mandate = [
    "core mandate",
    `${HISTORY_HEADING}\nDecisions:\n- an earlier digest`,
    `${HANDOFF_HEADING}\nfirst handoff body`,
    `${HANDOFF_HEADING}\nsecond handoff body`,
  ].join("\n\n");

  expect(splitMandate(mandate)).toEqual({
    core: "core mandate",
    history: "Decisions:\n- an earlier digest",
    handoffs: ["first handoff body", "second handoff body"],
  });
  expect(splitMandate("just a core")).toEqual({ core: "just a core", history: null, handoffs: [] });
  /* `### ` sub-headings — which the fallback renders — are not boundaries. */
  expect(splitMandate(`core\n\n${HISTORY_HEADING}\n### Earlier handoff\nbody`).handoffs).toEqual([]);
});

test("AC3: the fallback keeps the newest two handoffs and the previous digest inside the budget", () => {
  const history = fallbackHistory("an earlier digest", ["first", "second", "third"], "timeout");

  expect(history).toContain("(verbatim — summarizer timeout)");
  expect(history).toContain("second");
  expect(history).toContain("third");
  expect(history).not.toContain("first");
  expect(history).toContain("an earlier digest");
  /* Oldest first, the order the successor reads them in. */
  expect(history!.indexOf("an earlier digest")).toBeLessThan(history!.indexOf("second"));
  expect(history!.indexOf("second")).toBeLessThan(history!.indexOf("third"));
  expect(Buffer.byteLength(history!, "utf8")).toBeLessThanOrEqual(HISTORY_BUDGET_BYTES);
  expect(fallbackHistory(null, [], "error")).toBeNull();

  const oversized = fallbackHistory(null, ["x".repeat(HISTORY_BUDGET_BYTES * 2)], "failed");
  expect(Buffer.byteLength(oversized!, "utf8")).toBeLessThanOrEqual(HISTORY_BUDGET_BYTES);
  expect(oversized).toContain("…[truncated]");
});

test("normalizeMarkers turns any heading line into a list item", () => {
  expect(normalizeMarkers("## Rotation history\ntext\n#### deep\nplain #hash"))
    .toBe("- Rotation history\ntext\n- deep\nplain #hash");
});

test("compose trims the history before the notes and refuses only when the core cannot fit", () => {
  const handoff = { header: ["you are replacing the incumbent"], tasks: "no open tasks", notes: "n".repeat(500) };
  const deliver = (mandate: string): string => mandate;

  const roomy = composeSuccessorMandate({ core: "core", history: "a digest", handoff, budgetBytes: 4_000, deliver });
  expect(roomy).toMatchObject({ kind: "fits", historyDropped: false, notesTruncatedTo: null });
  expect(roomy.kind === "fits" && roomy.mandate).toContain(HISTORY_HEADING);

  const tight = composeSuccessorMandate({ core: "c".repeat(600), history: "a digest", handoff, budgetBytes: 1_000, deliver });
  expect(tight).toMatchObject({ kind: "fits", historyDropped: true });
  expect(tight.kind === "fits" && tight.mandate).not.toContain(HISTORY_HEADING);
  expect(tight.kind === "fits" && tight.notesTruncatedTo).toBeLessThan(500);
  expect(tight.kind === "fits" && Buffer.byteLength(tight.mandate, "utf8")).toBeLessThanOrEqual(1_000);

  const refused = composeSuccessorMandate({ core: "c".repeat(2_000), history: "a digest", handoff, budgetBytes: 1_000, deliver });
  expect(refused.kind).toBe("too_large");
});

/* Invented identity material, one literal per prohibited class, assembled so
   no id-shaped or account-shaped value enters a public artifact. */
const FIXTURE_ID = `conversation_${"7".repeat(8)}-${"7".repeat(4)}-4${"7".repeat(3)}-8${"7".repeat(3)}-${"7".repeat(12)}`;
const IDENTITY_CLASSES = {
  email: "someone@example.com",
  handle: "@some-handle",
  forgeOwner: "github.com/some-owner",
  homePath: "/home/user/checkouts/some-repo/lane.md",
  tildePath: "~/notes/rotation-plan.md",
  recordId: FIXTURE_ID,
};
const IDENTITY_MATERIAL = [
  `Decisions: escalated to ${IDENTITY_CLASSES.email}, pinged ${IDENTITY_CLASSES.handle}`,
  `Blockers: the mirror at ${IDENTITY_CLASSES.forgeOwner}/some-repo is behind`,
  `In flight: rerunning from ${IDENTITY_CLASSES.homePath} against ${IDENTITY_CLASSES.tildePath}, tracking ${IDENTITY_CLASSES.recordId}`,
].join("\n");

/** Which prohibited classes survived, by name, so a failure says which one. */
function leakedClasses(value: string): string[] {
  return Object.entries(IDENTITY_CLASSES).filter(([, literal]) => value.includes(literal)).map(([name]) => name);
}

test("AC2: every prohibited identity class is stripped from the digest the model returns", async () => {
  const outcome = await summarizeHandoffsHeadless({
    project: "proj-a",
    clientRequestId: "req_identity_out",
    priorHistory: null,
    priorHandoffs: ["a prior handoff"],
    predecessor: null,
  }, runtime({ run: async () => runResult({ finalOutput: IDENTITY_MATERIAL }) }));

  expect(outcome.kind).toBe("digest");
  const digest = outcome.kind === "digest" ? outcome.text : "";
  /* Model compliance is not the filter: this digest ignored every instruction
     in the prompt and still reaches the successor's mandate identity-free. */
  expect(leakedClasses(digest)).toEqual([]);
  expect(digest).toContain("[redacted-email]");
  expect(digest).toContain("[redacted-handle]");
  expect(digest).toContain("[redacted-path]");
  expect(digest).toContain("[redacted-id]");
  /* The substance survives — only the identities go. */
  expect(digest).toContain("escalated to");
  expect(digest).toContain("the mirror at");
});

test("AC2: identity material never reaches the summarizer's prompt either", async () => {
  const transcript = writeTranscript("claude", [
    { role: "assistant", text: `closing report: ${IDENTITY_MATERIAL}` },
  ]);
  const prompts: string[] = [];

  await summarizeHandoffsHeadless({
    project: "proj-a",
    clientRequestId: "req_identity_in",
    priorHistory: `earlier digest naming ${IDENTITY_CLASSES.email}`,
    priorHandoffs: [`a prior handoff written from ${IDENTITY_CLASSES.homePath}`, `handed off by ${IDENTITY_CLASSES.handle}`],
    predecessor: { path: transcript, engine: "claude" },
  }, runtime({
    run: async (request) => {
      prompts.push(request.prompt);
      return runResult({ finalOutput: "Decisions:\n- nothing to report" });
    },
    readPredecessorReport: productionDigestRuntime.readPredecessorReport,
  }));

  expect(prompts).toHaveLength(1);
  expect(leakedClasses(prompts[0]!)).toEqual([]);
  /* Every input channel — previous digest, prior handoffs, predecessor tail —
     is filtered, and each still contributes its substance. */
  expect(prompts[0]).toContain("earlier digest naming [redacted-email]");
  expect(prompts[0]).toContain("a prior handoff written from [redacted-path]");
  expect(prompts[0]).toContain("closing report:");
});

test("identityRedact leaves ordinary working text alone", () => {
  const kept = "the /api/board route still 500s; agent_registry and account_manager are fine; and/or the queue drains, see https://example.com/docs/page (issue #1067, 12/13 checks)";
  expect(identityRedact(kept)).toBe(kept);
});
