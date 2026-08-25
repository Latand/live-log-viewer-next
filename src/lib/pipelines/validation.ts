/**
 * Batched create-time validation reporting (#1026).
 *
 * The constraints themselves live where they always did — `normalizeStages`,
 * `createPipelineFromRequest`, `pipelineGraphError`. What changed is that a
 * rejected request no longer stops at the first violated one: every violation
 * is collected, each naming the field it belongs to and the shape that field
 * expects, so a caller composing its first pipeline learns the whole contract
 * from one response instead of one constraint per round trip.
 *
 * A single violation renders to exactly the message it rendered to before, so
 * existing callers, the builder dialog and their tests keep reading the text
 * they already know; the structured list always carries field and expected.
 */
export type PipelineValidationViolation = {
  /** Path of the offending field in the request, e.g. `stages[1].next`. */
  field: string;
  /** The violated constraint, in the same words the single-error path used. */
  message: string;
  /** What a valid value for `field` looks like. */
  expected: string;
};

/** The `error` string for a batch: one violation keeps its own message; several
    are listed with their field and expected shape, in request order. */
export function pipelineValidationError(violations: readonly PipelineValidationViolation[]): string {
  if (violations.length === 0) return "invalid pipeline request";
  if (violations.length === 1) return violations[0]!.message;
  const listed = violations.map((violation) => `${violation.field}: ${violation.message} (expected ${violation.expected})`);
  return `${violations.length} validation errors — ${listed.join("; ")}`;
}
