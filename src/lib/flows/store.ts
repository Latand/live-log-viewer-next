import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Flow, FlowPreset, ReviewVerdict } from "./types";

const STATE_DIR = process.env.LLV_STATE_DIR || path.join(os.homedir(), ".claude", "viewer-state");
const FLOWS_FILE = path.join(STATE_DIR, "flows.json");
const PRESETS_FILE = path.join(STATE_DIR, "review-loop-presets.json");
const FLOW_ARTIFACT_DIR = path.join(STATE_DIR, "flows");

const SEEDED_PRESETS: FlowPreset[] = [
  {
    name: "Codex high → Fable",
    implementer: { engine: "codex", model: null, effort: "high" },
    reviewer: { engine: "claude", model: "fable", effort: null },
  },
  {
    name: "Fable → Codex xhigh",
    implementer: { engine: "claude", model: "fable", effort: null },
    reviewer: { engine: "codex", model: null, effort: "xhigh" },
  },
  {
    name: "Sonnet → Codex xhigh",
    implementer: { engine: "claude", model: "sonnet", effort: null },
    reviewer: { engine: "codex", model: null, effort: "xhigh" },
  },
  {
    name: "Codex high → Codex xhigh",
    implementer: { engine: "codex", model: null, effort: "high" },
    reviewer: { engine: "codex", model: null, effort: "xhigh" },
  },
];

type FlowFile = { flows?: unknown };
type PresetFile = { presets?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

export function atomicWriteText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isFlow(value: unknown): value is Flow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const flow = value as Partial<Flow>;
  return (
    typeof flow.id === "string" &&
    flow.template === "implement-review-loop" &&
    typeof flow.cwd === "string" &&
    typeof flow.implementerPath === "string" &&
    typeof flow.baseRef === "string" &&
    Array.isArray(flow.rounds)
  );
}

function isPreset(value: unknown): value is FlowPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preset = value as Partial<FlowPreset>;
  return typeof preset.name === "string" && Boolean(preset.implementer) && Boolean(preset.reviewer);
}

export function loadFlows(): Flow[] {
  const raw = readJson(FLOWS_FILE) as FlowFile | null;
  const flows = Array.isArray(raw?.flows) ? raw.flows.filter(isFlow) : [];
  return flows.map((flow) => ({
    ...flow,
    pausedState: flow.pausedState ?? null,
    rounds: flow.rounds.map((round) => ({
      ...round,
      sessionId: round.sessionId ?? null,
      reviewerPid: round.reviewerPid ?? null,
      spawnStartedAt: round.spawnStartedAt ?? null,
      relayStartedAt: round.relayStartedAt ?? null,
      error: round.error ?? null,
    })),
  }));
}

export function saveFlows(flows: Flow[]): void {
  atomicWriteJson(FLOWS_FILE, { flows });
}

export function loadPresets(): FlowPreset[] {
  const raw = readJson(PRESETS_FILE) as PresetFile | null;
  const presets = Array.isArray(raw?.presets) ? raw.presets.filter(isPreset) : [];
  if (presets.length > 0) return presets;
  savePresets(SEEDED_PRESETS);
  return SEEDED_PRESETS;
}

export function savePresets(presets: FlowPreset[]): void {
  atomicWriteJson(PRESETS_FILE, { presets });
}

export function flowArtifactsDir(flowId: string): string {
  return path.join(FLOW_ARTIFACT_DIR, flowId);
}

export function findingsPathFor(flowId: string, round: number): string {
  return path.join(flowArtifactsDir(flowId), `round-${round}-review.md`);
}

export function outputPathFor(flowId: string, round: number): string {
  return path.join(flowArtifactsDir(flowId), `round-${round}-last-message.md`);
}

export function stderrPathFor(flowId: string, round: number): string {
  return path.join(flowArtifactsDir(flowId), `round-${round}-stderr.txt`);
}

export function stdoutPathFor(flowId: string, round: number): string {
  return path.join(flowArtifactsDir(flowId), `round-${round}-stdout.log`);
}

export function normalizeFindings(verdict: ReviewVerdict, markdown: string): string {
  const body = markdown.replace(/^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/im, "").trim();
  return `VERDICT: ${verdict}\n${body ? "\n" + body + "\n" : "\n"}`;
}
