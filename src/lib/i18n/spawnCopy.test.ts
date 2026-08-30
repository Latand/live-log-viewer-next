import { expect, test } from "bun:test";

import { en } from "./en";
import { uk } from "./uk";

/*
 * Issue #702: the spawn composer told the operator "the agent will start in
 * tmux" while #685 had already inverted the rollout gates — a deployment that
 * declares a runtime host spawns structured and pane-less. Copy shown BEFORE a
 * launch cannot name a transport the launch may not use.
 *
 * Copy shown AFTER a launch is exempt only where the launch resolved a tmux
 * pane: the draft-pane strings the pane picks once `/api/spawn` reports
 * `spawnTransport: "tmux"`.
 *
 * Issue #1301: the composer's own post-send line is NOT such a case. A send
 * that had to bring the host back reports `spawned`/`outcome: "resumed"` for
 * both transports, and a structured respawn answers with `target: null` — so
 * "launched agent in tmux {target}" claimed a transport that had not run and
 * named nothing while claiming it.
 */

/** Spawn copy that cannot know the transport: promises made before one is
 * resolved, and the post-send line that fires for either one.
 *
 * `composer.titleSpawnResumed` is the tooltip on the resume chip
 * (`AgentControlStrip`), and it belongs here for the same reason: a resume goes
 * through the same `/api/spawn` path, whose `target` is null under a structured
 * transport, so "new tmux window with the resumed agent" described a window
 * that never opens. */
const TRANSPORT_FREE_SPAWN_KEYS = ["composer.placeholderSpawn", "composer.spawnAria", "composer.launchAgent", "composer.titleSpawnResumed", "composer.spawned", "composer.spawnedUnnamed"] as const;

test("spawn copy that cannot know the transport names none in either locale", () => {
  for (const key of TRANSPORT_FREE_SPAWN_KEYS) {
    for (const [locale, dictionary] of [["en", en], ["uk", uk]] as const) {
      const value = dictionary[key];
      expect(typeof value).toBe("string");
      expect(`${locale}:${key}:${value as string}`.toLowerCase()).not.toContain("tmux");
    }
  }
});

test("post-launch copy may still name the tmux target it resolved to", () => {
  /* Guards the exemption above: this is a statement of fact about a pane that
     exists, so tightening the rule must not silently swallow it. */
  expect(en["draft.launched"]).toContain("{target}");
});

test("the composer's post-send line still names the target it was given", () => {
  /* Dropping the transport must not drop the target with it: a legacy pane send
     resolves one, and the operator reads it to find the pane. */
  for (const dictionary of [en, uk]) expect(dictionary["composer.spawned"]).toContain("{target}");
});
