import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { executeRealtimeControl } from "./realtimeControl";
import {
  COORDINATOR_VOICE_PERSONA,
  MODALITY_VOICE_PERSONA,
  resetVoicePersonaOverrideWarningForTest,
  VOICE_PERSONA_FILE,
  voicePersona,
  voicePersonaBootstrap,
  voicePersonaBootstrapIdentity,
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
 * 2. What the modality persona may and may not say.
 * ------------------------------------------------------------------ */

/** The three sentences that demoted the seat, as the properties they assert. */
const ROLE_REPLACEMENTS: { label: string; pattern: RegExp }[] = [
  { label: "declares a replacement identity", pattern: /you are the voice coordinator/i },
  { label: "hands the work to a separate manager", pattern: /there is a manager for that/i },
  { label: "strips the session's own tools", pattern: /you have no tools for spawning agents/i },
  { label: "mandates relaying instead of acting", pattern: /relay (?:what the user wants|with bridge_directive)/i },
  { label: "forbids touching the board", pattern: /you do not touch the board yourself/i },
];

test("the modality persona replaces no part of an existing role", () => {
  const offences = ROLE_REPLACEMENTS
    .filter(({ pattern }) => pattern.test(MODALITY_VOICE_PERSONA))
    .map(({ label }) => label);
  expect(offences).toEqual([]);
});

test("the modality persona says outright that the role and its pending work stand", () => {
  /* Not decoration. The thread may ALREADY carry the coordinator item from a call
     taken before this fix, and this is the only text that outranks it. */
  expect(MODALITY_VOICE_PERSONA).toMatch(/voice (?:is|changes) (?:only )?how/i);
  expect(MODALITY_VOICE_PERSONA).toMatch(/role/i);
  expect(MODALITY_VOICE_PERSONA).toMatch(/pending work/i);
});

test("the modality persona keeps the spoken-delivery rules the call needs", () => {
  /* The reason a persona is injected at all: a thread's instructions are written
     for a reader, and every one of these fails out loud. Dropping them would trade
     one defect for another. */
  for (const rule of [/## Language/, /## Voice/, /## Honesty/]) {
    expect(MODALITY_VOICE_PERSONA).toMatch(rule);
  }
  expect(MODALITY_VOICE_PERSONA).toMatch(/never speak numbers or identifiers aloud/i);
});

test("the modality persona tells an incumbent manager not to relay its own work", () => {
  /* The observed loop, closed in the text as well as in the tool: a seat told to
     relay sends the instruction to the seat, which is itself. */
  expect(MODALITY_VOICE_PERSONA).toMatch(/yourself/i);
  expect(MODALITY_VOICE_PERSONA).toMatch(/bridge_directive/);
});

/* ------------------------------------------------------------------ *
 * 3. The coordinator flow is preserved exactly.
 * ------------------------------------------------------------------ */

test("the coordinator persona still carries the relay mandate it was written for", () => {
  for (const { pattern } of ROLE_REPLACEMENTS) {
    expect(COORDINATOR_VOICE_PERSONA).toMatch(pattern);
  }
});

test("voicePersona resolves the variant it is asked for", () => {
  const nothingOnDisk = () => { throw new Error("ENOENT"); };
  expect(voicePersona("coordinator", nothingOnDisk)).toBe(COORDINATOR_VOICE_PERSONA);
  expect(voicePersona("modality", nothingOnDisk)).toBe(MODALITY_VOICE_PERSONA);
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
    expect(voicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    expect(voicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    /* Once per process: this resolves on every bootstrap. */
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(VOICE_PERSONA_FILE);

    /* And nothing at all when there is no override to ignore. */
    resetVoicePersonaOverrideWarningForTest();
    warnings.length = 0;
    expect(voicePersona("modality", () => { throw new Error("ENOENT"); })).toBe(MODALITY_VOICE_PERSONA);
    expect(voicePersona("modality", () => "   \n ")).toBe(MODALITY_VOICE_PERSONA);
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
  expect(voicePersona("coordinator", override)).toBe("You are the voice coordinator. Relay everything.");
  expect(voicePersona("modality", override)).toBe(MODALITY_VOICE_PERSONA);
});

/* ------------------------------------------------------------------ *
 * 4. Identity: a demoted thread can still be corrected.
 * ------------------------------------------------------------------ */

test("each variant owns a distinct bootstrap item id on the same thread", () => {
  /* The item id is the idempotency receipt. Were it shared, a thread that already
     took the coordinator item would be seen as bootstrapped and could never be
     told otherwise — the demotion would outlive the fix for the thread's life. */
  const coordinator = voicePersonaBootstrapIdentity("thread-1", "coordinator");
  const modality = voicePersonaBootstrapIdentity("thread-1", "modality");
  expect(modality.itemId).not.toBe(coordinator.itemId);
  for (const identity of [coordinator, modality]) {
    /* The provider's 64-character ceiling (#870) binds both variants. */
    expect(identity.receiptId).toMatch(/^voice_persona_[a-f0-9]{46}$/);
    expect(identity.itemId).toBe(`msg_${identity.receiptId}`);
    expect(identity.itemId.length).toBeLessThanOrEqual(64);
  }
});

test("the coordinator identity is unchanged, so established root threads take no second item", () => {
  /* The pre-fix digest, recomputed here from the formula that shipped rather than
     pasted as a literal. A new id would inject a duplicate persona into every
     thread that has ever hosted a coordinator call. */
  const legacyDigest = createHash("sha256")
    .update("voice-persona-bootstrap\0", "utf8")
    .update("thread-1", "utf8")
    .digest("hex")
    .slice(0, 46);
  expect(voicePersonaBootstrapIdentity("thread-1", "coordinator")).toEqual({
    receiptId: `voice_persona_${legacyDigest}`,
    itemId: `msg_voice_persona_${legacyDigest}`,
  });
});

test("the injected item carries the resolved variant's text", () => {
  const identity = voicePersonaBootstrapIdentity("thread-1", "modality");
  const bootstrap = voicePersonaBootstrap(identity, "modality", () => { throw new Error("ENOENT"); });
  expect(bootstrap.item.role).toBe("developer");
  expect(bootstrap.item.id).toBe(identity.itemId);
  expect(bootstrap.item.content[0].text).toBe(MODALITY_VOICE_PERSONA);
});

/* ------------------------------------------------------------------ *
 * 5. On, off, and back on again.
 * ------------------------------------------------------------------ */

function personaBootstrapReceipt(variant: "coordinator" | "modality") {
  const identity = voicePersonaBootstrapIdentity("thread-live", variant);
  return { ...identity, insertion: "accepted" as const };
}

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
        return {
          sdp: "v=0\r\nanswer",
          realtimeSessionId: live,
          personaBootstrap: personaBootstrapReceipt(variant),
        };
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
