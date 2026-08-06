/* Browser side of evidence-crown-capture.ts — runs inside the pinned
   mcp/puppeteer image. Drives the real rail: crown toggles, reload
   durability, create-project happy path, duplicate refusal, uk locale. */
const puppeteer = require("puppeteer");

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const base = arg("--base");
const output = arg("--output");
const manualRoot = arg("--manual-root");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRail(page) {
  await page.waitForSelector("aside nav", { timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll("aside nav [data-flip-key]")].some((el) => /beacon|relay/.test(el.textContent || "")),
    { timeout: 30_000 },
  );
  await sleep(700);
}

async function shot(page, name) {
  await page.screenshot({ path: `${output}/${name}` });
  console.log(`captured ${name}`);
}

async function crown(page, label) {
  await page.evaluate((wanted) => {
    const row = [...document.querySelectorAll("aside nav [data-flip-key]")]
      .find((el) => (el.textContent || "").includes(wanted));
    if (!row) throw new Error(`no rail row for ${wanted}`);
    const toggle = row.querySelector("button[aria-pressed]");
    if (!toggle) throw new Error(`no crown toggle for ${wanted}`);
    toggle.click();
  }, label);
  await sleep(900);
}

async function railOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("aside nav [data-flip-key]")]
      .filter((el) => el.getAttribute("data-flip-key") !== "__crown-divider__")
      .map((el) => ({
        key: el.getAttribute("data-flip-key"),
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
        crowned: Boolean(el.querySelector('[data-testid="crown-marker"]')),
      })),
  );
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 2 });
  /* This headless shell reports `hover: none`, which would disable Tailwind's
     `@media (hover: hover)`-gated reveals that every real desktop gets. */
  try {
    await page.emulateMediaFeatures([
      { name: "hover", value: "hover" },
      { name: "any-hover", value: "hover" },
      { name: "pointer", value: "fine" },
    ]);
  } catch (error) {
    console.warn("media feature emulation unavailable:", error.message);
  }
  page.on("pageerror", (error) => console.error("pageerror:", error.message));

  await page.goto(base, { waitUntil: "networkidle2", timeout: 60_000 });
  await waitForRail(page);
  await shot(page, "01-rail-baseline.png");

  /* Hover a row so the dashed crown toggle reveal is on record. */
  /* This capture browser reports `hover: none`, so the `@media (hover: hover)`
     reveal cannot fire here (it does on any real desktop). The toggle has the
     same reveal on keyboard focus (`focus-visible`), which this environment
     can exercise — walk the tab order onto a crown toggle and record that. */
  let focused = false;
  for (let presses = 0; presses < 60 && !focused; presses += 1) {
    await page.keyboard.press("Tab");
    focused = await page.evaluate(() =>
      Boolean(document.activeElement?.matches("aside nav [data-flip-key] button[aria-pressed]")));
  }
  if (!focused) throw new Error("tab order never reached a crown toggle");
  await sleep(500);
  const revealed = await page.evaluate(() => getComputedStyle(document.activeElement).opacity);
  console.log("focused toggle opacity:", revealed);
  if (revealed !== "1") throw new Error("crown toggle never revealed on keyboard focus");
  await shot(page, "02-crown-reveal.png");

  await crown(page, "beacon");
  await crown(page, "relay");
  await shot(page, "03-crown-pinned.png");

  const pinned = await railOrder(page);
  console.log("order after crowning:", JSON.stringify(pinned, null, 2));
  if (!pinned[0].crowned || !pinned[1].crowned || pinned[2].crowned) {
    throw new Error("crowned rows are not the exclusive top section");
  }

  /* Durability: a fresh load must read the same crowns from the server. */
  await page.goto(base, { waitUntil: "networkidle2", timeout: 60_000 });
  await waitForRail(page);
  const reloaded = await railOrder(page);
  console.log("order after reload:", JSON.stringify(reloaded, null, 2));
  if (!reloaded[0].crowned || !reloaded[1].crowned || reloaded[2].crowned) {
    throw new Error("crowns did not survive the reload");
  }
  await shot(page, "04-crown-after-reload.png");

  /* Create project: name + root, immediate rail row, auto-selection. */
  await page.click('button[aria-label="Create project"]');
  await page.waitForSelector("aside form input");
  const inputs = await page.$$("aside form input");
  await inputs[0].type("Nova Docs");
  await inputs[1].type(manualRoot);
  await shot(page, "05-create-form.png");
  await page.click('aside form button[type="submit"]');
  await page.waitForFunction(
    () => [...document.querySelectorAll("aside nav [data-flip-key]")].some((el) => (el.textContent || "").includes("Nova Docs")),
    { timeout: 15_000 },
  );
  await sleep(700);
  await shot(page, "06-created-project.png");

  /* Duplicate identity refusal, with the localized message. */
  await page.click('button[aria-label="Create project"]');
  await page.waitForSelector("aside form input");
  const again = await page.$$("aside form input");
  await again[0].type("Nova Copy");
  await again[1].type(manualRoot);
  await page.click('aside form button[type="submit"]');
  await page.waitForFunction(
    () => (document.querySelector("aside form")?.textContent || "").includes("This project already exists"),
    { timeout: 15_000 },
  );
  await shot(page, "07-create-duplicate.png");

  /* Ukrainian locale over the same surface. */
  await page.evaluate(() => localStorage.setItem("llv_lang", "uk"));
  await page.goto(base, { waitUntil: "networkidle2", timeout: 60_000 });
  await waitForRail(page);
  await page.click('button[aria-label="Створити проєкт"]');
  await page.waitForSelector("aside form input");
  await shot(page, "08-create-form-uk.png");

  await browser.close();
  console.log("evidence capture complete");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
