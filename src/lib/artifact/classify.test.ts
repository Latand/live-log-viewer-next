import { expect, test } from "bun:test";

import { classifyArtifact } from "./classify";

test("PDF, raster images and SVG classify with their exact MIME", () => {
  expect(classifyArtifact("/tmp/fixtures/report.pdf")).toEqual({ kind: "pdf", mime: "application/pdf" });
  expect(classifyArtifact("/tmp/fixtures/shot.PNG")).toEqual({ kind: "image", mime: "image/png" });
  expect(classifyArtifact("/tmp/fixtures/photo.jpeg")).toEqual({ kind: "image", mime: "image/jpeg" });
  expect(classifyArtifact("/tmp/fixtures/anim.webp")).toEqual({ kind: "image", mime: "image/webp" });
  expect(classifyArtifact("/tmp/fixtures/diagram.svg")).toEqual({ kind: "image", mime: "image/svg+xml" });
});

test("bounded text and source files classify as text with a highlight hint", () => {
  for (const name of ["notes.md", "run.log", "config.yaml", "main.ts", "tool.py", "build.sh", "data.csv", "index.html", "styles.css", "page.tsx", "mod.rs", "main.go", "settings.json"]) {
    const hit = classifyArtifact(`/tmp/fixtures/${name}`);
    expect(hit?.kind).toBe("text");
    expect(hit?.mime).toBe("text/plain; charset=utf-8");
  }
});

test("a trailing :line suffix does not defeat classification", () => {
  expect(classifyArtifact("/tmp/fixtures/main.ts:42")?.kind).toBe("text");
  expect(classifyArtifact("/tmp/fixtures/main.ts:42:7")?.kind).toBe("text");
});

test("conversation transcripts and unknown extensions stay unclassified", () => {
  /* .jsonl is the conversation deep-link format — it must keep resolving as a
     card focus, never an artifact preview. */
  expect(classifyArtifact("/tmp/projects/session.jsonl")).toBeNull();
  expect(classifyArtifact("/tmp/fixtures/archive.zip")).toBeNull();
  expect(classifyArtifact("/tmp/fixtures/binary.exe")).toBeNull();
  expect(classifyArtifact("/tmp/fixtures/noext")).toBeNull();
  expect(classifyArtifact("")).toBeNull();
});

test("dotfiles and secret-shaped files stay unclassified", () => {
  expect(classifyArtifact("/tmp/fixtures/.env")).toBeNull();
  expect(classifyArtifact("/tmp/fixtures/.env.local")).toBeNull();
});
