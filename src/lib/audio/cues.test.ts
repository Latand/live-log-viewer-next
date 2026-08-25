import { describe, expect, test } from "bun:test";

import { CUE_ASSET_DIR, CUES, cueAsset, cueAssetAll, type AudioCue } from "./cues";

describe("tool-tick variants", () => {
  test("a variant cue draws deterministically from its slice list", () => {
    const variants = CUES["tool-tick"].variants!;
    expect(variants.length).toBeGreaterThan(1);
    expect(cueAsset("tool-tick", () => 0)).toBe(`${CUE_ASSET_DIR}/${variants[0]}`);
    expect(cueAsset("tool-tick", () => 0.999999)).toBe(`${CUE_ASSET_DIR}/${variants[variants.length - 1]}`);
    const mid = Math.floor(0.5 * variants.length);
    expect(cueAsset("tool-tick", () => 0.5)).toBe(`${CUE_ASSET_DIR}/${variants[mid]}`);
  });

  test("cues without variants keep their single master", () => {
    expect(cueAsset("attention", () => 0.7)).toBe(`${CUE_ASSET_DIR}/attention.mp3`);
  });

  test("warming covers every variant of every cue", () => {
    const all = (Object.keys(CUES) as AudioCue[]).flatMap((cue) => cueAssetAll(cue));
    for (const file of CUES["tool-tick"].variants!) expect(all).toContain(`${CUE_ASSET_DIR}/${file}`);
    expect(new Set(all).size).toBe(all.length);
  });

  test("every registered variant asset is bundled", () => {
    const fs = require("node:fs");
    for (const file of CUES["tool-tick"].variants!) {
      expect(fs.existsSync(`public/audio/cues/${file}`)).toBe(true);
    }
  });
});
