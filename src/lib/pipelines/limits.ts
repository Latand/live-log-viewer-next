/** Create-time size limits shared by the API validator (engine) and the builder
    dialog's inline validation, so the client mirrors the server (#93 AC1) without
    importing the server-only engine module. Text params are bounded at
    {@link MAX_ROLE_PARAM_TEXT_LENGTH}, matching the role registry's boundedText. */
export const MAX_TASK_LENGTH = 4_000;
export const MAX_SPEC_LENGTH = 16_000;
export const MAX_STAGE_PROMPT_LENGTH = 8_000;
export const MAX_ROLE_PARAM_TEXT_LENGTH = 2_000;
