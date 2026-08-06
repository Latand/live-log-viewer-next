# Sidebar crown+pin and manual project creation — visual evidence

Captured against the isolated demo fixture home by `scripts/evidence-crown-capture.ts`,
which boots the same Stage A demo runtime as `bun run demo:capture` and drives the
real UI through the pinned mcp/puppeteer image. The created project's root is a
neutral `/tmp/projects/nova-docs` directory, so no host paths appear in the captures.

Per this repository's publication policy (synthetic-and-redacted-media-only), the
committed PNGs are deterministic redacted placeholders from
`scripts/generate-privacy-placeholders.ts`; each records the SHA-256 of the live
capture it stands in for (see `privacy-manifest.json`). To reproduce the real
captures locally, run:

```
bun scripts/evidence-crown-capture.ts
```

| Capture | What it showed |
| --- | --- |
| `01-rail-baseline.png` | The rail before any curation: three projects in the shared recency order, no crowns. |
| `02-crown-reveal.png` | The per-row crown toggle revealed on a row (dashed outline, same idiom as conversation favorites). Recorded via keyboard focus (`focus-visible`) because the capture browser reports `hover: none`; on a real desktop the identical reveal fires on hover through `group-hover`. |
| `03-crown-pinned.png` | relay and beacon crowned: both floated to the pinned top section with gold crown markers, above the divider and the uncrowned row. |
| `04-crown-after-reload.png` | The same pinned order after a full page reload — the crowns came back from the server store (`state/project-curation.json`), so every client sees the same order. |
| `05-create-form.png` | The create-project form (name + validated absolute-path root) open in the rail. |
| `06-created-project.png` | "Nova Docs" immediately in the rail with zero conversations, auto-selected, with the empty project board and its spawn controls (`+ Agent`) — the created root is the cwd the spawn flow offers. |
| `07-create-duplicate.png` | Re-submitting the same root under another name refused with "This project already exists"; the durable crowns stayed pinned behind the form. |
| `08-create-form-uk.png` | The same create surface in Ukrainian («Створити проєкт», «Назва проєкту», «Коренева тека…»), crowned rows keeping their markers. |

Beyond the screenshots, the capture script asserts in-page before keeping any
frame: crowned rows form the exclusive top section, that order survives a
reload, and the focused crown toggle computes to full opacity.
