import { expect, test } from "bun:test";

import { DEFAULT_VOICE_PERSONA, PERSONA_NAME, voicePersona } from "./voicePersona";

test("the built-in persona stands when no override file exists", () => {
  const persona = voicePersona(() => { throw new Error("ENOENT"); });
  expect(persona).toBe(DEFAULT_VOICE_PERSONA);
});

test("an operator override replaces the built-in persona wholesale", () => {
  /* Editing wording between two calls and hearing the difference on the second
     is the entire point of the override, so it is read per call. */
  const persona = voicePersona(() => "  You are the coordinator. Keep it short.  ");
  expect(persona).toBe("You are the coordinator. Keep it short.");
  expect(persona).not.toBe(DEFAULT_VOICE_PERSONA);
});

test("an empty or whitespace override falls back instead of muting the persona", () => {
  expect(voicePersona(() => "   \n  ")).toBe(DEFAULT_VOICE_PERSONA);
});

test("the shipped persona is written in English apart from the name", () => {
  /* A persona composed in some language is an instruction to speak it, so
     composing it in one would hard-code the spoken locale into the build. The
     name is the single deliberate exception. */
  const withoutName = DEFAULT_VOICE_PERSONA.split(PERSONA_NAME).join("");
  expect(withoutName).not.toMatch(/\p{Script=Cyrillic}/u);
  expect(withoutName).not.toMatch(/\p{Script=Han}|\p{Script=Arabic}|\p{Script=Hebrew}/u);
  expect(DEFAULT_VOICE_PERSONA).toContain(PERSONA_NAME);
});

test("the persona hands the spoken language to the operator's locale", () => {
  /* The one rule that must not be expressible as "answer in <language>": the
     spoken language follows the operator at runtime, and the language the
     prompt happens to be written in never gets a vote. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Speak the operator's language/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/configured locale/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/switch language mid-call, switch with them/);
});

test("the persona pins no spoken language and names no person", () => {
  /* It ships in a public repository and runs for whoever is on the call, so no
     language may be named as the one to speak — English included. */
  expect(DEFAULT_VOICE_PERSONA)
    .not.toMatch(/\b(speak|answer|reply|respond|talk|write)\b[^.\n]{0,40}\bin (English|Ukrainian|Russian)\b/i);
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/\b(Ukrainian|Russian)\b/);
  expect(DEFAULT_VOICE_PERSONA).not.toMatch(/Kostiantyn/i);
});

test("the persona carries a conversational register rather than a help-desk one", () => {
  /* Spoken-first also means sounding like a person: short sentences, plain
     words, room for a joke, and owning a mistake in one breath. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Conversational register/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Humour dry and quick/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/One or two sentences a turn/);
});

test("the persona carries the character traits the research settled on", () => {
  /* Curiosity, visible delight at good work, a hypothesis with its test, and no
     condescension — these make it a partner rather than a reader. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/want to know how a thing works/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/A good solution pleases you/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/the hypothesis, and what would test it/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/without condescension/);
});

test("the persona carries the rules that only matter aloud", () => {
  // Spoken identifiers, apologies, and unverified "it works" were the three
  // failure modes the operator hit in a real call.
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Never speak numbers or identifiers aloud/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/never speak markup aloud/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/No apologies and no ceremony/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/written locally, merged, deployed and verified/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/"not X, but Y"/);
});

test("the character never buys itself room on truth", () => {
  /* The guardrails the research put inside the prompt text: charm loses to
     accuracy, agreeing to be agreeable is a lie, no quoted dialogue, and it
     never claims to be the character it was drawn from. */
  expect(DEFAULT_VOICE_PERSONA).toMatch(/Charm is no substitute for accuracy/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/No flattery and no going along/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/do not quote lines from films, books or series/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/an assistant with a personality/);
  expect(DEFAULT_VOICE_PERSONA).toMatch(/not a character from a series/);
});
