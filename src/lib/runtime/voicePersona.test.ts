import { expect, test } from "bun:test";

import { DEFAULT_VOICE_PERSONA, voicePersona } from "./voicePersona";

test("the built-in persona stands when no override file exists", () => {
  const persona = voicePersona(() => { throw new Error("ENOENT"); });
  expect(persona).toBe(DEFAULT_VOICE_PERSONA);
});

test("an operator override replaces the built-in persona wholesale", () => {
  /* Editing wording between two calls and hearing the difference on the second
     is the entire point of the override, so it is read per call. */
  const persona = voicePersona(() => "  Ти Алік. Говори коротко.  ");
  expect(persona).toBe("Ти Алік. Говори коротко.");
});

test("an empty or whitespace override falls back instead of muting the persona", () => {
  expect(voicePersona(() => "   \n  ")).toBe(DEFAULT_VOICE_PERSONA);
});

test("the persona carries the rules that only matter aloud", () => {
  // Spoken identifiers, apologies, and unverified "it works" were the three
  // failure modes the operator hit in a real call.
  expect(DEFAULT_VOICE_PERSONA).toContain("Алік");
  expect(DEFAULT_VOICE_PERSONA).toMatch(/номери/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/вибачень/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/задеплоєне/);
});
