import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browser, pageFor, focus, zoom, snapshot, out } from './revision3-browser.mjs';

const before = process.env.BOARD_EXPECT_RED === '1';
const report = { subject: before ? 'retained predecessor' : 'adopted correction', production: false, cases: [] };
const counts = page => page.evaluate(() => ({ ...window.__outerWork }));
const delta = (a, b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, (b[k] ?? 0) - (a[k] ?? 0)]));
try {
  for (const scene of ['dense', 'scale-100', 'scale-1000']) {
    const page = await pageFor(scene);
    const ids = (await snapshot(page)).nodes.filter(n => n.kind === 'conversation').map(n => n.id);
    for (const id of ids.slice(0, 3)) { await focus(page, id); await page.waitForTimeout(150); }
    await page.evaluate(() => window.__boardPreview.camera({ ...window.__boardPreview.snapshot().camera, x: -100000 }));
    await page.waitForTimeout(400);
    const start = await counts(page), timings = [];
    for (let i = 0; i < 20; i++) timings.push(await page.evaluate(async i => {
      const start = performance.now(), c = window.__boardPreview.snapshot().camera;
      window.__boardPreview.camera({ ...c, x: c.x + (i % 2 ? 8 : -8) });
      await new Promise(requestAnimationFrame); return performance.now() - start;
    }, i));
    await page.evaluate(ids => { for (let i = 0; i < 100; i++) window.__fixtureSource.append('/fixture/conversations/' + ids[i % ids.length] + '.jsonl', 'assistant', 'Hidden message ' + i); }, ids);
    await page.waitForTimeout(21000);
    const change = delta(start, await counts(page));
    assert.equal(change.wrappers, before ? ids.length * 20 : 0);
    report.cases.push({ scene, conversations: ids.length, pans: 20, incoming: 100, idleMs: 21000, change, timings });
    await page.close();
  }
  const page = await pageFor();
  await focus(page, 'index'); await zoom(page, .4);
  await page.evaluate(() => window.__boardPreview.camera({ ...window.__boardPreview.snapshot().camera, x: -10000 }));
  await page.waitForTimeout(400);
  const start = await counts(page);
  for (let i = 0; i < 20; i++) {
    await page.evaluate(i => { const c = window.__boardPreview.snapshot().camera; window.__boardPreview.camera({ ...c, x: c.x + (i % 2 ? 8 : -8) }); }, i);
    await page.waitForTimeout(25);
  }
  const change = delta(start, await counts(page));
  assert.equal(change.summaries ?? 0, before ? 20 : 0);
  report.summary = change;
  await zoom(page, .07); await page.waitForTimeout(400);
  const task = page.locator('[data-map-node="search"]');
  const initial = await task.boundingBox(); assert(initial);
  await page.screenshot({ path: path.join(out, `residual-${before ? 'before' : 'after'}-pin-start.png`) });
  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
  await page.mouse.down(); await page.mouse.move(initial.x + initial.width / 2 + 70, initial.y + initial.height / 2 + 35, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const moved = await task.boundingBox(); assert(moved);
  const displacement = { x: moved.x - initial.x, y: moved.y - initial.y };
  assert(Math.abs(displacement.x - (before ? 0 : 70)) < 1);
  assert(Math.abs(displacement.y - (before ? 0 : 35)) < 1);
  report.pin = { initial, moved, displacement, pin: (await snapshot(page)).pins.search };
  await page.screenshot({ path: path.join(out, `residual-${before ? 'before' : 'after'}-pin-end.png`) });
  report.errors = page.errors; assert.deepEqual(report.errors, []);
} finally {
  fs.writeFileSync(path.join(out, `residual-${before ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
