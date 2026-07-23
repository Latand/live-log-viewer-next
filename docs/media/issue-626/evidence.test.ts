import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildEvidenceArtifacts,
  type EvidenceManifest,
  type GeometryEvidence,
} from "./generate-stills";

const directory = import.meta.dir;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("issue 626 vector evidence reproduces from inspected capture digests and DOM geometry", () => {
  const geometry = JSON.parse(readFileSync(join(directory, "geometry.json"), "utf8")) as Record<string, GeometryEvidence>;
  const actualManifest = JSON.parse(
    readFileSync(join(directory, "privacy-manifest.json"), "utf8"),
  ) as EvidenceManifest;
  const generated = buildEvidenceArtifacts();

  expect(Object.keys(geometry)).toHaveLength(8);
  expect(generated.manifest).toEqual(actualManifest);
  expect(generated.stills.size).toBe(8);
  for (const [path, expected] of generated.stills) {
    const actual = readFileSync(join(directory, path), "utf8");
    expect(actual).toBe(expected);
    const asset = actualManifest.assets.find((candidate) => candidate.path === path);
    expect(asset?.sha256).toBe(sha256(actual));
    expect(asset?.sourceDigests).toHaveLength(1);
    expect(asset?.sourceDigests[0]).not.toBe(asset?.sha256);
  }
});

test("issue 626 geometry pins identity, chronology, tool output, adoption, and 390px overflow", () => {
  const geometry = JSON.parse(readFileSync(join(directory, "geometry.json"), "utf8")) as Record<string, GeometryEvidence>;
  const expectedOrders: Record<string, string[]> = {
    "streaming-before-tool": ["outbox", "live"],
    "refresh-at-tool-transition": ["outbox", "live"],
    "partial-adoption": ["user", "commentary", "tool", "live"],
    "refresh-after-adoption": ["user", "commentary", "tool", "commentary"],
  };

  for (const [key, evidence] of Object.entries(geometry)) {
    const state = key.replace(/-(desktop-1280|mobile-390)$/, "");
    expect(evidence.order).toEqual(expectedOrders[state]);
    expect(evidence.scrollWidth).toBeLessThanOrEqual(evidence.width + 1);
    expect(evidence.conversationId).toBe("conversation_issue_626");
    expect(evidence.launchId).toBe("launch_issue_626");
    if (state === "partial-adoption" || state === "refresh-after-adoption") {
      expect(evidence.toolRows).toBe(1);
      expect(evidence.toolOutputVisible).toBe(true);
      expect(evidence.path).toContain("rollout-issue-626.jsonl");
    } else {
      expect(evidence.filesRevision).toBe("files revision 40");
      expect(evidence.path).toBe("spawn:launch_issue_626");
    }
    if (key.endsWith("mobile-390")) {
      expect(evidence.width).toBe(390);
      expect(evidence.scrollWidth).toBe(390);
    }
  }
});
