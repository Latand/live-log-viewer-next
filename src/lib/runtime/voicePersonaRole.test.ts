import { expect, test } from "bun:test";

import { executeRealtimeControl } from "./realtimeControl";
import {
  COORDINATOR_VOICE_PERSONA,
  MODALITY_VOICE_PERSONA,
  resetVoicePersonaOverrideWarningForTest,
  VOICE_PERSONA_FILE,
  spokenVoicePersona,
  voiceSessionPersona,
} from "./voicePersona";
import { voicePersonaVariantFor } from "./voicePersonaMandate";

/**
 * Voice is a MODALITY, not a role (the #1615 regression).
 *
 * The operator enabled voice on the conversation holding their project's
 * orchestrator seat. The call start injected the voice-coordinator persona as a
 * durable `developer` item into that same thread, and the seat read its own new
 * instructions: relay everything to "the manager", touch no board tool. It relayed
 * with `bridge_directive`, which resolves the recipient from the designation record
 * — itself — so the instruction came straight back, and the seat declined the work
 * it was already holding.
 *
 * Every test below is one link of that chain. They are written against the persona
 * TEXT and the variant RESOLUTION rather than against a live host, because the
 * defect is what the thread is told, not how the bytes reach it.
 */

/** A conversation carrying no root marker: an ordinary session the operator
    toggled voice on. This is the incumbent case, and the common one. */
const INCUMBENT = {
  id: "conversation_incumbent",
  updatedAt: "2026-09-10T00:00:00.000Z",
  generations: [{ path: "/transcripts/incumbent.jsonl", launchProfile: { role: null } }],
};

/** A session deliberately launched as the root voice coordinator — the flow the
    coordinator persona was written for, and the one that must keep working. */
const EXPLICIT_COORDINATOR = {
  id: "conversation_root",
  updatedAt: "2026-09-10T00:00:00.000Z",
  generations: [{ path: "/transcripts/root.jsonl", launchProfile: { role: "root" } }],
};

/* ------------------------------------------------------------------ *
 * 1. Which persona a conversation is given.
 * ------------------------------------------------------------------ */

test("toggling voice on an incumbent resolves the modality persona, not the coordinator role", () => {
  expect(voicePersonaVariantFor(INCUMBENT.id, {
    conversation: INCUMBENT,
    configuredRootId: null,
  })).toBe("modality");
});

test("a session launched as root keeps the coordinator persona", () => {
  expect(voicePersonaVariantFor(EXPLICIT_COORDINATOR.id, {
    conversation: EXPLICIT_COORDINATOR,
    configuredRootId: null,
  })).toBe("coordinator");
});

test("the configured root conversation is a coordinator even before its role is stamped", () => {
  expect(voicePersonaVariantFor(INCUMBENT.id, {
    conversation: INCUMBENT,
    configuredRootId: INCUMBENT.id,
  })).toBe("coordinator");
});

test("an unresolvable conversation fails safe to the modality persona", () => {
  /* FAILS CLOSED TOWARD THE EXISTING ROLE. An unknown conversation is far more
     likely to be an incumbent the registry could not name than the one root
     session, and guessing "coordinator" is what overwrites a live role. */
  expect(voicePersonaVariantFor("conversation_unknown", {
    conversation: null,
    configuredRootId: null,
  })).toBe("modality");
});

/* ------------------------------------------------------------------ *
 * 2. What the SPOKEN persona may and may not say.
 * ------------------------------------------------------------------ */

/** The sentences that demoted the seat, as the properties they assert. They now
    live in two places — what the spoken model is told, and what the backing
    model is told — so each is checked against the text it belongs to. */
const SPOKEN_ROLE_REPLACEMENTS: { label: string; pattern: RegExp }[] = [
  { label: "declares a replacement identity", pattern: /you are the voice coordinator/i },
  { label: "forbids touching the board", pattern: /you do not touch the board yourself/i },
];

const BACKING_ROLE_REPLACEMENTS: { label: string; pattern: RegExp }[] = [
  { label: "casts the session as the voice front", pattern: /which is the voice front/i },
  { label: "mandates relaying instead of acting", pattern: /relay with bridge_directive/i },
];

test("the modality spoken persona replaces no part of an existing role", () => {
  const offences = SPOKEN_ROLE_REPLACEMENTS
    .filter(({ pattern }) => pattern.test(MODALITY_VOICE_PERSONA))
    .map(({ label }) => label);
  expect(offences).toEqual([]);
});

test("the modality backing instructions replace no part of an existing role", () => {
  const backing = voiceSessionPersona("modality").startInstructions;
  const offences = BACKING_ROLE_REPLACEMENTS
    .filter(({ pattern }) => pattern.test(backing))
    .map(({ label }) => label);
  expect(offences).toEqual([]);
});

test("the modality backing instructions say outright that the role and its work stand", () => {
  /* Not decoration. The thread may ALREADY carry the coordinator item in its
     append-only history from a call taken before #1615, and this is the only text
     that outranks it — now delivered per session rather than written beside it. */
  const backing = voiceSessionPersona("modality").startInstructions;
  expect(backing).toMatch(/preserve this conversation's original instructions/i);
  expect(backing).toMatch(/\btools\b/);
  expect(backing).toMatch(/ongoing work/i);
  expect(backing).toMatch(/it was not written for you/i);
});

test("the modality backing instructions tell an incumbent manager not to relay its own work", () => {
  /* The observed loop, closed in the text as well as in the tool: a seat told to
     relay sends the instruction to the seat, which is itself. */
  const backing = voiceSessionPersona("modality").startInstructions;
  expect(backing).toMatch(/do the work yourself/i);
  expect(backing).toMatch(/bridge_directive/);
});

test("the modality spoken persona forbids the spoken model claiming it has no tools", () => {
  /* The reported symptom, stated as a rule. The spoken model genuinely holds no
     tool — a realtime session has none — so left to Codex's stock persona it
     answers for itself and reports that it cannot reach anything. */
  expect(MODALITY_VOICE_PERSONA).toMatch(/never say that you have no tools/i);
  expect(MODALITY_VOICE_PERSONA).toMatch(/do not answer from your own knowledge/i);
});

test("both spoken personas keep the spoken-delivery rules the call needs", () => {
  /* The reason a persona is sent at all: a thread's instructions are written for
     a reader, and every one of these fails out loud. */
  for (const persona of [MODALITY_VOICE_PERSONA, COORDINATOR_VOICE_PERSONA]) {
    for (const rule of [/## Language/, /## Voice/, /## Honesty/]) {
      expect(persona).toMatch(rule);
    }
    expect(persona).toMatch(/never speak numbers or identifiers aloud/i);
  }
});

/* ------------------------------------------------------------------ *
 * 3. The coordinator flow is preserved exactly.
 * ------------------------------------------------------------------ */

test("the coordinator persona still carries the relay mandate it was written for", () => {
  for (const { pattern } of SPOKEN_ROLE_REPLACEMENTS) {
    expect(COORDINATOR_VOICE_PERSONA).toMatch(pattern);
  }
  const backing = voiceSessionPersona("coordinator").startInstructions;
  for (const { pattern } of BACKING_ROLE_REPLACEMENTS) {
    expect(backing).toMatch(pattern);
  }
});

test("spokenVoicePersona resolves the variant it is asked for", () => {
  const nothingOnDisk = () => { throw new Error("ENOENT"); };
  expect(spokenVoicePersona("coordinator", nothingOnDisk)).toBe(COORDINATOR_VOICE_PERSONA);
  expect(spokenVoicePersona("modality", nothingOnDisk)).toBe(MODALITY_VOICE_PERSONA);
});

test("an ignored override is reported once, so the operator can find out why", () => {
  /* Finding 4 of the #1615 review: the documented customization point silently
     became a no-op for every non-root call. It still does not apply — a
     coordinator-shaped wholesale override is what caused this defect — but it no
     longer does so without saying anything. */
  resetVoicePersonaOverrideWarningForTest();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    expect(spokenVoicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    expect(spokenVoicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    /* Once per process: this resolves on every call start. */
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(VOICE_PERSONA_FILE);

    /* And nothing at all when there is no override to ignore. */
    resetVoicePersonaOverrideWarningForTest();
    warnings.length = 0;
    expect(spokenVoicePersona("modality", () => { throw new Error("ENOENT"); })).toBe(MODALITY_VOICE_PERSONA);
    expect(spokenVoicePersona("modality", () => "   \n ")).toBe(MODALITY_VOICE_PERSONA);
    expect(warnings).toEqual([]);
  } finally {
    console.warn = warn;
    resetVoicePersonaOverrideWarningForTest();
  }
});

test("an operator persona override applies to the coordinator only", () => {
  /* The override file is a wholesale replacement whose text is coordinator-shaped
     by construction. Applying it to an incumbent would reintroduce this very
     defect through the operator's own file, so the modality variant is built-in. */
  const override = () => "You are the voice coordinator. Relay everything.";
  expect(spokenVoicePersona("coordinator", override)).toBe("You are the voice coordinator. Relay everything.");
  expect(spokenVoicePersona("modality", override)).toBe(MODALITY_VOICE_PERSONA);
});

/* ------------------------------------------------------------------ *
 * 4. Identity: which persona a live call is running on.
 * ------------------------------------------------------------------ */

test("each variant owns a distinct persona identity", () => {
  const coordinator = voiceSessionPersona("coordinator");
  const modality = voiceSessionPersona("modality");
  expect(modality.personaId).not.toBe(coordinator.personaId);
  for (const persona of [coordinator, modality]) {
    expect(persona.personaId).toMatch(/^voice_persona_[a-f0-9]{46}$/);
  }
});

test("the persona identity follows the text, so an override is visible as a different call", () => {
  /* The id is evidence of WHICH persona a live call is running on. An override
     that changed the spoken instructions while reporting the built-in identity
     would make the voice panel and every regression assertion agree about a
     persona the call is not using. */
  const builtIn = voiceSessionPersona("coordinator", () => { throw new Error("ENOENT"); });
  const overridden = voiceSessionPersona("coordinator", () => "An operator's own persona.");
  expect(overridden.personaId).not.toBe(builtIn.personaId);
  expect(overridden.prompt).toBe("An operator's own persona.");
});

test("a session persona carries the spoken prompt and the backing pair, and nothing thread-durable", () => {
  /* The whole repair, as a shape: three session-scoped strings. Before this,
     the persona was a `thread/inject_items` write that reached the backing model
     permanently and the spoken model never. */
  const persona = voiceSessionPersona("modality", () => { throw new Error("ENOENT"); });
  expect(persona.prompt).toBe(MODALITY_VOICE_PERSONA);
  expect(persona.startInstructions).toMatch(/realtime voice is active/i);
  expect(persona.endInstructions).toMatch(/realtime voice has ended/i);
  expect(persona.endInstructions).toMatch(/normal text-output policy/i);
  expect(Object.keys(persona).sort()).toEqual([
    "endInstructions", "personaId", "prompt", "startInstructions", "variant",
  ]);
});

test("the end instructions withdraw the spoken register the start instructions imposed", () => {
  /* The pairing is what keeps a text agent from inheriting spoken-delivery rules
     for the rest of its life, which is what a permanent injected item did. */
  for (const variant of ["modality", "coordinator"] as const) {
    const persona = voiceSessionPersona(variant);
    expect(persona.startInstructions).toMatch(/spoken aloud while this call is live/i);
    expect(persona.endInstructions).toMatch(/only while the call was live/i);
  }
});

/* ------------------------------------------------------------------ *
 * 5. On, off, and back on again.
 * ------------------------------------------------------------------ */

/** A host that records the persona variant every start was asked for. */
function recordingHost(variant: "coordinator" | "modality") {
  const starts: unknown[] = [];
  let live: string | null = null;
  return {
    starts,
    host: {
      async startRealtimeWebRtc(sdp: string, persona?: unknown) {
        starts.push(persona);
        live = "live-1";
        const { variant: resolved, personaId } = voiceSessionPersona(variant);
        return { sdp: "v=0\r\nanswer", realtimeSessionId: live, persona: { variant: resolved, personaId } };
      },
      async appendRealtimeSpeech() {},
      async stopRealtime() { live = null; },
      currentRealtimeSessionId() { return live; },
    },
  };
}

test("voice on, off and reconnect never promote an incumbent to coordinator", async () => {
  const { starts, host } = recordingHost("modality");
  const operator = { operator: true, personaVariant: "modality" as const };

  for (const _pass of [1, 2, 3]) {
    const started = await executeRealtimeControl(
      { action: "start", conversationId: "conversation_incumbent", sdp: "v=0\r\noffer\r\n" },
      () => host,
      operator,
    );
    expect(started.status).toBe(200);
    const stopped = await executeRealtimeControl(
      { action: "stop", conversationId: "conversation_incumbent" },
      () => host,
      operator,
    );
    expect(stopped.status).toBe(200);
  }

  /* Every reconnect, not merely the first: a variant resolved once and cached on
     the host would demote on the reconnect after a seat rotation. */
  expect(starts).toEqual(["modality", "modality", "modality"]);
});

test("an explicit coordinator session still starts as a coordinator", async () => {
  const { starts, host } = recordingHost("coordinator");
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_root", sdp: "v=0\r\noffer\r\n" },
    () => host,
    { operator: true, personaVariant: "coordinator" },
  );
  expect(started.status).toBe(200);
  expect(starts).toEqual(["coordinator"]);
});

test("a start that asks no persona question gets the modality persona", async () => {
  /* An unasked question resolves to the answer that changes nothing about the
     conversation's role — the same fail-safe direction as the resolver above. */
  const { starts, host } = recordingHost("modality");
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_incumbent", sdp: "v=0\r\noffer\r\n" },
    () => host,
    { operator: true },
  );
  expect(started.status).toBe(200);
  expect(starts).toEqual(["modality"]);
});


test("the modality instructions add no procedure to a conversation that has its own", () => {
  /* An incumbent orchestrator arrives with a mandate that already says how work
     is accepted and how a deploy is decided — the Viewer's own manager mandate
     states that nobody ever asks the operator to confirm, approve or repeat
     anything. A voice call that quietly added a confirmation step would put the
     seat in the position of contradicting its own instructions out loud, which
     is the same class of harm as taking its tools away. */
  const persona = voiceSessionPersona("modality");
  /* The shapes that IMPOSE a step. "permissions" survives on its own, because
     the modality text names it only to say it is preserved. */
  for (const procedure of [
    /\bconfirm\b/i, /\bapprove\b/i, /\bapproval\b/i, /spoken yes/i,
    /ask the (?:user|operator)/i, /needs the (?:user|operator)/i,
    /\bauthoriz/i, /\bnonce\b/i, /commit (?:hash|exactly)/i, /wait for the (?:user|operator)/i,
  ]) {
    expect(persona.startInstructions).not.toMatch(procedure);
    expect(persona.endInstructions).not.toMatch(procedure);
  }
  /* And the deploy relay stays where it was written for: a session created to be
     nothing but a voice front, which has no mandate of its own to contradict. */
  expect(voiceSessionPersona("coordinator").startInstructions).toMatch(/spoken yes/i);
});
