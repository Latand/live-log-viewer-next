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

test("a fenced project names the accounts it may use", () => {
  const html = render(view());
  expect(html).toContain("Reserved");
  expect(html).toContain(`data-project-accounts="${ATLAS}"`);
});

test("the account carrying the project's work is marked as carrying", () => {
  const html = render(view({ carrying: [{ accountId: "acct-reserved", label: "Reserved" }] }));
  expect(html).toContain('data-project-account-carrying="acct-reserved"');
  expect(html).toContain("carrying");
});

test("a project that is neither fenced nor busy renders nothing", () => {
  expect(render(view({ restricted: false, allowed: [], carrying: [] }))).toBe("");
  expect(render(null)).toBe("");
});

test("an unfenced project that IS busy shows who is carrying it, and says any account may", () => {
  const html = render(view({ restricted: false, allowed: [], carrying: [{ accountId: "acct-spare", label: "Spare" }] }));
  expect(html).toContain("any account");
  expect(html).toContain('data-project-account-carrying="acct-spare"');
});

test("a carrier outside the allowed set is still shown, and still marked", () => {
  const html = render(view({ carrying: [{ accountId: "acct-legacy", label: "Legacy" }] }));
  expect(html).toContain("Reserved");
  expect(html).toContain('data-project-account-carrying="acct-legacy"');
});

test("a malformed payload parses to nothing rather than throwing", () => {
  expect(parseProjectAccountsView(null)).toBeNull();
  expect(parseProjectAccountsView({ project: ATLAS })).toBeNull();
  expect(parseProjectAccountsView({ project: ATLAS, engines: { claude: { restricted: "yes", allowed: 4 } } })).toEqual({
    project: ATLAS,
    engines: [{ engine: "claude", restricted: false, allowed: [], carrying: [], outsidePool: [] }],
  });
});

test("an account chosen from outside the pool is shown, dated and attributed", () => {
  const html = render(view({
    outsidePool: [{ accountId: "acct-outside", label: "Outside", at: "2026-08-30T09:00:00.000Z", actor: "operator" }],
  }));
  /* The pool still reads as the pool, and the deliberate choice reads as a
     choice: shown beside it, marked, and naming who made it. */
  expect(html).toContain("Reserved");
  expect(html).toContain('data-project-account-outside-pool="acct-outside"');
  expect(html).toContain("outside the pool");
  expect(html).toContain("by you");
  expect(html).toContain("2026-08-30T09:00:00.000Z");
});

test("an agent's choice is attributed to the agent", () => {
  const html = render(view({
    outsidePool: [{ accountId: "acct-outside", label: "Outside", at: "2026-08-30T09:00:00.000Z", actor: "agent" }],
  }));
  expect(html).toContain('data-project-account-outside-pool="acct-outside"');
  expect(html).toContain("by an agent");
});

test("a choice of an account that is also carrying reads as both, on one chip", () => {
  const html = render(view({
    carrying: [{ accountId: "acct-outside", label: "Outside" }],
    outsidePool: [{ accountId: "acct-outside", label: "Outside", at: "2026-08-30T09:00:00.000Z", actor: "operator" }],
  }));
  expect(html.match(/acct-outside/g)?.length).toBeGreaterThan(0);
  expect(html).toContain('data-project-account-carrying="acct-outside"');
  expect(html).toContain('data-project-account-outside-pool="acct-outside"');
  expect(html).toContain("carrying");
  expect(html).toContain("outside the pool");
});
