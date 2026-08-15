import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseRuntimeCommand } from "@/lib/runtime/commands";
import { decodeCodexStructuredUserText, encodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { normalizeQueueEntry } from "@/lib/runtime/engineHost";

import { recordOperatorIngress, type OperatorIngressDependencies } from "./ingress";
import { mutateWorktimeState, readWorktimeState } from "./store";

const NOW = Date.parse("2026-08-14T09:00:00.000Z");

describe("operator provenance propagation", () => {
  test("runtime commands accept API-human identity without an op_ prefix", () => {
    const command = parseRuntimeCommand("send", {
      conversationId: "conversation_fixture",
      idempotencyKey: "request_fixture",
      text: "inspect",
      operatorEvent: { id: "api-human-123", origin: "api-human", relation: "direct" },
    });

    expect(command.kind === "send" && command.operatorEvent).toEqual({
      id: "api-human-123",
      origin: "api-human",
      relation: "direct",
    });
  });

  test("queue normalization and Codex transcript markers preserve the stable source identity", () => {
    const operatorEvent = { id: "source-event-1", origin: "composer" as const, relation: "direct" as const };
    const normalized = normalizeQueueEntry({ id: "delivery-1", text: "inspect", operatorEvent });
    const decoded = decodeCodexStructuredUserText(
      encodeCodexStructuredUserText("inspect", undefined, undefined, normalized.operatorEvent),
    );

    expect(normalized.operatorEvent).toEqual(operatorEvent);
    expect(decoded.operatorEvent).toEqual(operatorEvent);
    expect(decoded.text).toBe("inspect");
  });
});

describe("durable ingress ledger", () => {
  test("direct input is recorded at depth one while copied traffic remains non-contributing", () => {
    const state = { current: null as ReturnType<typeof readWorktimeState> | null };
    const mutate: OperatorIngressDependencies["mutate"] = (operation) => {
      state.current ??= readWorktimeState("/missing-fixture-state", NOW, { read: () => null });
      return operation(state.current);
    };
    const dependencies = {
      mutate,
      projectEvidence: () => ({ project: "fixture-project", rank: 4, evidence: "ownership" }),
    };

    recordOperatorIngress({
      provenance: { id: "direct-depth-one", origin: "composer", relation: "direct" },
      conversationId: "conversation_depth_one",
      occurredAtMs: NOW,
    }, dependencies);
    recordOperatorIngress({
      provenance: { id: "fanout-copy", origin: "composer", relation: "copy" },
      conversationId: "conversation_worker",
      occurredAtMs: NOW + 1_000,
    }, dependencies);

    expect(Object.values(state.current!.events)).toEqual([
      expect.objectContaining({ provenOperator: true, project: "fixture-project" }),
      expect.objectContaining({ provenOperator: false, project: null }),
    ]);
  });

  test("the production file store is atomic, mode 0600, and persists only digests", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-worktime-store-"));
    const filename = path.join(directory, "worktime-state.json");
    try {
      mutateWorktimeState(filename, NOW, (state) => {
        recordOperatorIngress({
          provenance: { id: "private-source-id", origin: "api-human", relation: "direct" },
          conversationId: "private-conversation-id",
          occurredAtMs: NOW,
        }, {
          mutate: (operation) => operation(state),
          projectEvidence: () => ({ project: "fixture-project", rank: 3, evidence: "private-cwd-evidence" }),
        });
      });

      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      const raw = fs.readFileSync(filename, "utf8");
      expect(raw).not.toContain("private-source-id");
      expect(raw).not.toContain("private-conversation-id");
      expect(raw).not.toContain("private-cwd-evidence");
      expect(Object.values(readWorktimeState(filename, NOW).events)).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
