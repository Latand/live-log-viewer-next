import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-settings-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const {
  applySeatTickSettingsChange,
  defaultSeatTickSettings,
  effectiveSeatTickSettings,
  readSeatTickSettings,
  SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES,
  SEAT_TICK_PROMPT_LIMIT,
  seatTickSettingsAfterLapse,
  seatTickSettingsAreDefault,
  writeSeatTickSettings,
} = await import("./seatTickSettings");
import type { SeatTickSettings, SeatTickSettingsActor } from "./seatTickSettings";

/**
 * The per-project tick settings (#1275): what a project may decide about its
 * own wakes, and what the record has to carry afterwards.
 */

const PROJECT = "viewer";
const HOUR_MS = 60 * 60_000;
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const SEAT: SeatTickSettingsActor = {
  kind: "manager",
  conversationId: ["conversation", "0f4c21b7729fbc9e"].join("_"),
  project: PROJECT,
  seatEpoch: 7,
};

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const settingsFile = () => path.join(SANDBOX, "settings", `${crypto.randomUUID()}.json`);

function change(current: SeatTickSettings, input: Parameters<typeof applySeatTickSettingsChange>[1]) {
  return applySeatTickSettingsChange(current, input, { at: AT, actor: SEAT });
}

test("a project nobody configured reads the defaults, which are the tick as it shipped", () => {
  const settings = readSeatTickSettings(PROJECT, settingsFile());
  expect(settings).toEqual(defaultSeatTickSettings(PROJECT));
  expect(seatTickSettingsAreDefault(settings)).toBe(true);
  const effective = effectiveSeatTickSettings(settings, NOW, HOUR_MS);
  expect(effective).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, configured: false, lapsed: false });
});

test("a seat can turn its own project's tick off with no expiry, and it stays off", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "the only open lane is a draft nothing can discharge",
  });
  expect(applied.ok).toBe(true);
  const settings = (applied as { settings: SeatTickSettings }).settings;
  expect(settings).toMatchObject({ enabled: false, until: null, updatedAt: AT, setBy: SEAT });
  /* Two weeks later it is still off: nothing expires a setting that named no
     expiry, which is the point — a bound is a convenience, never a leash. */
  const later = effectiveSeatTickSettings(settings, NOW + 14 * 24 * HOUR_MS, HOUR_MS);
  expect(later).toMatchObject({ enabled: false, isDefault: false, lapsed: false });
  expect(later.reason).toBe("the only open lane is a draft nothing can discharge");
});

test("an expiry lapses back to the default, and the lapse is visible to the caller", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  });
  const settings = (applied as { settings: SeatTickSettings }).settings;
  expect(effectiveSeatTickSettings(settings, NOW + 29 * 60_000, HOUR_MS)).toMatchObject({ enabled: false, lapsed: false });
  const after = effectiveSeatTickSettings(settings, NOW + 31 * 60_000, HOUR_MS);
  expect(after).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, lapsed: true });
  /* Who set the setting that just lapsed survives the lapse, so the board card
     the tick resolves can still say whose decision ended. */
  expect(after.setBy).toEqual(SEAT);
});

test("a cadence is a setting like any other: faster, slower, or back to the default", () => {
  const faster = change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 15, reason: "a release is going out" });
  expect(effectiveSeatTickSettings((faster as { settings: SeatTickSettings }).settings, NOW, HOUR_MS).wakeIntervalMs).toBe(15 * 60_000);

  const slower = change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 12 * 60, reason: "nothing moves here faster than half a day" });
  const slowSettings = (slower as { settings: SeatTickSettings }).settings;
  expect(effectiveSeatTickSettings(slowSettings, NOW, HOUR_MS).wakeIntervalMs).toBe(12 * HOUR_MS);

  const restored = change(slowSettings, { wakeIntervalMinutes: null });
  const restoredSettings = (restored as { settings: SeatTickSettings }).settings;
  expect(seatTickSettingsAreDefault(restoredSettings)).toBe(true);
  expect(effectiveSeatTickSettings(restoredSettings, NOW, HOUR_MS)).toMatchObject({ wakeIntervalMs: HOUR_MS, isDefault: true, configured: true });
});

test("a change that leaves the default without a reason is refused; restoring it needs none", () => {
  expect(change(defaultSeatTickSettings(PROJECT), { enabled: false })).toEqual({
    ok: false,
    error: "a reason is required when the tick is disabled or its wake interval is changed; a quiet tick with no recorded reason is indistinguishable from a broken one",
  });
  const off = (change(defaultSeatTickSettings(PROJECT), { enabled: false, reason: "nothing here for me" }) as { settings: SeatTickSettings }).settings;
  const back = change(off, { enabled: true });
  expect(back.ok).toBe(true);
  /* And the record it restores keeps nothing of the setting it ended: a reason
     left standing beside a tick that is ticking again is the same disagreement
     between record and behaviour as a row that still says "off". Who restored
     it, and when, stays. */
  expect((back as { settings: SeatTickSettings }).settings).toMatchObject({
    enabled: true,
    wakeIntervalMinutes: null,
    reason: null,
    until: null,
    setBy: SEAT,
  });
});

test("an empty change, a nonsense interval and a nonsense expiry are each named", () => {
  expect(change(defaultSeatTickSettings(PROJECT), {})).toEqual({ ok: false, error: "a tick settings change needs at least one field" });
  expect(change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 0, reason: "x" }).ok).toBe(false);
  expect(change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES + 1, reason: "x" }).ok).toBe(false);
  expect(change(defaultSeatTickSettings(PROJECT), { until: "not a time", reason: "x", enabled: false }).ok).toBe(false);
});

test("a change made by another project's seat records whose decision it was", () => {
  const foreign: SeatTickSettingsActor = { kind: "manager", conversationId: SEAT.conversationId, project: "another-project", seatEpoch: 3 };
  const applied = applySeatTickSettingsChange(
    defaultSeatTickSettings(PROJECT),
    { enabled: false, reason: "this board is mine to quiet while the migration runs" },
    { at: AT, actor: foreign },
  );
  expect((applied as { settings: SeatTickSettings }).settings.setBy).toEqual(foreign);
});

test("the reason is redacted and bounded before it is stored anywhere", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: `nothing to do; see ${["", "home", "someone", "notes.md"].join("/")}`,
  });
  const stored = (applied as { settings: SeatTickSettings }).settings.reason ?? "";
  expect(stored).toContain("nothing to do");
  expect(stored).not.toContain("someone");
});

test("the row survives a write and a read, and one project's write leaves the others alone", () => {
  const file = settingsFile();
  const off = (change(defaultSeatTickSettings(PROJECT), { enabled: false, reason: "nothing here for me" }) as { settings: SeatTickSettings }).settings;
  writeSeatTickSettings(PROJECT, off, file);
  writeSeatTickSettings("other", (change(defaultSeatTickSettings("other"), { wakeIntervalMinutes: 30, reason: "busy board" }) as { settings: SeatTickSettings }).settings, file);
  expect(readSeatTickSettings(PROJECT, file)).toEqual(off);
  expect(readSeatTickSettings("other", file)).toMatchObject({ project: "other", enabled: true, wakeIntervalMinutes: 30 });
  expect(readSeatTickSettings("never-configured", file)).toEqual(defaultSeatTickSettings("never-configured"));
});

test("an unreadable settings file reads as an unconfigured project rather than stopping every tick", () => {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json", "utf8");
  expect(readSeatTickSettings(PROJECT, file)).toEqual(defaultSeatTickSettings(PROJECT));
});

/* ------------------------------------------------------------------------- *
 * The seat's own additional prompt for its monitor (#1280).
 *
 * The field the requester asked for by name: a seat can say what its monitor
 * should look at, and those words ride the wakes the Viewer's scheduler fires
 * afterwards. Every case here is about the record, because the record is what
 * a later check reads — the echo of the call that wrote it proves nothing.
 * ------------------------------------------------------------------------- */

function settingsOf(result: ReturnType<typeof change>): SeatTickSettings {
  expect(result.ok).toBe(true);
  return (result as { settings: SeatTickSettings }).settings;
}

test("a prompt is set, replaced and cleared through the same record", () => {
  const set = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "watch the deploy ledger before anything else" }));
  expect(set.monitorPrompt).toBe("watch the deploy ledger before anything else");

  const replaced = settingsOf(change(set, { monitorPrompt: "the ledger is settled; watch the review rounds instead" }));
  expect(replaced.monitorPrompt).toBe("the ledger is settled; watch the review rounds instead");

  const cleared = settingsOf(change(replaced, { monitorPrompt: null }));
  expect(cleared.monitorPrompt).toBeNull();
  /* Cleared is the state a project that never wrote one is in, so the wake it
     gets afterwards is the wake it got before any of this. */
  expect(effectiveSeatTickSettings(cleared, NOW, HOUR_MS).monitorPrompt).toBeNull();
});

test("a prompt needs no reason and leaves the project on the default tick", () => {
  const settings = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "check whether the nightly digest actually sent" }));
  /* No reason was given and none is owed: a prompt cannot quiet a tick, so
     there is no quiet tick here for a reason to explain. */
  expect(settings.reason).toBeNull();
  expect(seatTickSettingsAreDefault(settings)).toBe(true);
  const effective = effectiveSeatTickSettings(settings, NOW, HOUR_MS);
  expect(effective).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, lapsed: false });
  expect(effective.monitorPrompt).toBe("check whether the nightly digest actually sent");
});

test("a prompt is redacted and bounded before it is stored anywhere", () => {
  const leaky = settingsOf(change(defaultSeatTickSettings(PROJECT), {
    monitorPrompt: `read the notes at ${["", "home", "someone", "monitor.md"].join("/")} each wake`,
  }));
  expect(leaky.monitorPrompt).toContain("read the notes at");
  expect(leaky.monitorPrompt).not.toContain("someone");

  const long = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "w".repeat(SEAT_TICK_PROMPT_LIMIT + 500) }));
  expect(long.monitorPrompt!.length).toBe(SEAT_TICK_PROMPT_LIMIT);
  expect(long.monitorPrompt!.endsWith("…")).toBe(true);
});

test("the prompt is untouched by the settings around it: quieting, restoring, and the expiry", () => {
  const withPrompt = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "the release is the only thing that matters here" }));

  const off = settingsOf(change(withPrompt, { enabled: false, reason: "nothing here for me until the release lands" }));
  expect(off).toMatchObject({ enabled: false, monitorPrompt: "the release is the only thing that matters here" });

  /* Restoring the default keeps nothing of the setting it ended — and the
     prompt was never part of that setting, so it stands. */
  const back = settingsOf(change(off, { enabled: true }));
  expect(back).toMatchObject({ enabled: true, reason: null, until: null, monitorPrompt: "the release is the only thing that matters here" });

  /* Nor does an expiry set for the schedule take the prompt with it: the row
     the lapse writes back is the default tick, still carrying the words. */
  const expiring = settingsOf(change(withPrompt, {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  }));
  const lapsed = effectiveSeatTickSettings(expiring, NOW + 31 * 60_000, HOUR_MS);
  expect(lapsed).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
  expect(lapsed.monitorPrompt).toBe("the release is the only thing that matters here");
  expect(seatTickSettingsAfterLapse(PROJECT, lapsed)).toMatchObject({
    enabled: true,
    wakeIntervalMinutes: null,
    reason: null,
    until: null,
    monitorPrompt: "the release is the only thing that matters here",
  });
});

test("a lapse with no prompt on the row writes back the untouched default", () => {
  const expiring = settingsOf(change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  }));
  const lapsed = effectiveSeatTickSettings(expiring, NOW + 31 * 60_000, HOUR_MS);
  expect(seatTickSettingsAfterLapse(PROJECT, lapsed)).toEqual(defaultSeatTickSettings(PROJECT));
});

test("a prompt survives the write and the read a later check does", () => {
  const file = settingsFile();
  const settings = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "start from the oldest blocked card" }));
  writeSeatTickSettings(PROJECT, settings, file);
  expect(readSeatTickSettings(PROJECT, file).monitorPrompt).toBe("start from the oldest blocked card");
  /* And it is one project's, like every other field on the row. */
  expect(readSeatTickSettings("other", file).monitorPrompt).toBeNull();
});

test("a prompt that is neither a string nor null is named rather than stored", () => {
  expect(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: 7 as never })).toEqual({
    ok: false,
    error: "monitorPrompt must be a string, or null to clear it",
  });
});
