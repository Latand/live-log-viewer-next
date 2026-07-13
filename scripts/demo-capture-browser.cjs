const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer");

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function normalizedText(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function installDeterministicPage(page, fixedIso) {
  const fixedMs = Date.parse(fixedIso);
  await page.evaluateOnNewDocument((captureTime) => {
    const NativeDate = Date;
    class CaptureDate extends NativeDate {
      constructor(...args) {
        super(...(args.length ? args : [captureTime]));
      }
      static now() { return captureTime; }
    }
    Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("llv_lang", "en");
    localStorage.setItem("llvSound", "0");
  }, fixedMs);
}

function shotHash(shot) {
  if (shot.file) return `#f=${encodeURIComponent(shot.file)}`;
  if (shot.project) return `#p=${encodeURIComponent(shot.project)}`;
  return "";
}

async function render(browser, config, shot, capturePng) {
  const page = await browser.newPage();
  const diagnostics = [];
  page.on("console", (message) => diagnostics.push(`console ${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => diagnostics.push(`page error: ${error.stack || error.message}`));
  page.on("requestfailed", (request) => diagnostics.push(`request failed ${request.url()}: ${request.failure()?.errorText || "unknown"}`));
  page.on("response", (response) => {
    if (response.url().includes("/api/log") || response.status() >= 400) diagnostics.push(`response ${response.status()} ${response.url()}`);
  });
  await page.setViewport({ ...shot.viewport, deviceScaleFactor: 1 });
  await page.emulateTimezone("UTC");
  await installDeterministicPage(page, config.fixedIso);
  await page.goto(`${config.baseUrl}/`, { waitUntil: "networkidle2", timeout: 60_000 });
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-delay: 0s !important;
      animation-duration: 0s !important;
      caret-color: transparent !important;
      content-visibility: visible !important;
      transition-delay: 0s !important;
      transition-duration: 0s !important;
      will-change: auto !important;
    }
    html { scroll-behavior: auto !important; }
    body { cursor: default !important; }
    [data-capture-volatile="pid"] { display: none !important; }
    nextjs-portal { display: none !important; }
  ` });
  const hash = shotHash(shot);
  if (hash) await page.evaluate((nextHash) => { location.hash = nextHash; }, hash);
  if (shot.file) {
    await page.waitForFunction(
      (pathname) => Array.from(document.querySelectorAll("section[data-link-path]"))
        .some((section) => section.getAttribute("data-link-path") === pathname),
      { timeout: 30_000 },
      shot.file,
    );
    await page.evaluate((pathname) => {
      const section = Array.from(document.querySelectorAll("section[data-link-path]"))
        .find((candidate) => candidate.getAttribute("data-link-path") === pathname);
      const expand = Array.from(section?.querySelectorAll("button") ?? [])
        .find((button) => button.getAttribute("aria-label")?.startsWith("Expand "));
      if (!(expand instanceof HTMLElement)) throw new Error(`missing expand control for ${pathname}`);
      expand.click();
    }, shot.file);
  }
  if (shot.id === "chat-feed") {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("summary")).some((summary) => summary.innerText.includes("2 actions")),
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      const actions = Array.from(document.querySelectorAll("summary")).find((summary) => summary.innerText.includes("2 actions"));
      if (!(actions instanceof HTMLElement)) throw new Error("missing command group");
      actions.click();
    });
  }
  try {
    await page.waitForFunction(
      (needles) => needles.every((needle) => document.body.innerText.includes(needle)),
      { timeout: 30_000 },
      shot.stableText,
    );
  } catch (error) {
    const current = await page.evaluate(() => document.body.innerText);
    throw new Error(`${shot.id} missed stable text ${JSON.stringify(shot.stableText)}\nDiagnostics:\n${diagnostics.join("\n")}\nRendered text:\n${current}`, { cause: error });
  }
  if (shot.id !== "overview-board") {
    await page.evaluate(() => {
      const close = document.querySelector('button[aria-label="Close the notification"]');
      if (close instanceof HTMLElement) close.click();
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const text = await page.evaluate(() => document.body.innerText);
  const png = capturePng ? Buffer.from(await page.screenshot({ type: "png" })) : null;
  await page.close();
  return { text, png };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(arg("--config"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage", "--font-render-hinting=none", "--no-sandbox"],
  });
  try {
    for (const shot of config.shots) {
      const first = await render(browser, config, shot, true);
      const second = await render(browser, config, shot, false);
      if (normalizedText(first.text) !== normalizedText(second.text)) {
        throw new Error(`${shot.id} changed between deterministic passes`);
      }
      for (const expected of shot.stableText) {
        if (!first.text.includes(expected)) throw new Error(`${shot.id} is missing stable text: ${expected}`);
      }
      const output = path.join(config.outputDir, shot.output);
      fs.writeFileSync(output, first.png);
      process.stdout.write(`${shot.output} ${first.png.length} bytes\n`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
