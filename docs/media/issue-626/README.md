# Issue 626 lifecycle evidence

Production-shaped synthetic replay for first-turn commentary, tool chronology, and durable ownership.

The captures mount the production `BranchPane`, `LogFeed`, and composer with deterministic log/runtime transports. They cover streaming, refresh at the item/tool transition, partial transcript adoption, capped-tail eviction, repeated prompts, structured review/citation output, a second turn, bounded overflow, and refresh after canonical adoption at 1280px and 390px. Every identifier, path, prompt, and tool output belongs to the issue fixture.

`geometry.json` records DOM order, runtime identity, file revision, tool visibility, tail bounds, assistant overflow, and queue state for each capture. The raw browser PNGs stay gitignored after visual inspection and their SHA-256 digests remain in the generator. OCR is excluded from this workflow.

The eight committed SVGs are byte-stable vector evidence rendered by `generate-stills.ts`. `privacy-manifest.json` binds each view to the SHA-256 digest of its inspected production-shaped source capture and to the co-located generator. `evidence.test.ts` recomputes every view and verifies the identity, chronology, tool-output, adoption, and 390px geometry contracts.
