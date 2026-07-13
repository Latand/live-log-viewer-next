/**
 * Storyboard executor for the stage B motion capture. Runs inside the pinned
 * mcp/puppeteer image: plays each storyboard from the motion config with a
 * synthetic cursor driven by real CDP input events (so hover states are
 * genuine), shows captions and brand cards, records frames over CDP
 * screencast, and gates sampled frames with the stage A pixel checks. Host
 * actions (fixture transcript appends) are requested through /motion/sync and
 * performed by the bun runner on the host.
 */
const fs = require("node:fs");
const path = require("node:path");

const { assertPixelMetrics, measurePixelMetrics } = require("./demo-capture-browser.cjs");

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Deterministic human-ish keystroke cadence. */
const TYPE_DELAYS = [34, 21, 46, 28, 19, 39, 24, 31];

const OVERLAY_INIT = `(() => {
  if (window.__motionReady) return;
  window.__motionReady = true;
  const install = () => {
    if (!document.body || document.getElementById("__motion-cursor")) return;
    const style = document.createElement("style");
    style.textContent = [
      "#__motion-cursor { position: fixed; left: 0; top: 0; z-index: 2147483646; pointer-events: none; width: 24px; height: 24px; transition: none; }",
      "#__motion-caption { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(8px); z-index: 2147483645; pointer-events: none;",
      "  background: rgba(17, 24, 39, 0.85); color: #f9fafb; font: 500 17px/1.4 system-ui, sans-serif; letter-spacing: 0.01em;",
      "  padding: 9px 18px; border-radius: 999px; opacity: 0; transition: opacity 260ms ease, transform 260ms ease; max-width: 82vw; text-align: center; white-space: nowrap; }",
      "#__motion-caption.on { opacity: 1; transform: translateX(-50%) translateY(0); }",
      "#__motion-card { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;",
      "  background: rgba(250, 250, 252, 0.96); backdrop-filter: blur(8px); opacity: 0; transition: opacity 340ms ease; font-family: system-ui, sans-serif; }",
      "#__motion-card.on { opacity: 1; }",
      "#__motion-card .t { font-size: 54px; font-weight: 750; letter-spacing: -0.025em; color: #111827; }",
      "#__motion-card .s { font-size: 21px; color: #52525b; max-width: 640px; text-align: center; }",
      "#__motion-card .n { margin-top: 14px; font: 500 17px/1 ui-monospace, monospace; color: #3f3f46; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 10px; padding: 10px 18px; }",
      "[data-capture-volatile=\\"pid\\"] { display: none !important; }",
      "nextjs-portal { display: none !important; }",
    ].join("\\n");
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "__motion-cursor";
    cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5.5 3.2 19.2 13.1l-6.3 1.1 3.4 6.2-2.6 1.4-3.4-6.3-4.8 4.2z" fill="#111827" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    cursor.style.transform = "translate(-40px, -40px)";
    document.body.appendChild(cursor);
    const caption = document.createElement("div");
    caption.id = "__motion-caption";
    document.body.appendChild(caption);
    document.addEventListener("mousemove", (event) => {
      cursor.style.transform = "translate(" + event.clientX + "px, " + event.clientY + "px)";
    }, true);
    document.addEventListener("mousedown", (event) => {
      const ripple = document.createElement("div");
      ripple.style.cssText = "position: fixed; z-index: 2147483644; pointer-events: none; width: 36px; height: 36px; border-radius: 999px;"
        + "border: 2.5px solid rgba(59, 130, 246, 0.85); left: " + (event.clientX - 18) + "px; top: " + (event.clientY - 18) + "px;";
      document.body.appendChild(ripple);
      ripple.animate(
        [{ transform: "scale(0.35)", opacity: 0.9 }, { transform: "scale(1.25)", opacity: 0 }],
        { duration: 420, easing: "ease-out" },
      ).onfinish = () => ripple.remove();
    }, true);
    window.__motionCaption = (text) => {
      if (!text) { caption.classList.remove("on"); return; }
      caption.textContent = text;
      caption.classList.add("on");
    };
    window.__motionCard = (card) => {
      let node = document.getElementById("__motion-card");
      if (!card) { if (node) node.classList.remove("on"); return; }
      if (!node) {
        node = document.createElement("div");
        node.id = "__motion-card";
        document.body.appendChild(node);
      }
      node.innerHTML = "";
      for (const [cls, value] of [["t", card.title], ["s", card.subtitle], ["n", card.note]]) {
        if (!value) continue;
        const row = document.createElement("div");
        row.className = cls;
        row.textContent = value;
        node.appendChild(row);
      }
      requestAnimationFrame(() => node.classList.add("on"));
    };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();`;

async function installDeterministicPage(page, fixedIso) {
  // The page clock sits slightly after fixture time so records appended
  // mid-recording still land in the past and age chips stay positive.
  const fixedMs = Date.parse(fixedIso) + 10_000;
  await page.evaluateOnNewDocument((captureTime) => {
    const NativeDate = Date;
    class CaptureDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [captureTime]));
      }
      static now() { return captureTime; }
    }
    Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("llv_lang", "en");
    localStorage.setItem("llvSound", "0");
  }, fixedMs);
  await page.evaluateOnNewDocument(OVERLAY_INIT);
}

class Recorder {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.client = null;
    this.pending = Promise.resolve();
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.client = await this.page.createCDPSession();
    this.client.on("Page.screencastFrame", (event) => {
      const frameNumber = this.frames.length;
      const file = `frame-${String(frameNumber).padStart(4, "0")}.png`;
      this.frames.push({ file, ts: event.metadata.timestamp });
      this.pending = this.pending.then(() => {
        fs.writeFileSync(path.join(this.dir, file), Buffer.from(event.data, "base64"));
      });
      this.client.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    });
    await this.client.send("Page.startScreencast", { format: "png", everyNthFrame: 2 });
  }

  async stop(tailHoldSeconds) {
    await this.client.send("Page.stopScreencast");
    await this.pending;
    const endTs = (this.frames.at(-1)?.ts ?? 0) + tailHoldSeconds;
    fs.writeFileSync(
      path.join(this.dir, "frames.json"),
      `${JSON.stringify({ frames: this.frames, endTs }, null, 2)}\n`,
      "utf8",
    );
    await this.client.detach().catch(() => {});
    return this.frames.length;
  }
}

async function findTarget(page, target, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate((query) => {
      const candidates = Array.from(document.querySelectorAll(query.selector))
        .filter((element) => !query.text || (element.innerText || element.value || "").includes(query.text))
        .map((element) => ({ element, box: element.getBoundingClientRect(), style: getComputedStyle(element) }))
        .filter(({ box, style }) => box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0)
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
      const hit = candidates[0];
      if (!hit) return { found: false, count: candidates.length };
      const x = Math.min(Math.max(hit.box.left + hit.box.width / 2, 2), innerWidth - 2);
      const y = Math.min(Math.max(hit.box.top + hit.box.height / 2, 2), innerHeight - 2);
      return { found: true, x, y };
    }, target);
    if (last.found) return last;
    await sleep(200);
  }
  throw new Error(`target not found: ${JSON.stringify(target)}`);
}

class CursorDriver {
  constructor(page) {
    this.page = page;
    this.x = 640;
    this.y = 80;
  }

  async settle() {
    await this.page.mouse.move(this.x, this.y);
  }

  async moveTo(x, y, ms) {
    const duration = Math.max(120, ms ?? 650);
    const steps = Math.max(6, Math.round(duration / 16));
    const from = { x: this.x, y: this.y };
    for (let i = 1; i <= steps; i += 1) {
      const t = easeInOutCubic(i / steps);
      await this.page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await sleep(duration / steps);
    }
    this.x = x;
    this.y = y;
  }
}

function requestCounter() {
  let n = 0;
  return () => { n += 1; return n; };
}

async function runStep(context, step) {
  const { page, cursor, config, board, nextRequestId } = context;
  switch (step.do) {
    case "pause":
      await sleep(step.ms);
      return;
    case "caption":
      await page.evaluate((text) => window.__motionCaption(text), step.text);
      return;
    case "captionHide":
      await page.evaluate(() => window.__motionCaption(null));
      return;
    case "card":
      await page.evaluate((card) => window.__motionCard(card), { title: step.title, subtitle: step.subtitle, note: step.note });
      await sleep(step.ms);
      return;
    case "move": {
      const point = await findTarget(page, step.target);
      await cursor.moveTo(point.x, point.y, step.ms);
      return;
    }
    case "hover": {
      const point = await findTarget(page, step.target);
      await cursor.moveTo(point.x, point.y, step.ms);
      await sleep(step.holdMs ?? 400);
      return;
    }
    case "click": {
      const point = await findTarget(page, step.target);
      if (step.ms !== 0) await cursor.moveTo(point.x, point.y, step.ms);
      else await page.mouse.move(point.x, point.y);
      await sleep(180);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
      await sleep(140);
      return;
    }
    case "type": {
      for (let i = 0; i < step.text.length; i += 1) {
        await page.keyboard.type(step.text[i]);
        await sleep(TYPE_DELAYS[i % TYPE_DELAYS.length]);
      }
      return;
    }
    case "waitText":
      try {
        await page.waitForFunction(
          (needle) => document.body.innerText.includes(needle),
          { timeout: 25_000 },
          step.text,
        );
      } catch (error) {
        const current = await page.evaluate(() => document.body.innerText);
        throw new Error(`${board.id} missed checkpoint ${JSON.stringify(step.text)}\nDiagnostics:\n${context.diagnostics.join("\n")}\nRendered text:\n${current}`, { cause: error });
      }
      return;
    case "waitFor":
      await page.waitForSelector(step.selector, { timeout: 25_000 });
      return;
    case "host": {
      const id = `${board.id}-${nextRequestId()}`;
      const requestPath = path.join(config.motionDir, "sync", `${id}.json`);
      fs.writeFileSync(requestPath, `${JSON.stringify(step.action)}\n`, "utf8");
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(`${requestPath}.done`)) {
        if (Date.now() > deadline) throw new Error(`${board.id} host action timed out: ${id}`);
        await sleep(60);
      }
      return;
    }
    default:
      throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }
}

async function assertSampledFrames(dir, frames, viewport, pixels) {
  const sharp = require("sharp");
  const samples = new Set([0, frames.length - 1]);
  for (let i = 12; i < frames.length; i += 12) samples.add(i);
  for (const index of samples) {
    const frame = frames[index];
    const { data, info } = await sharp(path.join(dir, frame.file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== viewport.width || info.height !== viewport.height || info.channels !== 3) {
      throw new Error(`${frame.file} is ${info.width}x${info.height}x${info.channels}, expected ${viewport.width}x${viewport.height}x3`);
    }
    const metrics = measurePixelMetrics(data, info.width, info.height, pixels.tileSize);
    assertPixelMetrics(metrics, pixels, frame.file);
  }
}

/** Close attention toasts so recordings start on a clean frame. */
async function dismissNotifications(page) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const closed = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label="Close the notification"]'));
      for (const button of buttons) button.click();
      return buttons.length;
    });
    if (closed === 0) return;
    await sleep(250);
  }
  throw new Error("attention toast kept reappearing before the recording");
}

/**
 * The fixture's pending question raises a toast on every load. Wait for it and
 * dismiss it up front — setup clicks would otherwise land on the toast when it
 * overlaps their target.
 */
async function settleInitialToast(page) {
  await page.waitForSelector('button[aria-label="Close the notification"]', { timeout: 6_000 }).catch(() => {});
  await dismissNotifications(page);
}

async function runStoryboard(browser, config, board) {
  const page = await browser.newPage();
  const diagnostics = [];
  page.on("console", (message) => { if (message.type() === "error") diagnostics.push(`console error: ${message.text()}`); });
  page.on("pageerror", (error) => diagnostics.push(`page error: ${error.stack || error.message}`));
  page.on("requestfailed", (request) => diagnostics.push(`request failed ${request.url()}: ${request.failure()?.errorText || "unknown"}`));
  await page.setViewport({ ...config.viewport, deviceScaleFactor: 1 });
  await page.emulateTimezone("UTC");
  await installDeterministicPage(page, config.fixedIso);
  await page.goto(`${config.baseUrl}/`, { waitUntil: "networkidle2", timeout: 60_000 });
  if (board.startHash) await page.evaluate((hash) => { location.hash = hash; }, board.startHash);

  const cursor = new CursorDriver(page);
  await cursor.settle();
  const dir = path.join(config.motionDir, board.id);
  const context = { page, cursor, config, board, diagnostics, nextRequestId: requestCounter() };

  try {
    await settleInitialToast(page);
    for (const step of board.setup) await runStep(context, step);
    await dismissNotifications(page);
    await sleep(500);
    const recorder = new Recorder(page, dir);
    await recorder.start();
    await sleep(150);
    for (const step of board.steps) await runStep(context, step);
    await sleep(200);
    const frameCount = await recorder.stop(0.6);
    if (frameCount < 2) throw new Error(`${board.id} recorded only ${frameCount} frames`);
    const index = JSON.parse(fs.readFileSync(path.join(dir, "frames.json"), "utf8"));
    if (board.pixels) await assertSampledFrames(dir, index.frames, config.viewport, board.pixels);
    process.stdout.write(`${board.id}: ${frameCount} frames over ${(index.endTs - index.frames[0].ts).toFixed(2)}s\n`);
  } catch (error) {
    try {
      fs.writeFileSync(path.join(config.motionDir, `${board.id}-fail.png`), Buffer.from(await page.screenshot({ type: "png" })));
    } catch {
      /* the page may already be unusable */
    }
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const puppeteer = require("puppeteer");
  const config = JSON.parse(fs.readFileSync(arg("--config"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage", "--font-render-hinting=none", "--no-sandbox", `--window-size=${config.viewport.width},${config.viewport.height}`],
  });
  try {
    for (const board of config.storyboards) {
      await runStoryboard(browser, config, board);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
