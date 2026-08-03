/**
 * The production-shaped pipeline registry issue #863 was measured against.
 *
 * 500 pipelines, two staged roles each, six attempts per stage with realistic
 * prompt/input/output bodies and a spec — 189 MB of registry, one quarter of it
 * closed, spread over eight projects so `project`/`state`/`includeClosed` all
 * discriminate. The bodies matter: they are what a list row must not carry, so
 * every marker below is asserted absent from a projected page.
 */
import { buildPipeline } from "../store";
import type { Pipeline, PipelineStage } from "../types";

/** Marker substrings the tests assert never reach a list row. */
export const CORPUS_BODY_MARKERS = {
  stagePrompt: "build ",
  promptScaffold: "builder scaffold ",
  spec: "acceptance criteria ",
  attemptInput: "prompt input ",
  attemptOutput: "agent output transcript tail ",
} as const;

function stages(): PipelineStage[] {
  return [
    {
      id: "build",
      kind: "run",
      role: { roleId: "builder" },
      "prompt": CORPUS_BODY_MARKERS.stagePrompt.repeat(400),
      next: "review",
      effectiveRole: {
        roleId: "builder",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        access: "read-write",
        promptScaffold: CORPUS_BODY_MARKERS.promptScaffold.repeat(200),
      },
    },
    {
      id: "review",
      kind: "review-loop",
      role: { roleId: "reviewer" },
      "prompt": "review ".repeat(400),
      next: null,
      effectiveRole: {
        roleId: "reviewer",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
        access: "read-only",
        promptScaffold: "reviewer scaffold ".repeat(200),
      },
    },
  ];
}

export function pipelineCorpus(count: number, attemptsPerStage = 6): Pipeline[] {
  const corpus: Pipeline[] = [];
  for (let index = 0; index < count; index += 1) {
    const pipeline = buildPipeline({
      id: `p${String(index).padStart(7, "0")}`,
      task: `task ${index}`,
      project: index % 3 === 0 ? "viewer" : `project-${index % 7}`,
      repoDir: "/repo",
      stages: stages(),
      srcPath: null,
      srcConversationId: null,
      now: new Date(Date.now() - index * 60_000).toISOString(),
    });
    pipeline.spec = CORPUS_BODY_MARKERS.spec.repeat(500);
    if (index % 4 === 0) {
      pipeline.state = "closed";
      pipeline.cursor = null;
      pipeline.closedAt = new Date().toISOString();
    } else {
      pipeline.state = "running";
    }
    pipeline.runs = pipeline.stages.map((stage) => ({
      stageId: stage.id,
      attempts: Array.from({ length: attemptsPerStage }, (_value, attempt) => ({
        n: attempt + 1,
        state: "passed" as const,
        effectiveRole: stage.effectiveRole,
        launchId: null,
        conversationId: null,
        sessionId: null,
        agentPath: null,
        paneId: null,
        flowId: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        input: CORPUS_BODY_MARKERS.attemptInput.repeat(600),
        activatedBy: null,
        output: CORPUS_BODY_MARKERS.attemptOutput.repeat(600),
        verdict: { status: "pass" as const },
        error: null,
      })),
    }));
    corpus.push(pipeline);
  }
  return corpus;
}
