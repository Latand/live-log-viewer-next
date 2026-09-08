import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { browser, pageFor, out } from './revision3-browser.mjs';

const report = { subject: 'production Viewer, SchemeBoard, TaskWorkflowPanel, useLogTail and logBus; synthetic HTTP responses; runtime bus disabled', cases: [] };
try {
  for (const [width, height] of [[1280,800],[1440,900],[1920,1080]]) for (const theme of ['light','dark']) {
    const page = await pageFor('dense', width, height, theme);
    await page.getByRole('button', { name: 'Task history', exact: true }).click();
    const panel = page.locator('[data-task-workflow-panel]');
    await panel.waitFor();
    const choices = await panel.locator('select option').evaluateAll(options => options.map(o => ({ value: o.value, text: o.textContent })));
    assert(choices.length > 1);
    await panel.locator('select').selectOption(choices[1].value);
    assert(await panel.locator('[data-work-reference]').count() > 0);
    assert(await panel.locator('[data-work-reference]').count() <= 30);
    await page.screenshot({ path: path.join(out, `production-history-${width}-${theme}.png`) });
    const target = panel.locator('[data-work-reference] button').first();
    const title = await target.textContent();
    await target.click(); await page.waitForTimeout(1600);
    const calls = await page.evaluate(() => window.__sampleTransport.calls.filter(call => call.path === '/api/logs'));
    assert(calls.length > 0, 'the actual production logBus must poll through the fixture HTTP boundary');
    report.cases.push({ width, theme, tasks: choices.length - 1, opened: title, logPolls: calls.length, errors: page.errors });
    assert.deepEqual(page.errors, []);
    await page.close();
  }
} finally {
  fs.writeFileSync(path.join(out, 'production-history.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
