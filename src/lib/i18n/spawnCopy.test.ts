import { expect, test } from "bun:test";

import { en } from "./en";
import { uk } from "./uk";

/*
 * Issue #702: the spawn composer told the operator "the agent will start in
 * tmux" while #685 had already inverted the rollout gates — a deployment that
 * declares a runtime host spawns structured and pane-less. Copy shown BEFORE a
 * launch cannot name a transport the launch may not use.
 *
 * Copy shown AFTER a launch is exempt: it carries a resolved `{target}`, so it
 * is describing a tmux pane that actually exists. So are the draft-pane strings
 * the pane picks only once `/api/spawn` reports `spawnTransport: "tmux"`.
 */

/** Pre-launch spawn copy: promises made before any transport is resolved. */
const PRE_LAUNCH_SPAWN_KEYS = ["composer.placeholderSpawn", "composer.spawnAria", "composer.launchAgent"] as const;

test("pre-launch spawn copy names no transport in either locale", () => {
  for (const key of PRE_LAUNCH_SPAWN_KEYS) {
    for (const [locale, dictionary] of [["en", en], ["uk", uk]] as const) {
      const value = dictionary[key];
      expect(typeof value).toBe("string");
      expect(`${locale}:${key}:${value as string}`.toLowerCase()).not.toContain("tmux");
    }
  }
});

test("post-launch copy may still name the tmux target it resolved to", () => {
  /* Guards the exemption above: these are statements of fact about a pane that
     exists, so tightening the rule must not silently swallow them. */
  expect(en["composer.spawned"]).toContain("{target}");
  expect(en["draft.launched"]).toContain("{target}");
});
