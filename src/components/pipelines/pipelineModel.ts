import { getLocale, translate, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { Pipeline, PipelineAction, PipelineState } from "@/lib/pipelines/types";

export const PIPELINES_CHANGED_EVENT = "llv:pipelines-changed";

export function pipelinesForProject(pipelines: Pipeline[], project: string, files: FileEntry[]): Pipeline[] {
  const paths = new Set(files.filter((file) => file.project === project).map((file) => file.path));
  return pipelines.filter((pipeline) => {
    if (pipeline.state === "closed") return false;
    if (pipeline.project === project) return true;
    return pipeline.runs.some((run) => run.attempts.some((attempt) => Boolean(attempt.agentPath && paths.has(attempt.agentPath))));
  });
}
export function pipelineStateLabel(t: TFunction, state: PipelineState): string {
  return t(`pipelineState.${state}`);
}

export const PIPELINE_BUSY_STATES: ReadonlySet<PipelineState> = new Set(["provisioning", "running"]);
export const PIPELINE_ATTENTION_STATES: ReadonlySet<PipelineState> = new Set(["needs_decision", "paused"]);

export async function patchPipeline(id: string, action: PipelineAction): Promise<string | null> {
  try {
    const response = await fetch(`/api/pipelines/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (response.ok) {
      window.dispatchEvent(new Event(PIPELINES_CHANGED_EVENT));
      return null;
    }
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? translate(getLocale(), "pipelineModel.failed", { status: response.status });
  } catch {
    return translate(getLocale(), "common.serverUnavailable");
  }
}
