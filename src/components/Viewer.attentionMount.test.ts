import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/*
 * The shell renders the attention host (#688 D3).
 *
 * This is the defect class the mount closed: a complete feature — record,
 * machine, route, overlay, board seam — with a green suite and no surface,
 * because every test mounted the pieces directly and nothing asserted that the
 * shipped shell rendered any of them. So this asserts the one thing those tests
 * cannot: that `Viewer` still contains the host.
 *
 * It reads the source rather than rendering, deliberately. The host renders
 * NOTHING until there is something to answer — that contract is asserted in
 * `AttentionHost.dom.test.tsx` — so a rendered tree is empty in exactly the
 * state a shell test could set up, and would go on being empty after the mount
 * was deleted. The import graph is the part that can actually be checked.
 */

const source = fs.readFileSync(path.join(process.cwd(), "src/components/Viewer.tsx"), "utf8");

/** The file with comments removed, so a mount that survives only inside a
    comment does not read as a mount. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

test("the shell imports the attention host", () => {
  expect(code).toMatch(/import\s*\{[^}]*\bAttentionHost\b[^}]*\}\s*from\s*"\.\/attention\/AttentionHost"/);
});

test("the shell renders the attention host, and does not gate it behind a flag", () => {
  const mounted = code.match(/<AttentionHost\b[^>]*\/>/);
  expect(mounted).not.toBeNull();
  /* Every device that can answer a request has to be able to see one, so the
     mount takes only the surface it renders on. A condition here would be a
     device the root agent can address and never reach. */
  expect(mounted![0]).toBe("<AttentionHost mobile={isMobile} />");
});

test("the shell registers the navigator half of the handoff", () => {
  /* The host can answer a request without this, and then move nothing: the
     board knows where things are, the shell knows which project is open, and a
     handoff needs both. */
  expect(code).toMatch(/focusHandoffBus\.setShell\(/);
});
