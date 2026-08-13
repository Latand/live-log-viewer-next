import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  getVoiceComposerCardIds,
  getVoiceComposerCardNode,
  publishVoiceComposerCardNode,
  resetVoiceSlotsForTest,
} from "./voiceSlots";

/*
 * Several surfaces can be on screen for ONE conversation at once — the board
 * card under the full-window overlay, and the board card beside the orchestrator
 * dock (#977). There is only ever one hoisted composer, so those surfaces are
 * competing PLACES for it, and where it renders must not depend on which of them
 * happened to mount last.
 */

const dom = new Window();
const node = (id: string) => {
  const element = dom.document.createElement("div");
  element.id = id;
  return element as unknown as HTMLElement;
};

afterEach(() => resetVoiceSlotsForTest());

test("with no primary claim the newest place renders the composer", () => {
  const first = node("board");
  const second = node("overlay");
  publishVoiceComposerCardNode("conversation_a", first);
  expect(getVoiceComposerCardNode("conversation_a")).toBe(first);
  publishVoiceComposerCardNode("conversation_a", second);
  expect(getVoiceComposerCardNode("conversation_a")).toBe(second);
});

test("a retracted place falls back to the one underneath instead of leaving the composer homeless", () => {
  const board = node("board");
  const overlay = node("overlay");
  publishVoiceComposerCardNode("conversation_a", board);
  const retractOverlay = publishVoiceComposerCardNode("conversation_a", overlay);

  retractOverlay();

  expect(getVoiceComposerCardNode("conversation_a")).toBe(board);
  expect(getVoiceComposerCardIds()).toEqual(["conversation_a"]);
});

test("a primary place keeps the composer even when a board card mounts after it", () => {
  const dock = node("dock");
  const board = node("board");
  publishVoiceComposerCardNode("conversation_a", dock, true);
  publishVoiceComposerCardNode("conversation_a", board);

  expect(getVoiceComposerCardNode("conversation_a")).toBe(dock);
});

test("retracting the primary hands the composer back to the ordinary card", () => {
  const dock = node("dock");
  const board = node("board");
  publishVoiceComposerCardNode("conversation_a", board);
  const retractDock = publishVoiceComposerCardNode("conversation_a", dock, true);
  expect(getVoiceComposerCardNode("conversation_a")).toBe(dock);

  retractDock();

  expect(getVoiceComposerCardNode("conversation_a")).toBe(board);
});

test("the last place leaving removes the conversation entirely", () => {
  const only = node("only");
  const retract = publishVoiceComposerCardNode("conversation_a", only);
  retract();
  expect(getVoiceComposerCardNode("conversation_a")).toBeNull();
  expect(getVoiceComposerCardIds()).toEqual([]);
});

test("a stale retraction cannot take a live place down with it", () => {
  const first = node("first");
  const second = node("second");
  const retractFirst = publishVoiceComposerCardNode("conversation_a", first);
  publishVoiceComposerCardNode("conversation_a", second);

  retractFirst();
  retractFirst();

  expect(getVoiceComposerCardNode("conversation_a")).toBe(second);
});
