import { describe, expect, test } from "bun:test";

import { chunkSpeech, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS } from "./ttsChunks";

function sentences(count: number, word = "sentence"): string {
  return Array.from({ length: count }, (_, index) => `This is ${word} number ${index} in the answer.`).join(" ");
}

describe("chunkSpeech (#1022)", () => {
  test("a message that fits one chunk stays a single request", () => {
    const text = "Short answer that fits in one synthesis request.";
    expect(chunkSpeech(text)).toEqual([{ index: 0, text, start: 0, end: text.length }]);
  });

  test("empty and whitespace-only messages produce no chunks", () => {
    expect(chunkSpeech("")).toEqual([]);
    expect(chunkSpeech("   \n\n\t ")).toEqual([]);
  });

  test("every chunk is an exact slice of the source, in order and without gaps in the text", () => {
    const source = sentences(80);
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    let previousEnd = -1;
    for (const chunk of chunks) {
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.start).toBeGreaterThan(previousEnd);
      previousEnd = chunk.end;
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    /* Nothing is dropped: the spoken words survive the split. */
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(source);
  });

  test("chunks stay inside the size band and never break a word", () => {
    const chunks = chunkSpeech(sentences(120));
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^\s|\s$/);
      expect(chunk.text[0]).toMatch(/\S/);
    }
  });

  test("splits on sentence boundaries, not mid-sentence", () => {
    const chunks = chunkSpeech(sentences(40));
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text).toMatch(/[.!?…]["'”’)\]]*$/);
  });

  test("prefers a paragraph break once the chunk is long enough", () => {
    const source = `${sentences(12, "alpha")}\n\n${sentences(12, "beta")}`;
    const chunks = chunkSpeech(source);
    const crossing = chunks.filter((chunk) => chunk.text.includes("alpha") && chunk.text.includes("beta"));
    expect(crossing).toEqual([]);
  });

  test("a fenced code block stays whole in its own chunk", () => {
    const code = ["```ts", ...Array.from({ length: 30 }, (_, index) => `const value${index} = compute(${index});`), "```"].join("\n");
    const source = `${sentences(10, "intro")}\n\n${code}\n\n${sentences(10, "outro")}`;
    const chunks = chunkSpeech(source);
    const withCode = chunks.filter((chunk) => chunk.text.includes("```"));
    expect(withCode).toHaveLength(1);
    expect(withCode[0]!.text).toBe(code);
    expect(withCode[0]!.text).not.toContain("intro");
    expect(withCode[0]!.text).not.toContain("outro");
  });

  test("an unterminated fence keeps its tail whole", () => {
    const source = `${sentences(10, "lead")}\n\n\`\`\`sh\n${"echo hello\n".repeat(20)}`;
    const chunks = chunkSpeech(source);
    const fenced = chunks.filter((chunk) => chunk.text.includes("```sh"));
    expect(fenced).toHaveLength(1);
    expect(fenced[0]!.text.endsWith("echo hello")).toBe(true);
  });

  test("a URL is never cut, not even by the dots inside it", () => {
    const url = "https://example.com/docs/v1.2.3/guide.html?query=a.b.c#section.4";
    const source = `${sentences(20, "before")} ${url} ${sentences(20, "after")}`;
    const chunks = chunkSpeech(source);
    expect(chunks.filter((chunk) => chunk.text.includes(url))).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/https:\/\/example\.com\/docs\/v1\.2\.3\/guide\.html\?query=a\.b\.c#section\.4.$/);
    }
  });

  test("an unbreakable token longer than the chunk ceiling survives whole", () => {
    const giant = `https://example.com/${"segment/".repeat(200)}end`;
    const chunks = chunkSpeech(`Look here. ${giant} Done reading.`);
    expect(chunks.some((chunk) => chunk.text.includes(giant))).toBe(true);
  });

  test("a single sentence longer than the ceiling splits on whitespace only", () => {
    const source = `${"word ".repeat(600)}end.`;
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^word/);
      expect(chunk.text).toMatch(/(word|end\.)$/);
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  test("no chunk can exceed what one request may carry, whatever the text is", () => {
    /* An unbreakable run has no word boundary to respect; the per-request
       ceiling still holds, or the route would refuse the chunk outright. */
    const blob = "A".repeat(9_000);
    const chunks = chunkSpeech(`Here is the payload. ${blob} That was it.`, { hardMax: 1_000 });
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1_000);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain(blob);
  });

  test("a code block over the per-request ceiling is split rather than rejected", () => {
    const code = ["```ts", `${"const value = compute(index);\n".repeat(400)}`, "```"].join("\n");
    const chunks = chunkSpeech(code, { hardMax: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1000);
  });
});
