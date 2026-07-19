/** Create-time size limits shared by the API validator (engine) and the builder
    dialog's inline validation, so the client mirrors the server (#93 AC1) without
    importing the server-only engine module. Text params are bounded at
    {@link MAX_ROLE_PARAM_TEXT_LENGTH}, matching the role registry's boundedText. */
export const MAX_TASK_LENGTH = 4_000;
export const MAX_SPEC_LENGTH = 16_000;
export const MAX_STAGE_PROMPT_LENGTH = 8_000;
export const MAX_ROLE_PARAM_TEXT_LENGTH = 2_000;

/** Conversation-graph bounds (#353, schema v3): a pipeline holds 1–8 stages
    once started (drafts may momentarily hold 0 while assembled); fail-edge
    cycles run at most {@link MAX_FAIL_EDGE_ROUNDS} rounds before parking, with
    {@link DEFAULT_FAIL_EDGE_ROUNDS} mirroring the review flow's round limit. */
export const MAX_PIPELINE_STAGES = 8;
export const MIN_STARTED_PIPELINE_STAGES = 1;
export const MAX_FAIL_EDGE_ROUNDS = 9;
export const DEFAULT_FAIL_EDGE_ROUNDS = 5;
