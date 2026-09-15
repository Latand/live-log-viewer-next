import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for account choice on the kanban board (#1695 K6): the
 * real Viewer over `issue1695Evidence.fixture.tsx?scenario=accounts`, with the
 * production stylesheet, in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Accounts.browser.test.tsx
 *
 * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
 * prototype, its `account-picker` frame (a working stage conversation's
 * picker) and its waiting stage's picker (`stage=t-links:review`) are rendered
 * beside the production frames and compared.
 *
 * Gated here:
 *   - a waiting stage's chip and picker: the project's choice first, accounts
 *     the binding refuses for a stage unavailable, a choice written as
 *     `override-stage {stageId, account, expectedStageDigest}` alone, the
 *     stage's prompt and runtime unchanged;
 *   - a running stage conversation's chip and picker: its current account and
 *     stage setting, an account outside the project's accounts offered and
 *     recorded, the switch sent as the conversation header's `reconfigure`,
 *     then "after this turn" with the target known to this page only (the
 *     fixture runs without a runtime plane, so no session reports it), every
 *     nothing resent while it waits, and "now runs on" only once the
 *     conversation runs on the target;
 *   - Cancel switch and Change the pending account, as the prototype has them
 *     (#1705): Change withdraws the queued switch by its operation before the
 *     new switch is sent; Cancel on a switch the migration record reports
 *     sends the record's revision; a switch past waiting for its turn offers
 *     neither;
 *   - a switch the migration record reports, shown to a fresh page; a switch
 *     with no answer, not confirmed and never resent.
 *
 * Measurements go to `evidence/issue-1695/k6.json`; frames to
 * `.artifacts/issue-1695/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
const VIEWPORT = { width: 1440, height: 900 } as const;

type Scheme = "light" | "dark";

interface PickerMeasure {
  width: number;
  head: string;
  now: string[][];
  label: string;
  rows: Array<{ name: string; tag: string; checked: boolean; disabled: boolean; meter: boolean }>;
  notes: string[];
  cancel: boolean;
  chip: { text: string; pending: boolean; when: string };
}

/** The open picker and the chip it came from, read the same way from either page. */
const measurePicker = (page: Page, chipSelector: string) => page.evaluate((selector): PickerMeasure | null => {
  const pop = document.querySelector<HTMLElement>(".popover.acct-pop");
  if (!pop) return null;
  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const chip = document.querySelector<HTMLElement>(selector);
  return {
    width: Math.round(pop.getBoundingClientRect().width),
    head: text(pop.querySelector(".head span")),
    now: [...pop.querySelectorAll(".acct-now .kv")].map((line) => [text(line.querySelector(".k")), text(line.querySelector(".v"))]),
    label: text(pop.querySelector(".acct-lbl")),
    rows: [...pop.querySelectorAll<HTMLElement>(".acct-row")].map((row) => ({
      name: text(row.querySelector(".nm")),
      tag: text(row.querySelector(".tag")),
      checked: row.getAttribute("aria-checked") === "true",
      disabled: row.getAttribute("aria-disabled") === "true",
      meter: Boolean(row.querySelector(".meter i")),
    })),
    notes: [...pop.querySelectorAll(".acct-now .acct-sub, :scope > .note, .gap")].map(text),
    cancel: [...pop.querySelectorAll("button")].some((button) => /cancel/i.test(button.textContent ?? "")),
    chip: { text: text(chip), pending: Boolean(chip?.classList.contains("pending")), when: text(chip?.querySelector(".when")) },
  };
}, chipSelector);

const card = (id: string) => `[data-kanban-board] .card[data-id="task:${id}"]`;
const VERIFY_CHIP = '[data-kanban-board] [data-account-trigger="conversation_search-ver-2"]';
const LINKS_REVIEW_CHIP = '[data-kanban-board] [data-account-trigger="stage:p-links:review"]';

type Hook = { evidence: {
  pipelinePatches: Array<{ id: string; body: Record<string, unknown> }>;
  accountRequests: Array<Record<string, unknown>>;
  migrationRequests: Array<{ conversationId: string; body: Record<string, unknown> }>;
  loseNextAccountAnswer: boolean;
  storedPipeline: (id: string) => { stages: Array<{ id: string; prompt: string; account?: string | null; effectiveRole: Record<string, unknown> }> } | null;
  setMigration: (pathname: string, migration: Record<string, unknown> | null) => void;
  commitAccountSwitch: (conversationId: string, accountId: string) => void;
} };

async function boardReady(page: Page) {
  await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
  await page.waitForTimeout(700);
}

browserTest("#1695 K6a: account chips and pickers on waiting and running stages, against the prototype", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveEvidenceFixture(OUT);
  const base = `${server.base}?scenario=accounts`;
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const failures: string[] = [];
  const frames: Record<string, { production?: unknown; prototype?: unknown }> = {};
  const flows: Record<string, unknown> = {};
  const notes: string[] = [];

  const production = async (scheme: Scheme, label: string, run: (page: Page) => Promise<void>) => {
    const opened = await openFixture(browser, base, VIEWPORT, scheme);
    try {
      await boardReady(opened.page);
      await run(opened.page);
      if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };
  const prototype = async (query: string, scheme: Scheme, label: string, run: (page: Page) => Promise<void>) => {
    if (!PROTOTYPE) return;
    const opened = await openFixture(browser, `${PROTOTYPE}/?${query}`, VIEWPORT, scheme);
    try {
      await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
      await opened.page.waitForTimeout(700);
      await run(opened.page);
    } catch (error) {
      notes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };
  const shot = (page: Page, side: string, id: string, scheme: Scheme) => page.screenshot({ path: path.join(OUT, `${side}-k6a-${id}-${scheme}.png`) });
  const hook = <T,>(page: Page, run: (evidence: Hook["evidence"]) => T) => page.evaluate(`(${run.toString()})(window.evidence)`) as Promise<T>;
  const openVerify = async (page: Page) => {
    await page.locator(`${card("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.click(`${card("t-search")} .psummary [data-stage="verify"]`);
    await page.waitForSelector(VERIFY_CHIP, { timeout: 10_000 });
    await page.waitForTimeout(300);
  };
  const openPicker = async (page: Page, chip: string) => {
    await page.click(chip);
    await page.waitForSelector(".popover.acct-pop .acct-row", { timeout: 5_000 });
    await page.waitForTimeout(400);
  };
  const closePicker = async (page: Page) => {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".popover.acct-pop", { state: "detached", timeout: 5_000 });
  };
  const receipts = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-kanban-receipt] .msg")].map((node) => node.textContent ?? ""));

  try {
    for (const scheme of ["light", "dark"] as const) {
      await production(scheme, `conversation picker ${scheme}`, async (page) => {
        await openVerify(page);
        await openPicker(page, VERIFY_CHIP);
        const measure = await measurePicker(page, VERIFY_CHIP);
        await shot(page, "production", "account-picker", scheme);
        frames[`account-picker-${scheme}`] = { production: measure };
        if (!measure) return void failures.push(`conversation picker ${scheme}: the picker did not open`);
        if (measure.head !== "Account · Verifier · Claude") failures.push(`conversation picker ${scheme}: head ${measure.head}`);
        if (JSON.stringify(measure.now.slice(0, 2)) !== JSON.stringify([["Current turn on", "Account A · Max · 72% of 5h"], ["Stage setting", "Project's choice"]])) failures.push(`conversation picker ${scheme}: summary ${JSON.stringify(measure.now)}`);
        const tags = measure.rows.map((row) => [row.name, row.tag, row.checked, row.disabled]);
        if (JSON.stringify(tags.slice(0, 3)) !== JSON.stringify([["Account A · Max", "current", true, false], ["Account C · Max", "", false, false], ["Account G · Pro", "outside this project's accounts", false, false]])) failures.push(`conversation picker ${scheme}: rows ${JSON.stringify(tags)}`);
        if (!/^limit · resets \d/.test(measure.rows[3]?.tag ?? "")) failures.push(`conversation picker ${scheme}: limited row ${JSON.stringify(measure.rows[3])}`);
        if (!measure.notes.some((note) => note.startsWith("The running turn is never interrupted."))) failures.push(`conversation picker ${scheme}: notes ${JSON.stringify(measure.notes)}`);
      });
      await prototype("readers=c-search-ver-2&scrollto=t-search&seat=collapsed", scheme, `prototype conversation picker ${scheme}`, async (page) => {
        await page.click('[data-account-trigger="c-search-ver-2"]');
        await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
        await page.waitForTimeout(250);
        const measure = await measurePicker(page, '[data-account-trigger="c-search-ver-2"]');
        await shot(page, "prototype", "account-picker", scheme);
        frames[`account-picker-${scheme}`] = { ...frames[`account-picker-${scheme}`], prototype: measure };
      });
    }

    await production("light", "stage picker", async (page) => {
      await page.locator(`${card("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.click(`${card("t-links")} .psummary [data-stage="review"]`);
      await page.waitForSelector(LINKS_REVIEW_CHIP, { timeout: 10_000 });
      await openPicker(page, LINKS_REVIEW_CHIP);
      const before = await measurePicker(page, LINKS_REVIEW_CHIP);
      await shot(page, "production", "account-stage", "light");
      const stored = await hook(page, (evidence) => evidence.storedPipeline("p-links")?.stages.find((entry) => entry.id === "review") ?? null);
      /* The binding refuses it for a stage: nothing is sent. */
      await page.$eval('.popover.acct-pop .acct-row[data-account="account-g"]', (element) => (element as HTMLElement).click());
      await page.waitForTimeout(300);
      const refusedPatches = await hook(page, (evidence) => evidence.pipelinePatches.length);
      await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
      await page.waitForTimeout(1_200);
      const patches = await hook(page, (evidence) => evidence.pipelinePatches);
      const after = await hook(page, (evidence) => evidence.storedPipeline("p-links")?.stages.find((entry) => entry.id === "review") ?? null);
      const chip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", LINKS_REVIEW_CHIP);
      frames["account-stage"] = { production: before };
      flows.stageAccount = { before, refusedPatches, patches, stored: { prompt: stored?.prompt, account: stored?.account ?? null }, after: { prompt: after?.prompt, account: after?.account ?? null }, chip, receipts: await receipts(page) };
      if (!before || before.rows[0]?.name !== "Project's choice" || !before.rows[0].checked) failures.push(`stage picker: first row ${JSON.stringify(before?.rows[0])}`);
      if (before?.rows.find((row) => row.name === "Account G · Pro")?.disabled !== true) failures.push(`stage picker: a refused account is selectable ${JSON.stringify(before?.rows)}`);
      if (!before?.notes.some((note) => note.startsWith("Applies from the stage's first turn."))) failures.push(`stage picker: notes ${JSON.stringify(before?.notes)}`);
      if (refusedPatches !== 0) failures.push(`stage picker: a refused account sent ${refusedPatches} writes`);
      const body = patches.at(-1)?.body ?? null;
      if (patches.length !== 1 || !body || JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(["account", "action", "expectedStageDigest", "stageId"]) || body.account !== "account-c" || body.stageId !== "review" || typeof body.expectedStageDigest !== "string") failures.push(`stage picker: writes ${JSON.stringify(patches)}`);
      if (after?.account !== "account-c" || after?.prompt !== stored?.prompt || JSON.stringify(after?.effectiveRole) !== JSON.stringify(stored?.effectiveRole)) failures.push(`stage picker: stored stage ${JSON.stringify({ stored, after })}`);
      if (chip !== "Account C") failures.push(`stage picker: chip ${chip}`);
    });
    await prototype("stage=t-links:review", "light", "prototype stage picker", async (page) => {
      await page.click('[data-account-trigger^="draft:"]');
      await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
      await page.waitForTimeout(250);
      const measure = await measurePicker(page, '[data-account-trigger^="draft:"]');
      await shot(page, "prototype", "account-stage", "light");
      frames["account-stage"] = { ...frames["account-stage"], prototype: measure };
    });

    for (const scheme of ["light", "dark"] as const) {
      await production(scheme, `pending switch ${scheme}`, async (page) => {
        await openVerify(page);
        await openPicker(page, VERIFY_CHIP);
        await page.click('.popover.acct-pop .acct-row[data-account="account-g"]');
        await page.waitForTimeout(800);
        await openPicker(page, VERIFY_CHIP);
        const pending = await measurePicker(page, VERIFY_CHIP);
        await shot(page, "production", "account-pending", scheme);
        frames[`account-pending-${scheme}`] = { production: pending };
        if (scheme === "dark") return;
        await closePicker(page);
        /* It waits: nothing is resent while the turn runs. */
        await page.waitForTimeout(1_500);
        const requests = await hook(page, (evidence) => evidence.accountRequests);
        const waiting = await receipts(page);
        /* Change: the queued switch is withdrawn by its operation before the new account is asked for. */
        await openPicker(page, VERIFY_CHIP);
        await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
        await page.waitForTimeout(1_500);
        const migrationRequests = await hook(page, (evidence) => evidence.migrationRequests);
        const changedRequests = await hook(page, (evidence) => evidence.accountRequests);
        const changedChip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
        await hook(page, (evidence) => evidence.commitAccountSwitch("conversation_search-ver-2", "account-c"));
        await page.waitForTimeout(1_500);
        const committed = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
        flows.conversationSwitch = { pending, requests, waiting, migrationRequests, changedRequests, changedChip, committed, receipts: await receipts(page) };
        if (!pending || !pending.chip.pending || pending.chip.when !== "after this turn") failures.push(`pending switch: chip ${JSON.stringify(pending?.chip)}`);
        if (JSON.stringify(pending?.now.at(-1)) !== JSON.stringify(["Pending", "Account G · waits for the current turn to end"])) failures.push(`pending switch: summary ${JSON.stringify(pending?.now)}`);
        if (!pending?.cancel || pending.label !== "Change the pending account" || pending.rows.filter((row) => !row.disabled).length < 3) failures.push(`pending switch: Cancel and Change ${JSON.stringify({ cancel: pending?.cancel, label: pending?.label, rows: pending?.rows })}`);
        if (!pending?.notes.some((note) => note.startsWith("Known to this page only."))) failures.push(`pending switch: notes ${JSON.stringify(pending?.notes)}`);
        if (requests.length !== 1 || requests[0]?.action !== "reconfigure" || requests[0]?.accountId !== "account-g" || requests[0]?.conversationId !== "conversation_search-ver-2") failures.push(`pending switch: requests ${JSON.stringify(requests)}`);
        if (!waiting.includes("Account G is outside this project's accounts; the switch is recorded as your choice") || waiting.some((line) => line.includes("now runs on"))) failures.push(`pending switch: receipts ${JSON.stringify(waiting)}`);
        if (JSON.stringify(migrationRequests.map((entry) => entry.body)) !== JSON.stringify([{ action: "withdraw", operationId: "account-switch-1" }]) || changedRequests.length !== 2 || changedRequests[1]?.accountId !== "account-c") failures.push(`change: ${JSON.stringify({ migrationRequests, changedRequests })}`);
        if (!changedChip.includes("Account C")) failures.push(`change: chip ${changedChip}`);
        if (committed !== "Account C" || !(flows.conversationSwitch as { receipts: string[] }).receipts.includes("Verifier now runs on Account C")) failures.push(`change: after commit ${committed} ${JSON.stringify((flows.conversationSwitch as { receipts: string[] }).receipts)}`);
      });
    }
    await prototype("readers=c-search-ver-2&scrollto=t-search&seat=collapsed", "light", "prototype pending switch", async (page) => {
      await page.evaluate(() => {
        const proto = (window as unknown as { __proto: { state: { switches: Map<string, unknown> }; render: () => void } }).__proto;
        proto.state.switches.set("c-search-ver-2", { to: "Account G", phase: "waiting-turn", requestedAt: "14:05" });
        proto.render();
      });
      await page.click('[data-account-trigger="c-search-ver-2"]');
      await page.waitForSelector(".popover.acct-pop", { timeout: 5_000 });
      await page.waitForTimeout(250);
      const measure = await measurePicker(page, '[data-account-trigger="c-search-ver-2"]');
      await shot(page, "prototype", "account-pending", "light");
      frames["account-pending-light"] = { ...frames["account-pending-light"], prototype: measure };
    });

    await production("light", "recorded and lost switches", async (page) => {
      await openVerify(page);
      await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", { intentId: "intent-1", trigger: "manual", phase: "waiting-turn", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 2 }));
      await page.waitForTimeout(1_500);
      await openPicker(page, VERIFY_CHIP);
      const recorded = await measurePicker(page, VERIFY_CHIP);
      const source = await page.evaluate(() => document.querySelector(".popover.acct-pop [data-account-pending]")?.getAttribute("data-account-source") ?? null);
      await shot(page, "production", "account-recorded", "light");
      /* Cancel by the record's revision; the fixture's route rolls the switch back. */
      await page.click(".popover.acct-pop [data-account-cancel]");
      await page.waitForTimeout(1_500);
      const cancelRequests = await hook(page, (evidence) => evidence.migrationRequests);
      const cancelledChip = await page.evaluate((selector) => document.querySelector(selector)?.textContent?.trim() ?? "", VERIFY_CHIP);
      /* A switch past waiting for its turn offers neither Cancel nor Change. */
      await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", { intentId: "intent-2", trigger: "manual", phase: "preparing", targetAccountId: "account-c", targetLabel: "account-c", failure: null, revision: 3 }));
      await page.waitForTimeout(1_500);
      await openPicker(page, VERIFY_CHIP);
      const started = await measurePicker(page, VERIFY_CHIP);
      await closePicker(page);
      await hook(page, (evidence) => evidence.setMigration("conversation_search-ver-2", null));
      await page.waitForTimeout(1_500);
      await hook(page, (evidence) => { evidence.loseNextAccountAnswer = true; });
      await openPicker(page, VERIFY_CHIP);
      await page.click('.popover.acct-pop .acct-row[data-account="account-c"]');
      await page.waitForTimeout(1_500);
      const lost = await page.evaluate((selector) => document.querySelector(selector)?.querySelector(".when")?.textContent ?? null, VERIFY_CHIP);
      const requests = await hook(page, (evidence) => evidence.accountRequests.length);
      flows.recordedAndLost = { recorded, source, cancelRequests, cancelledChip, started, lost, requests, receipts: await receipts(page) };
      if (!recorded?.chip.pending || source !== "record" || !recorded.notes.includes("Messages sent now are held and delivered after the switch, in the order they were sent. Cancel delivers them on the current account instead.") || !recorded.notes.includes("Not carried: a message bound to the current turn, injected context, or attachments only the sending browser holds. Each ends failed with its reason, keeps the text the Viewer holds for it, and its receipt says whether sending it again is safe.") || !recorded.cancel) failures.push(`recorded switch: ${JSON.stringify({ recorded, source })}`);
      if (JSON.stringify(cancelRequests.map((entry) => entry.body)) !== JSON.stringify([{ action: "cancel", expectedRevision: 2 }]) || cancelledChip !== "Account A") failures.push(`cancel: ${JSON.stringify({ cancelRequests, cancelledChip })}`);
      if (!started || started.cancel || !started.rows.every((row) => row.disabled) || !started.notes.includes("Too late to cancel: the switch has started.")) failures.push(`started switch: ${JSON.stringify(started)}`);
      if (lost !== "not confirmed" || requests !== 1) failures.push(`lost switch: ${JSON.stringify({ lost, requests })}`);
    });
  } finally {
    await browser.close();
    server.stop();
  }

  const comparison: Record<string, unknown> = {};
  if (PROTOTYPE) {
    for (const key of ["account-picker-light", "account-picker-dark", "account-stage", "account-pending-light"]) {
      const frame = frames[key] as { production?: PickerMeasure | null; prototype?: PickerMeasure | null } | undefined;
      if (!frame?.production || !frame.prototype) {
        failures.push(`${key}: the prototype frame was not measured`);
        continue;
      }
      const { production: ours, prototype: theirs } = frame;
      comparison[key] = {
        width: [ours.width, theirs.width],
        summaryKeys: [ours.now.map(([k]) => k), theirs.now.map(([k]) => k)],
        label: [ours.label, theirs.label],
        rows: [ours.rows.length, theirs.rows.length],
        meters: [ours.rows.filter((row) => row.meter).length, theirs.rows.filter((row) => row.meter).length],
        pendingChip: [ours.chip.pending, theirs.chip.pending],
        cancel: [ours.cancel, theirs.cancel],
      };
      if (Math.abs(ours.width - theirs.width) > 2) failures.push(`${key}: picker width ${ours.width}, prototype ${theirs.width}`);
      if (ours.now[0]?.[0] !== theirs.now[0]?.[0]) failures.push(`${key}: summary ${JSON.stringify(comparison[key])}`);
      if (ours.chip.pending !== theirs.chip.pending) failures.push(`${key}: chip ${JSON.stringify(comparison[key])}`);
      if (ours.cancel !== theirs.cancel) failures.push(`${key}: Cancel ${JSON.stringify(comparison[key])}`);
    }
  }
  if (PROTOTYPE && notes.length) failures.push(...notes.map((note) => `prototype not driven: ${note}`));
  fs.writeFileSync(path.join(EVIDENCE, "k6.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), frames, comparison, flows, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 900_000);
