const FENCED_CODE_BLOCK = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const INDENTED_CODE_BLOCK = /(?:^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g;

/** Leaves only the prose that is useful when an assistant answer is spoken. */
export function spokenAnswerText(markdown: string): string {
  return markdown
    .replace(FENCED_CODE_BLOCK, "\n")
    .replace(INDENTED_CODE_BLOCK, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
