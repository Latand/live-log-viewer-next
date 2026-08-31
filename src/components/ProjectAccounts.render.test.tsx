import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ProjectAccountsStrip, parseProjectAccountsView, type ProjectAccountsView } from "./ProjectAccounts";

const ATLAS = "project-atlas";

function view(over: Partial<ProjectAccountsView["engines"][number]> = {}): ProjectAccountsView {
  return {
    project: ATLAS,
    engines: [{
      engine: "claude",
      restricted: true,
      allowed: [{ accountId: "acct-reserved", label: "Reserved" }],
      carrying: [],
      outsidePool: [],
      ...over,
    }],
  };
}

const render = (value: ProjectAccountsView | null) => renderToStaticMarkup(<ProjectAccountsStrip view={value} />);

test("a fenced project collapses its account row into one engine switch", () => {
  const html = render(view());
  expect(html).toContain(`data-project-accounts="${ATLAS}"`);
  expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(1);
  expect(html).toContain("Claude");
  expect(html).not.toContain("Reserved");
});

test("many project accounts still paint one collapsed control for their engine", () => {
  const html = render(view({
    allowed: [
      { accountId: "account-north", label: "North star" },
      { accountId: "account-harbor", label: "Harbor light" },
    ],
    carrying: [{ accountId: "account-harbor", label: "Harbor light" }],
  }));
  expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(1);
  expect(html).not.toContain("North star");
  expect(html).not.toContain("Harbor light");
  expect(html).not.toContain("truncate rounded-full");
});

test("a project that is neither fenced nor busy renders nothing", () => {
  expect(render(view({ restricted: false, allowed: [], carrying: [] }))).toBe("");
  expect(render(null)).toBe("");
});

test("an unfenced busy project still gets one on-demand engine control", () => {
  const html = render(view({ restricted: false, allowed: [], carrying: [{ accountId: "acct-spare", label: "Spare" }] }));
  expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(1);
  expect(html).not.toContain("any account");
  expect(html).not.toContain("Spare");
});

test("two relevant engines render at most one control each", () => {
  const html = render({
    project: ATLAS,
    engines: [
      view().engines[0],
      { engine: "codex", restricted: false, allowed: [], carrying: [{ accountId: "account-south", label: "South ridge" }], outsidePool: [] },
    ],
  });
  expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(2);
  expect(html.match(/data-account-switch-engine="claude"/g)?.length).toBe(1);
  expect(html.match(/data-account-switch-engine="codex"/g)?.length).toBe(1);
});

test("a malformed payload parses to nothing rather than throwing", () => {
  expect(parseProjectAccountsView(null)).toBeNull();
  expect(parseProjectAccountsView({ project: ATLAS })).toBeNull();
  expect(parseProjectAccountsView({ project: ATLAS, engines: { claude: { restricted: "yes", allowed: 4 } } })).toEqual({
    project: ATLAS,
    engines: [{ engine: "claude", restricted: false, allowed: [], carrying: [], outsidePool: [] }],
  });
});

test("an account chosen outside the pool stays collapsed at rest", () => {
  const html = render(view({
    outsidePool: [{ accountId: "acct-outside", label: "Outside", at: "2026-08-30T09:00:00.000Z", actor: "operator" }],
  }));
  expect(html.match(/aria-haspopup="dialog"/g)?.length).toBe(1);
  expect(html).not.toContain("Outside");
  expect(html).not.toContain("2026-08-30T09:00:00.000Z");
});
