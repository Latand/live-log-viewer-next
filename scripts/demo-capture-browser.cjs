const fs = require("node:fs");
const path = require("node:path");

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

function normalizedText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function assertPixelMetrics(metrics, limits, shotId) {
  if (metrics.nearBlackRatio > limits.maxNearBlackRatio) {
    throw new Error(`${shotId} has ${(metrics.nearBlackRatio * 100).toFixed(2)}% near-black pixels`);
  }
  if (metrics.maxTileNearBlackRatio > limits.maxTileNearBlackRatio) {
    throw new Error(
      `${shotId} has ${(metrics.maxTileNearBlackRatio * 100).toFixed(2)}% near-black tile at ${metrics.maxTile.column},${metrics.maxTile.row}`,
    );
  }
  if (metrics.nonWhiteRatio < limits.minNonWhiteRatio) {
    throw new Error(`${shotId} has only ${(metrics.nonWhiteRatio * 100).toFixed(2)}% non-white pixels`);
  }
  if (metrics.colorCount < limits.minColorCount) {
    throw new Error(`${shotId} has only ${metrics.colorCount} quantized colors`);
  }
}

function measurePixelMetrics(data, width, height, tileSize) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error("pixel dimensions must be positive integers");
  }
  if (!Number.isInteger(tileSize) || tileSize <= 0) throw new Error("pixel tile size must be a positive integer");
  if (data.length !== width * height * 3) throw new Error("pixel buffer length does not match its dimensions");

  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  const tileNearBlack = new Uint32Array(columns * rows);
  const tilePixels = new Uint32Array(columns * rows);
  let nearBlack = 0;
  let nonWhite = 0;
  const colors = new Set();
  for (let y = 0; y < height; y += 1) {
    const tileRow = Math.floor(y / tileSize);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const tileIndex = tileRow * columns + Math.floor(x / tileSize);
      tilePixels[tileIndex] += 1;
      if (red < 12 && green < 12 && blue < 12) {
        nearBlack += 1;
        tileNearBlack[tileIndex] += 1;
      }
      if (red < 248 || green < 248 || blue < 248) nonWhite += 1;
      colors.add(`${red >> 4},${green >> 4},${blue >> 4}`);
    }
  }

  let maxTileIndex = 0;
  let maxTileNearBlackRatio = 0;
  for (let index = 0; index < tilePixels.length; index += 1) {
    const ratio = tileNearBlack[index] / tilePixels[index];
    if (ratio > maxTileNearBlackRatio) {
      maxTileIndex = index;
      maxTileNearBlackRatio = ratio;
    }
  }
  const column = maxTileIndex % columns;
  const row = Math.floor(maxTileIndex / columns);
  const pixels = width * height;
  return {
    nearBlackRatio: nearBlack / pixels,
    nonWhiteRatio: nonWhite / pixels,
    colorCount: colors.size,
    maxTileNearBlackRatio,
    maxTile: { column, row },
  };
}

function inspectVisibleElements(frame, includeFailures) {
  const problems = [];
  for (const expected of frame.visible) {
    const candidates = Array.from(document.querySelectorAll(expected.selector));
    const element = candidates
      .filter((candidate) => (candidate.innerText || "").includes(expected.text))
      .sort((left, right) => {
        const leftBox = left.getBoundingClientRect();
        const rightBox = right.getBoundingClientRect();
        return rightBox.width * rightBox.height - leftBox.width * leftBox.height;
      })[0];
    if (!(element instanceof HTMLElement)) {
      problems.push(`missing ${expected.selector} containing ${JSON.stringify(expected.text)}`);
      continue;
    }
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const rendered = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    if (!rendered) problems.push(`${expected.selector} containing ${JSON.stringify(expected.text)} is hidden`);
    if (box.width < expected.minWidth || box.height < expected.minHeight) {
      problems.push(
        `${expected.selector} containing ${JSON.stringify(expected.text)} is ${box.width.toFixed(1)}x${box.height.toFixed(1)}`,
      );
    }
    if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) {
      problems.push(`${expected.selector} containing ${JSON.stringify(expected.text)} leaves the viewport`);
    }
  }
  for (const text of frame.absentText) {
    if (document.body.innerText.includes(text)) problems.push(`unexpected text ${JSON.stringify(text)}`);
  }
  return includeFailures ? problems : problems.length === 0;
}

async function assertVisibleElements(page, shot) {
  const failures = await page.evaluate(inspectVisibleElements, shot.frame, true);
  if (failures.length) throw new Error(`${shot.id} final element assertions failed:\n${failures.join("\n")}`);
}

async function waitForVisibleElements(page, shot) {
  try {
    await page.waitForFunction(
      inspectVisibleElements,
      { polling: "raf", timeout: 30_000 },
      shot.frame,
      false,
    );
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  } catch (error) {
    const failures = await page.evaluate(inspectVisibleElements, shot.frame, true);
    throw new Error(`${shot.id} readiness timed out:\n${failures.join("\n")}`, { cause: error });
  }
}

async function assertPngFrame(png, shot) {
  const sharp = require("sharp");
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== shot.viewport.width || info.height !== shot.viewport.height || info.channels !== 3) {
    throw new Error(`${shot.id} PNG dimensions are ${info.width}x${info.height}x${info.channels}`);
  }
  const metrics = measurePixelMetrics(data, info.width, info.height, shot.frame.pixels.tileSize);
  assertPixelMetrics(metrics, shot.frame.pixels, shot.id);
  return metrics;
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
    button[aria-label^="Copy"],
    button[aria-label^="Read answer"],
    button[aria-label="Enable sound notifications"] { opacity: 0 !important; }
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
    // The compact scheme card renders the same transcript in miniature, so the
    // command group must be toggled inside the expanded dialog specifically.
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('[role="dialog"] summary')).some((summary) => summary.innerText.includes("2 actions")),
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      const actions = Array.from(document.querySelectorAll('[role="dialog"] summary')).find((summary) => summary.innerText.includes("2 actions"));
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
  await waitForVisibleElements(page, shot);
  const text = await page.evaluate(() => document.body.innerText);
  try {
    await assertVisibleElements(page, shot);
  } catch (error) {
    if (process.env.DEMO_CAPTURE_DEBUG) {
      fs.writeFileSync(path.join(config.outputDir, `debug-${shot.id}.png`), Buffer.from(await page.screenshot({ type: "png" })));
    }
    throw error;
  }
  const png = capturePng ? Buffer.from(await page.screenshot({ type: "png" })) : null;
  const pixelMetrics = png ? await assertPngFrame(png, shot) : null;
  await page.close();
  return { text, png, pixelMetrics };
}

async function main() {
  const puppeteer = require("puppeteer");
  const config = JSON.parse(fs.readFileSync(arg("--config"), "utf8"));
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none", "--no-sandbox"],
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
      const metrics = first.pixelMetrics;
      process.stdout.write(
        `${shot.output} ${first.png.length} bytes, ${(metrics.nearBlackRatio * 100).toFixed(2)}% near-black, ${metrics.colorCount} colors\n`,
      );
    }
  } finally {
    await browser.close();
  }
}

module.exports = { assertPixelMetrics, measurePixelMetrics, waitForVisibleElements };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
