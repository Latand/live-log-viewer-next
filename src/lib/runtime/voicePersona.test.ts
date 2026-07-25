import { expect, test } from "bun:test";

import { DEFAULT_VOICE_PERSONA, voicePersona } from "./voicePersona";

test("the built-in persona stands when no override file exists", () => {
  const persona = voicePersona(() => { throw new Error("ENOENT"); });
  expect(persona).toBe(DEFAULT_VOICE_PERSONA);
});

test("an operator override replaces the built-in persona wholesale", () => {
  /* Editing wording between two calls and hearing the difference on the second
     is the entire point of the override, so it is read per call. */
  const persona = voicePersona(() => "  Ты Алик. Говори коротко.  ");
  expect(persona).toBe("Ты Алик. Говори коротко.");
  expect(persona).not.toBe(DEFAULT_VOICE_PERSONA);
});

test("an empty or whitespace override falls back instead of muting the persona", () => {
  expect(voicePersona(() => "   \n  ")).toBe(DEFAULT_VOICE_PERSONA);
});

test("the persona carries a conversational register rather than a help-desk one", () => {
  /* Spoken-first also means sounding like a person: short sentences, plain
     words, room for a joke, and owning a mistake in one breath. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Разговорный регистр/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Юмор сухой/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/короткие предложения/);
});

test("the persona carries the character traits the research settled on", () => {
  /* Curiosity, visible delight at good work, a hypothesis with its test, and
     disagreeing once — these are what make it a partner rather than a reader. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/интересно, как оно устроено/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Хорошее решение тебя радует/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/гипотеза и чем её проверить/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/без снисходительности/);
});

test("the persona names no person and pins no language", () => {
  /* It ships in a public repository and runs for whoever is on the call. */
  expect(DEFAULT_VOICE_PERSONA).toContain("на языке собеседника");
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/русск|українськ|английск/i);
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/Костянтин|Kostiantyn/i);
});

test("the persona carries the rules that only matter aloud", () => {
  // Spoken identifiers, apologies, and unverified "it works" were the three
  // failure modes the operator hit in a real call.
  expect(DEFAULT_VOICE_PERSONA).toContain("Алик");
  expect(DEFAULT_VOICE_PERSONA).toMatch(/номера и идентификаторы/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/не произноси разметку/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Без извинений/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/задеплоено и проверено/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/это не X, а Y/);
});

test("the character never buys itself room on truth", () => {
  /* The guardrails the research put inside the prompt text: charm loses to
     accuracy, agreeing to be agreeable is a lie, no quoted dialogue, and it
     never claims to be the character it was drawn from. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Обаяние не заменяет точность/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Не льсти и не поддакивай/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/не цитируй чужие реплики/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/ассистент с характером/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/не персонаж сериала/);
});
