import { expect, test } from "bun:test";

import { filesApiUrl } from "@/hooks/useFiles";
import { parseConversationHash } from "@/lib/accounts/identity";

import { OVERVIEW } from "./projectModel";
import { filesRequestPin, initialProjectFromState, reduceCatalogPin } from "./Viewer";

test("initialProjectFromState reads a direct project hash before polling", () => {
  expect(initialProjectFromState("#p=example-dispatcher", null)).toBe("example-dispatcher");
  expect(initialProjectFromState("#p=space%20project", null)).toBe("space project");
});

test("initialProjectFromState falls back to saved project only without a project hash", () => {
  expect(initialProjectFromState("", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("#f=/tmp/session.jsonl", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("", null)).toBe(OVERVIEW);
});

test("a resolved capped-out catalog open remains pinned after its hash intent clears", () => {
  const path = "/sessions/capped-out.jsonl";
  const pending = parseConversationHash(`#f=${encodeURIComponent(path)}`);

  expect(filesApiUrl(null, filesRequestPin(pending, path))).toBe(`/api/files?path=${encodeURIComponent(path)}`);
  expect(filesApiUrl(null, filesRequestPin(null, path))).toBe(`/api/files?path=${encodeURIComponent(path)}`);
});

test("catalog pin lifecycle releases on close and on disappearance after hydration", () => {
  const path = "/sessions/capped-out.jsonl";
  let state = reduceCatalogPin(null, { kind: "open", path });
  expect(state).toEqual({ path, hydrated: false, conversationId: null });
  state = reduceCatalogPin(state, { kind: "resolve", path });
  expect(state).toEqual({ path, hydrated: true, conversationId: null });
  expect(reduceCatalogPin(state, { kind: "release", path })).toBeNull();

  state = reduceCatalogPin(state, { kind: "files", paths: new Set(), pending: false });
  expect(state).toBeNull();
});

test("a migrated catalog pin follows the current generation and releases from its close action", () => {
  const predecessor = "/sessions/predecessor.jsonl";
  const successor = "/sessions/successor.jsonl";
  let state = reduceCatalogPin(null, { kind: "resolve", path: predecessor, conversationId: "conversation-1" });
  state = reduceCatalogPin(state, {
    kind: "files",
    paths: new Set([predecessor, successor]),
    pending: false,
    currentPath: successor,
  });

  expect(state).toEqual({ path: successor, hydrated: true, conversationId: "conversation-1" });
  expect(reduceCatalogPin(state, { kind: "release", path: successor })).toBeNull();
});

test("REGRESSION: the Viewer renders no operator ceremony — no gate, no paste field, no unlock", async () => {
  /* The screenshot the operator rejected: an "Operator key" affordance sitting in
     the shell, and a voice control that answered 403 until it was used. The gate
     component is gone; this reads the Viewer's own source so reintroducing any
     paste/unlock surface — under whatever name — fails here rather than on a
     screenshot two rounds later. */
  const source = await Bun.file(new URL("./Viewer.tsx", import.meta.url)).text();

  expect(source).not.toContain("OperatorKeyGate");
  expect(source).not.toContain("operatorHeaders");
  expect(source).not.toContain("hasOperatorCredential");
  for (const ceremony of ["operator.keyPrompt", "operator.keyApply", "type=\"password\""]) {
    expect(source).not.toContain(ceremony);
  }
  /* What stays: the eraser for what earlier rounds left in the profile. */
  expect(source).toContain("purgeLegacyOperatorCredential");
});

test("REGRESSION: no surface in the app asks for an operator key any more", async () => {
  /* The copy went with the component. A translation key that still exists is a
     surface waiting to be rendered. */
  for (const locale of ["en", "uk"]) {
    const source = await Bun.file(new URL(`../lib/i18n/${locale}.ts`, import.meta.url)).text();
    expect(source).not.toContain("operator.key");
  }
});
