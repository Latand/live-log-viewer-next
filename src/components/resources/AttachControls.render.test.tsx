import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { en } from "@/lib/i18n/en";

import { AttachControlsView } from "./AttachControls";

const noop = () => {};

/** SSR snapshot defaults the locale to English, so the rendered copy is the
    exact en dictionary strings — that is what these assertions pin. */

test("idle state offers both copy actions with accessible labels and hints", () => {
  const html = renderToStaticMarkup(<AttachControlsView status={null} onCopy={noop} onRefresh={noop} />);
  expect(html).toContain(en["attach.attach"]);
  expect(html).toContain(en["attach.readonly"]);
  expect(html).toContain(`aria-label="${en["attach.attach"]}"`);
  expect(html).toContain(`aria-label="${en["attach.readonly"]}"`);
  expect(html).toContain(en["attach.hint"]);
  expect(html).toContain(en["attach.readonlyHint"]);
  /* No premature status, error, or refresh in the resting state. */
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain(en["attach.refresh"]);
});

test("both action buttons meet the 44px touch target on mobile", () => {
  const html = renderToStaticMarkup(<AttachControlsView status={null} onCopy={noop} onRefresh={noop} />);
  /* One min-h-[44px] per button, dropped at the sm breakpoint for desktop density. */
  expect(html.match(/min-h-\[44px\]/g)?.length).toBe(2);
  expect(html).toContain("sm:min-h-0");
});

test("loading announces politely and disables the buttons against double-clicks", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "loading", kind: "attach" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain(en["attach.loading"]);
  expect(html).toContain("disabled=");
  expect(html).toContain("animate-spin");
  expect(html).toContain("motion-reduce:animate-none");
});

test("a successful attach copy confirms via a polite status", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "copied", kind: "attach" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain('role="status"');
  expect(html).toContain(en["attach.copied"]);
});

test("a read-only copy confirms with its own wording", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "copied", kind: "readonly" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain(en["attach.copiedReadonly"]);
  expect(html).not.toContain(en["attach.copied"]);
});

test("a clipboard failure is asserted with text and omits the endpoint refresh action", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "error", kind: "attach", reason: "clipboard" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('aria-live="assertive"');
  expect(html).toContain(en["attach.clipboard"]);
  expect(html).not.toContain(en["attach.refresh"]);
});

test("a stale pane surfaces the refresh message with a Refresh action", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "error", kind: "attach", reason: "stale-pane" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain(en["attach.stale"]);
  expect(html).toContain(en["attach.refresh"]);
});

test("a restarted server is also refresh-recoverable", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "error", kind: "attach", reason: "server-restarted" }} onCopy={noop} onRefresh={noop} />,
  );
  expect(html).toContain(en["attach.restarted"]);
  expect(html).toContain(en["attach.refresh"]);
});

test("the Refresh control is itself a 44px mobile target", () => {
  const html = renderToStaticMarkup(
    <AttachControlsView status={{ phase: "error", kind: "attach", reason: "stale-pane" }} onCopy={noop} onRefresh={noop} />,
  );
  /* Two action buttons + the refresh button all carry the touch minimum. */
  expect(html.match(/min-h-\[44px\]/g)?.length).toBe(3);
});
