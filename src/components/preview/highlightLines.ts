/*
 * Splits one highlight.js HTML string into per-line HTML for a numbered
 * gutter. hljs opens <span> tags that legitimately cross newlines (block
 * comments, template strings); a naive split would leave them unclosed, so
 * every line closes what is still open and the next line re-opens it.
 */

const TAG_RE = /<span[^>]*>|<\/span>/g;

export function splitHighlightedLines(html: string): string[] {
  const lines = html.split("\n");
  const openStack: string[] = [];
  return lines.map((line) => {
    const prefix = openStack.join("");
    for (const match of line.matchAll(TAG_RE)) {
      if (match[0] === "</span>") openStack.pop();
      else openStack.push(match[0]);
    }
    return prefix + line + "</span>".repeat(openStack.length);
  });
}
