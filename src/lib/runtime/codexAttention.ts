/** Only a well-formed native question can opt out of blocking the active turn. */
export function isNonblockingCodexQuestion(method: string, value: unknown): boolean {
  if (method !== "item/tool/requestUserInput" || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const nonempty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (request.isBlocking !== false || !nonempty(request.threadId) || !nonempty(request.turnId)
    || !Array.isArray(request.questions) || !request.questions.length) return false;
  const ids = new Set<string>();
  return request.questions.every(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const question = value as Record<string, unknown>;
    if (!nonempty(question.id) || !nonempty(question.question) || ids.has(question.id as string)) return false;
    ids.add(question.id as string);
    return question.options === undefined || question.options === null || (Array.isArray(question.options)
      && question.options.every(option => option && typeof option === "object" && nonempty(option.label)));
  });
}
