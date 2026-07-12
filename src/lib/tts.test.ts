import { describe, expect, test } from "bun:test";

import { spokenAnswerText } from "./tts";

describe("spokenAnswerText", () => {
  test("removes fenced and indented code while preserving surrounding prose", () => {
    expect(
      spokenAnswerText("Before.\n\n```ts\nconst secret = 1;\n```\n\n    bun test\n    bunx tsc --noEmit\n\nAfter."),
    ).toBe("Before.\n\nAfter.");
  });

  test("supports tilde fences", () => {
    expect(spokenAnswerText("Intro\n~~~sh\necho hidden\n~~~\nOutro")).toBe("Intro\n\nOutro");
  });

  test("removes empty and unmatched fenced blocks", () => {
    expect(spokenAnswerText("Before\n```\n```\nAfter")).toBe("Before\n\nAfter");
    expect(spokenAnswerText("Before\n```ts\nconst hidden = true;")).toBe("Before");
  });

  test("preserves prose after a longer Markdown fence", () => {
    expect(spokenAnswerText("Before\n````ts\ncode\n````\nAfter")).toBe("Before\n\nAfter");
    expect(spokenAnswerText("Before\n~~~~sh\ncode\n~~~~~\nAfter")).toBe("Before\n\nAfter");
  });

  test("normalizes rich Markdown and redacts secrets before speech", () => {
    const text = "# Result\n\n![chart](data:image/png;base64,AAAA)\n[Docs](https://example.com/private)\n\n| key | value |\n| --- | --- |\n\napi_key=super-secret\n<!-- hidden -->\n<oai-mem-citation><citation_entries>private</citation_entries><rollout_ids>x</rollout_ids></oai-mem-citation>";
    const spoken = spokenAnswerText(text);
    expect(spoken).toContain("Result");
    expect(spoken).toContain("chart");
    expect(spoken).toContain("Docs");
    expect(spoken).toContain("api_key=[redacted]");
    expect(spoken).not.toContain("example.com");
    expect(spoken).not.toContain("base64");
    expect(spoken).not.toContain("private");
  });

  test("removes hidden HTML content and inline Markdown code", () => {
    const spoken = spokenAnswerText("Visible <span hidden>private text</span> end. `secretCode()` <div aria-hidden=\"true\">concealed</div>");
    expect(spoken).toContain("Visible");
    expect(spoken).toContain("end.");
    expect(spoken).not.toContain("private text");
    expect(spoken).not.toContain("secretCode");
    expect(spoken).not.toContain("concealed");
  });
});
