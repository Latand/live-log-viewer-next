import { redactSecrets } from "@/lib/review";

const INDENTED_CODE_BLOCK = /(?:^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g;

export const MAX_TTS_TEXT_LENGTH = 4000;

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
  const normalized = stripFencedCodeBlocks(markdown)
    .replace(INDENTED_CODE_BLOCK, "\n")
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<([a-z][\w-]*)\b(?=[^>]*(?:\shidden(?=\s|=|>)|aria-hidden\s*=\s*["']?true))[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/`+[^`\n]+`+/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|.*\|\s*$/gm, " table omitted ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*~]{1,3}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return redactSecrets(normalized);
}
