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
});
