const INDENTED_CODE_BLOCK = /(?:^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g;

export const MAX_TTS_TEXT_LENGTH = 4096;

function stripFencedCodeBlocks(markdown: string): string {
  const kept: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    if (fence) {
      const closer = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closer?.[0] === fence.char && closer.length >= fence.length) fence = null;
      continue;
    }
    const opener = line.match(/^[ \t]*(`{3,}|~{3,})/)?.[1];
    if (opener) {
      fence = { char: opener[0] as "`" | "~", length: opener.length };
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Leaves only the prose that is useful when an assistant answer is spoken. */
export function spokenAnswerText(markdown: string): string {
  return stripFencedCodeBlocks(markdown)
    .replace(INDENTED_CODE_BLOCK, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
