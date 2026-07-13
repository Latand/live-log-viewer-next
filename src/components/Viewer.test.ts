import { expect, test } from "bun:test";

import { filesApiUrl } from "@/hooks/useFiles";
import { parseConversationHash } from "@/lib/accounts/identity";

import { OVERVIEW } from "./projectModel";
import { filesRequestPin, initialProjectFromState, reduceCatalogPin } from "./Viewer";

test("initialProjectFromState reads a direct project hash before polling", () => {
  expect(initialProjectFromState("#p=stikon-dispatcher", null)).toBe("stikon-dispatcher");
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
  expect(state).toEqual({ path, hydrated: false });
  state = reduceCatalogPin(state, { kind: "resolve", path });
  expect(state).toEqual({ path, hydrated: true });
  expect(reduceCatalogPin(state, { kind: "release", path })).toBeNull();

  state = reduceCatalogPin(state, { kind: "files", paths: new Set(), pending: false });
  expect(state).toBeNull();
});
