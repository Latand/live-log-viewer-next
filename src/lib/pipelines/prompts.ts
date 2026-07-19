import type { EffectivePipelineRole, Pipeline, PipelineStage } from "./types";

function replaceAll(source: string, token: string, value: string): string {
  return source.split(token).join(value);
}

export function renderStagePrompt(
  pipeline: Pipeline,
  stage: PipelineStage,
  role: EffectivePipelineRole,
  previousOutput: string,
): string {
  let body = replaceAll(stage.prompt, "{{task}}", pipeline.task);
  body = replaceAll(body, "{{prev.output}}", previousOutput);
  let roleScaffold = role.promptScaffold ? replaceAll(role.promptScaffold, "{{task}}", pipeline.task) : null;
  if (roleScaffold) roleScaffold = replaceAll(roleScaffold, "{{prev.output}}", previousOutput);
  const access = role.access === "read-only"
    ? "Access: read-only. Inspect and validate freely. Avoid edits, staging, commits, pushes, and other repository mutations."
    : "Access: read-write. Work only inside this pipeline's dedicated worktree and commit-ready scope.";
  const roleContext = role.roleId
    ? [
        `Role preset: ${role.roleId} (${role.engine}${role.model ? `/${role.model}` : ""}${role.effort ? `, ${role.effort}` : ""}).`,
        ...(roleScaffold ? ["", "Role prompt scaffold:", roleScaffold] : []),
      ]
    : [];
  return [
    body.trim(),
    "",
    "Pinned task:",
    pipeline.task,
    "",
    "Pinned specification and acceptance criteria:",
    pipeline.spec?.trim() || "No separate pinned specification was supplied.",
    "",
    ...roleContext,
    access,
    "Pipeline nesting is forbidden. Never create or start another pipeline from this stage.",
    "",
    "Finish the completed turn with one fenced JSON object as the final block. This block is the only completion authority:",
    "```json",
    '{"status":"pass","findings":[],"confidence":0.9}',
    "```",
    "Use pass when the stage contract is complete, fail for a retryable stage failure, and needs_decision when operator judgment is required.",
    "Pass requires findings to be empty or omitted. Use fail or needs_decision when findings describe unresolved work.",
    "Every prose terminal marker must agree with the JSON status: APPROVE=pass, REQUEST_CHANGES=fail, COMMENT=needs_decision. NO FINDINGS agrees with pass.",
    "Human-readable output may appear before the JSON block. Never place text after the block.",
  ].join("\n");
}
