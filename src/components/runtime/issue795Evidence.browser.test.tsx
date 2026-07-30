import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { chromium, type Browser } from "playwright-core";

import { setLocale } from "@/lib/i18n";
import { planBridgeReportDelivery } from "@/lib/runtime/bridgeDelivery";
import type { ToolEvent } from "@/components/feed/parse";

import { McpCallCard } from "./McpCallCard";

/**
 * Browser-rendered evidence for issue #795: what the operator actually sees
 * and hears around a deploy carries NO commit hash and NO hash-bound ask.
 *
 *  - The deploy feed card names the release by its short form; the full
 *    40-hex revision stays in machine payloads and the ledger.
 *  - The gateway's script for a (legacy) confirmation explicitly forbids
 *    reading the hash aloud or asking the operator to repeat anything; the
 *    machine trailer stays a machine string, marked as not for the user's
 *    ears, while remaining intact so the authorization still consumes.
 *
 * Captured with the real production CSS at desktop and 390px. Synthetic
 * fixture SHAs only — no real repository state.
 */

const EVIDENCE_DIR = path.join(process.cwd(), "evidence", "issue-795");
const CSS_DIR = path.join(process.cwd(), ".next", "static", "css");

function productionCss(): string {
  const files = fs.existsSync(CSS_DIR) ? fs.readdirSync(CSS_DIR).filter((name) => name.endsWith(".css")) : [];
  return files.map((name) => fs.readFileSync(path.join(CSS_DIR, name), "utf8")).join("\n");
}

const dom = new Window({ url: "http://localhost/" });
installActEnv();
let mobile = false;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: undefined,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(dom as unknown as { matchMedia(q: string): unknown }).matchMedia = (q: string) => ({
  matches: q.includes("max-width: 767px") ? mobile : q.includes("pointer: coarse") ? mobile : false,
  media: q,
  addEventListener() {},
  removeEventListener() {},
});

let browser: Browser;

beforeEach(() => {
  setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  mobile = false;
});
afterAll(async () => {
  await browser?.close();
});

/* Synthetic fixture revision — deliberately not any real commit. */
const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
const NONCE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function deployToolEvent(): ToolEvent {
  return {
    kind: "tool",
    id: "tool-795-deploy",
    ts: "2100-01-02T12:00:00.000Z",
    srcCall: 1,
    family: "mcp",
    tool: "deploy_exact_sha",
    icon: "wrench",
    summary: "deploy_exact_sha",
    chips: [],
    status: "success",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    mcp: {
      serverName: "viewer",
      toolName: "deploy_exact_sha",
      args: { revision: SHA, confirm: "deploy", bridgeRef: 7, bridgeNonce: NONCE },
      result: { deploymentId: "deployment_795", revision: SHA, state: "accepted", replayed: false },
    },
  } as unknown as ToolEvent;
}

/** The gateway's script for a legacy manager-minted confirmation, produced by
    the REAL delivery planner over a real batch shape. */
function gatewayScript(): string {
  const plan = planBridgeReportDelivery({
    batch: {
      reports: [{
        id: "rpt_evidence",
        seq: 7,
        at: "2100-01-02T12:00:00.000Z",
        class: "confirmation_request",
        body: "gates green, ready to ship",
        confirmation: { sha: SHA, nonce: NONCE, expiresAt: "2100-01-02T12:10:00.000Z" },
      }],
      throughSeq: 7,
      remaining: 0,
      gap: null,
    },
    now: new Date("2100-01-02T12:00:30.000Z"),
    lastBatchAt: null,
  });
  if (plan.kind !== "deliver") throw new Error("expected a delivery");
  return plan.delivery.responses.map((response) => response.text).join("\n");
}

async function renderWindow(node: React.ReactElement): Promise<string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

const CSS = productionCss();

function pageHtml(inner: string, width: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
    html,body{margin:0;padding:0;background:var(--color-canvas,#fff);}
    #evidence-host{display:flex;flex-direction:column;gap:16px;width:${width}px;min-height:100vh;padding:16px;box-sizing:border-box;}
    .script{white-space:pre-wrap;font:12px/1.5 var(--font-mono,monospace);border:1px solid #d0d4da;border-radius:8px;padding:12px;}
    .label{font:600 13px/1.2 var(--font-sans,sans-serif);opacity:.7;}
    </style></head><body><div id="evidence-host">${inner}</div></body></html>`;
}

interface Geometry {
  scrollWidth: number;
  viewportWidth: number;
  fullShaInCardText: boolean;
  shortReleaseShown: boolean;
  hashAloudForbidden: boolean;
  userConfirmationForbidden: boolean;
  legacyCommitPhraseGone: boolean;
  trailerStillMachineReadable: boolean;
}

const VIEWPORTS = [
  { id: "desktop", mobile: false, width: 1280, height: 900 },
  { id: "mobile-390", mobile: true, width: 390, height: 844 },
];

test("issue 795 evidence: no commit hash reaches the operator's eyes or ears around a deploy", async () => {
  expect(CSS.length).toBeGreaterThan(10_000);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromium.executablePath() });
  const manifest: Record<string, Geometry> = {};
  const script = gatewayScript();

  for (const viewport of VIEWPORTS) {
    mobile = viewport.mobile;
    const card = await renderWindow(<McpCallCard event={deployToolEvent()} />);
    const inner = [
      `<div class="label">Deploy feed card — the release is named short; the exact revision stays machine-side</div>`,
      `<div data-evidence="card">${card}</div>`,
      `<div class="label">Gateway script for a legacy authorization row — the user is never asked to confirm; the hash is never voiced</div>`,
      `<div class="script" data-evidence="script"></div>`,
    ].join("");

    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
    await page.setContent(pageHtml(inner, viewport.width), { waitUntil: "load" });
    await page.evaluate((text) => {
      document.querySelector('[data-evidence="script"]')!.textContent = text;
    }, script);
    const key = `deploy-journey-${viewport.id}`;
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${key}.html`), pageHtml(inner, viewport.width));
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${key}.png`), fullPage: true });

    const geometry = await page.evaluate(({ sha }) => {
      /* The operator-visible row is the summary line; the full revision stays
         behind the quiet Details disclosure as machine/audit payload. */
      const cardText = document.querySelector('[data-evidence="card"] summary')?.textContent ?? "";
      const scriptText = document.querySelector('[data-evidence="script"]')?.textContent ?? "";
      return {
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        fullShaInCardText: cardText.includes(sha),
        shortReleaseShown: cardText.includes(`Deploying release ${sha.slice(0, 12)}`),
        hashAloudForbidden: scriptText.includes("Never read the commit hash aloud"),
        userConfirmationForbidden: scriptText.includes("Do NOT ask the user for confirmation or approval"),
        legacyCommitPhraseGone: !scriptText.includes(`requested for commit ${sha}`),
        trailerStillMachineReadable: scriptText.includes(`[bridge ref=7 nonce=`),
      } as Geometry;
    }, { sha: SHA });
    await page.close();
    manifest[key] = geometry;

    expect(geometry.fullShaInCardText).toBe(false);
    expect(geometry.shortReleaseShown).toBe(true);
    expect(geometry.hashAloudForbidden).toBe(true);
    expect(geometry.userConfirmationForbidden).toBe(true);
    expect(geometry.legacyCommitPhraseGone).toBe(true);
    expect(geometry.trailerStillMachineReadable).toBe(true);
  }

  fs.writeFileSync(path.join(EVIDENCE_DIR, "geometry.json"), JSON.stringify(manifest, null, 2));
});
