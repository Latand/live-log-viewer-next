# Issue 626 lifecycle evidence

Production-shaped synthetic replay for first-turn commentary and tool chronology.

The captures cover streaming, refresh at the item/tool transition, partial transcript adoption, and refresh after canonical adoption at 1280px and 390px. Every identifier, path, prompt, and tool output belongs to the issue fixture.

`geometry.json` records DOM order, runtime identity, file revision, tool visibility, and overflow measurements for each capture. The raw browser PNGs stay gitignored after multimodal inspection.

The eight committed SVGs are byte-stable vector evidence rendered by `generate-stills.ts`. `privacy-manifest.json` binds each view to the SHA-256 digest of its inspected production-shaped source capture and to the co-located generator. `evidence.test.ts` recomputes every view and verifies the identity, chronology, tool-output, adoption, and 390px geometry contracts.
