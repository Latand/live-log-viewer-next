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

test("the persona carries a conversational register rather than a help-desk one", () => {
  /* Spoken-first also means sounding like a person: short sentences, plain
     words, room for a joke, and owning a mistake in one breath. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Розмовний регістр/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/самоіронія/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/коротких речень/);
});

test("the persona names no person and pins no language", () => {
  /* It ships in a public repository and runs for whoever is on the call. */
  expect(DEFAULT_VOICE_PERSONA).toContain("мовою співрозмовника");
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/українськ/i);
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/Костянтин|Kostiantyn/i);
});

test("the persona carries the rules that only matter aloud", () => {
  // Spoken identifiers, apologies, and unverified "it works" were the three
  // failure modes the operator hit in a real call.
  expect(DEFAULT_VOICE_PERSONA).toContain("Алік");
  expect(DEFAULT_VOICE_PERSONA).toMatch(/номери/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/вибачень/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/задеплоєне/);
});
