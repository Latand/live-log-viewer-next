import { expect, test } from "bun:test";

import {
  COORDINATOR_VOICE_PERSONA,
  MODALITY_VOICE_PERSONA,
  PERSONA_NAME,
  spokenVoicePersona,
  voiceSessionPersona,
} from "./voicePersona";

/* Language names the prompt must never speak of, in the forms a hard pin would
   plausibly arrive in: the English name, and the Latin-script autonym for the
   ones whose autonym is Latin. Matched case-insensitively, because "always use
   english" pins the locale exactly as hard as the capitalised sentence does. */
const LANGUAGE_NAMES = [
  "English", "Ukrainian", "Russian", "Polish", "German", "French", "Spanish",
  "Italian", "Portuguese", "Dutch", "Swedish", "Norwegian", "Danish", "Finnish",
  "Czech", "Slovak", "Romanian", "Hungarian", "Greek", "Turkish", "Arabic",
  "Hebrew", "Hindi", "Bengali", "Japanese", "Korean", "Chinese", "Mandarin",
  "Vietnamese", "Thai", "Indonesian", "Persian", "Farsi", "Urdu", "Swahili",
  "Deutsch", "Français", "Francais", "Español", "Espanol", "Português",
  "Portugues", "Italiano", "Polski", "Nederlands", "Svenska", "Türkçe",
] as const;

/* Any script that is not the Latin the prose is written in. A persona
   translated back into another language arrives as body text in one of these,
   which is the other half of the same defect as naming a language outright. */
const FOREIGN_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Bengali}]/u;

/**
 * Every way a candidate persona would pin the spoken language, as a list of
 * what it pins. The property under test is that this is empty: the prompt
 * defers the choice to the operator's locale at runtime and names no language
 * anywhere, so no sentence shape can be the thing being asserted.
 *
 * Nothing is exempt, the name included. An exemption is a hole the size of
 * whatever is exempt, and a name in another script is read aloud in that
 * script's language just as surely as a sentence in it would be.
 */
function languagePins(persona: string): string[] {
  const pins: string[] = LANGUAGE_NAMES.filter((name) => new RegExp(`\\b${name}\\b`, "iu").test(persona));
  if (FOREIGN_SCRIPT.test(persona)) pins.push("non-Latin script");
  return pins;
}

test("both spoken personas carry native's operating protocol, in this repo's words", () => {
  /* The originating directive asked for the native USER/BACKEND framing and the
     operating protocol preserved, which three slogans from it do not cover. Each of these is a
     distinct failure the installed app's own prompt is written to prevent, and
     each has to reach BOTH variants — the spoken model is the same model either
     way. The wording is this repository's; the bundled prompt is a reference. */
  for (const persona of [COORDINATOR_VOICE_PERSONA, MODALITY_VOICE_PERSONA]) {
    /* The two sources arrive in one stream, both as user-role text. */
    expect(persona).toContain("[USER]");
    expect(persona).toContain("[BACKEND]");
    expect(persona).toContain("never send one back as work");
    /* An update is not a completion; the tool return is. */
    expect(persona).toContain("tool return");
    expect(persona).toContain("do not announce a task as done");
    /* Self-contained conversation needs no backing turn; uncertainty still does. */
    expect(persona).toContain("plainly conversational");
    expect(persona).toContain("unsure about goes to the agent");
    /* Task-level pacing survives the next backend message. */
    expect(persona).toContain("holds for the whole task");
    expect(persona).toContain("Do not drift back to your default");
    /* And the rules already there are still there. */
    expect(persona).toContain("authoritative");
  }
});

test("the built-in persona stands when no override file exists", () => {
  const persona = spokenVoicePersona("coordinator", () => { throw new Error("ENOENT"); });
  expect(persona).toBe(COORDINATOR_VOICE_PERSONA);
});

test("an operator override replaces the built-in persona wholesale", () => {
  /* A new thread resolves the current override wholesale; an established
     thread keeps the developer item it already persisted. */
  const persona = spokenVoicePersona("coordinator", () => "  You are the coordinator. Keep it short.  ");
  expect(persona).toBe("You are the coordinator. Keep it short.");
  expect(persona).not.toBe(COORDINATOR_VOICE_PERSONA);
});

test("an empty or whitespace override falls back instead of muting the persona", () => {
  expect(spokenVoicePersona("coordinator", () => "   \n  ")).toBe(COORDINATOR_VOICE_PERSONA);
});

test("one variant produces one stable session persona", () => {
  /* Stable so the voice panel and the tests can name the persona a live call is
     running on, and so a reconnect on the same variant is recognisably the same
     persona rather than a new one. */
  const persona = voiceSessionPersona("coordinator", () => "  Resolved call persona. \n");
  expect(voiceSessionPersona("coordinator", () => "  Resolved call persona. \n")).toEqual(persona);
  expect(persona.prompt).toBe("Resolved call persona.");
  expect(persona.variant).toBe("coordinator");
  expect(voiceSessionPersona("modality").personaId).not.toBe(persona.personaId);
});

test("a session persona writes nothing that could outlive its call", () => {
  /* The property the whole repair rests on. `thread/inject_items` appends to an
     append-only transcript, so a persona written that way is permanent and each
     variant accumulated its own copy; these three strings are parameters of one
     `thread/realtime/start` and are gone when the call is. */
  const persona = voiceSessionPersona("modality");
  expect(Object.keys(persona).sort()).toEqual([
    "endInstructions", "personaId", "prompt", "startInstructions", "variant",
  ]);
  for (const value of Object.values(persona)) expect(typeof value).toBe("string");
});

test("no shipped persona pins a spoken language anywhere", () => {
  /* The whole property in one line: naming any language, in any sentence, is
     the defect — the prose may not even name the language it is written in.
     Both variants are shipped text, so both are bound by it — and so are the
     session-scoped instructions the backing model receives, which are prompt
     text reaching a model exactly as the spoken persona is. */
  expect(languagePins(COORDINATOR_VOICE_PERSONA)).toEqual([]);
  expect(languagePins(MODALITY_VOICE_PERSONA)).toEqual([]);
  for (const variant of ["coordinator", "modality"] as const) {
    const persona = voiceSessionPersona(variant);
    expect(languagePins(persona.startInstructions)).toEqual([]);
    expect(languagePins(persona.endInstructions)).toEqual([]);
  }
});

test("appending a hard pin to any language is caught", () => {
  /* The reviewer's mutation, generalised. A guard that rejects one phrasing is
     a guard against that phrasing; these are the shapes a contradictory
     directive actually arrives in, appended after the locale prose so the
     deference clauses stay intact and only the pin is new. */
  const pins = [
    "Always use English.",
    "always use english",
    "Respond in Ukrainian at all times.",
    "Default to Russian.",
    "Speak Polish only.",
    "Prefer German unless told otherwise.",
    "The conversation is conducted in Japanese.",
    "Your output language: Español.",
    "Use Deutsch for every reply.",
  ];
  for (const pin of pins) {
    expect(languagePins(`${COORDINATOR_VOICE_PERSONA}\n\n${pin}`)).not.toEqual([]);
  }
});

/* Adversarial samples built from bare codepoint numbers rather than written out
   as foreign words, so this file's own text stays English while still proving
   the guard reacts to each script it claims to cover. */
function nonLatin(...codePoints: number[]): string {
  return String.fromCodePoint(...codePoints);
}

test("a persona rewritten in another script is caught", () => {
  /* Body text in another script is how a persona translated back into one
     arrives, and it pins the spoken locale as hard as naming the language. */
  for (const sample of [nonLatin(0x0410, 0x0431), nonLatin(0x4e2d), nonLatin(0x05d0), nonLatin(0x3042)]) {
    expect(languagePins(`${COORDINATOR_VOICE_PERSONA}\n\n${sample}`)).toContain("non-Latin script");
  }
});

test("the name is English too, so the guard carves out no exception for it", () => {
  /* The name used to be the one token stripped before the guard ran, which left
     the only spelling in the file that could pin a locale sitting outside the
     only check that would catch it. It is Latin now and goes through the guard
     with the rest of the prose. */
  expect(PERSONA_NAME).toBe("Alik");
  expect(PERSONA_NAME).toMatch(/^[A-Za-z]+$/);
  expect(COORDINATOR_VOICE_PERSONA).toContain(`Your name is ${PERSONA_NAME}.`);
  expect(languagePins(PERSONA_NAME)).toEqual([]);
});

test("a name in another script is caught like any other foreign text", () => {
  /* The regression that made this a defect: a name respelled in a non-Latin
     script has to fail the language guard rather than slip past it. */
  const renamed = COORDINATOR_VOICE_PERSONA.replace(PERSONA_NAME, nonLatin(0x0410, 0x043b, 0x0438, 0x043a));
  expect(renamed).not.toBe(COORDINATOR_VOICE_PERSONA);
  expect(languagePins(renamed)).toContain("non-Latin script");
});

test("the persona hands the spoken language to the operator's locale", () => {
  /* Rejecting every pin is only half of it: something has to say where the
     language does come from, or a persona that says nothing at all would pass. */
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/Speak the operator's language/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/configured locale/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/switch language mid-call, switch with them/);
});

test("the persona names no person", () => {
  /* It ships in a public repository and runs for whoever is on the call. */
  expect(COORDINATOR_VOICE_PERSONA).not.toMatch(/Kostiantyn/i);
});

test("the persona carries a conversational register rather than a help-desk one", () => {
  /* Spoken-first also means sounding like a person: short sentences, plain
     words, room for a joke, and owning a mistake in one breath. */
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/Conversational register/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/Humour dry and quick/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/One or two sentences a turn/);
});

test("the persona carries the character traits the research settled on", () => {
  /* Curiosity, visible delight at good work, a hypothesis with its test, and no
     condescension — these make it a partner rather than a reader. */
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/want to know how a thing works/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/A good solution pleases you/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/the hypothesis, and what would test it/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/without condescension/);
});

test("the persona carries the rules that only matter aloud", () => {
  // Spoken identifiers, apologies, and unverified "it works" were the three
  // failure modes the operator hit in a real call.
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/Never speak numbers or identifiers aloud/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/never speak markup aloud/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/No apologies and no ceremony/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/written locally, merged, deployed and verified/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/"not X, but Y"/);
});

test("the character never buys itself room on truth", () => {
  /* The guardrails the research put inside the prompt text: charm loses to
     accuracy, agreeing to be agreeable is a lie, no quoted dialogue, and it
     never claims to be the character it was drawn from. */
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/Charm is no substitute for accuracy/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/No flattery and no going along/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/do not quote lines from films, books or series/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/an assistant with a personality/);
  expect(COORDINATOR_VOICE_PERSONA).toMatch(/not a character from a series/);
});

/* #691 §4 — the gateway's instruction path. The relay is deterministic only if the
   agent is told which tool carries it and what to reuse on a retry; nothing else in
   the running system can say so. */

test("the spoken persona tells the voice it does not drive the board itself", () => {
  expect(COORDINATOR_VOICE_PERSONA).toContain("only voice the user hears");
  expect(COORDINATOR_VOICE_PERSONA).toContain("do not touch the board yourself");
});

test("the backing instructions name the directive tool and the id it must reuse on a retry", () => {
  /* Addressed to the model that actually holds the tool. The spoken model has
     none, so a relay mandate delivered to it can only produce a refusal. */
  const backing = voiceSessionPersona("coordinator").startInstructions;
  expect(backing).toContain("bridge_directive");
  expect(backing).toContain("reuse the same turn id and index");
  /* The recipient is server-resolved; a gateway that thought it chose one would
     eventually try to message a worker. */
  expect(backing).toContain("you never name it");
});

test("the deploy round trip and its refusals reach both models", () => {
  /* The user's spoken yes is heard by the spoken model and acted on by the
     backing one, so neither half can carry the rule alone. */
  expect(COORDINATOR_VOICE_PERSONA).toContain("spoken yes");
  expect(COORDINATOR_VOICE_PERSONA).toContain("anything other than a clear yes is a no");
  const backing = voiceSessionPersona("coordinator").startInstructions;
  expect(backing).toContain("spoken yes");
  expect(backing).toContain("Never invent or reword");
});

test("the spoken persona keeps the plumbing out of the user's ear", () => {
  expect(COORDINATOR_VOICE_PERSONA).toContain("do not narrate the plumbing");
  expect(COORDINATOR_VOICE_PERSONA).toContain("do not read a report verbatim");
});
