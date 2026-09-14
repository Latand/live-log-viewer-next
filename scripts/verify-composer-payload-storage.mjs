// Browser verification of the durable payload store. This fixture never contacts Viewer or a provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const { values } = parseArgs({ options: { out: { type: "string" }, chromium: { type: "string" } } });
if (!globalThis.Bun)
    throw new Error("Run this verifier with the repository's pinned Bun runtime");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-payload-"));
const root = scratch + path.sep;
const entry = path.join(scratch, "entry.ts");
fs.writeFileSync(entry, `import { ComposerPayloadStore } from ${JSON.stringify(path.join(project, "src/lib/composerPayloadStore.ts"))}; window.payloadProbe = { ComposerPayloadStore };`);
const build = await Bun.build({ entrypoints: [entry], target: "browser", outdir: scratch, naming: "probe.js" });
if (!build.success)
    throw new Error("Could not build the payload storage browser probe");
const browser = await chromium.launch({ executablePath: values.chromium ?? chromium.executablePath(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const assert = (condition, message) => { if (!condition)
    throw new Error(message); };
try {
    const context = await browser.newContext();
    await context.route('**/*', r => new URL(r.request().url()).pathname === '/probe.js' ? r.fulfill({ contentType: 'application/javascript', path: root + 'probe.js' }) : new URL(r.request().url()).pathname === '/' ? r.fulfill({ contentType: 'text/html', body: '<script src="/probe.js"></script>' }) : r.abort());
    const page = await context.newPage();
    await page.goto('https://payload.invalid/');
    await page.waitForFunction(() => window.payloadProbe?.ComposerPayloadStore);
    const retained = await page.evaluate(async () => {
        const Store = window.payloadProbe.ComposerPayloadStore;
        const store = new Store();
        const identity = { conversationId: 'conversation_fixture', key: 'large' };
        const images = Array.from({ length: 4 }, (_, i) => ({ id: 'image-' + i, mime: 'image/png', base64: String.fromCharCode(65 + i).repeat(4 * 1024 * 1024) }));
        const payload = { text: 'original request', images, selectedContext: { version: 1, state: 'none', capturedAt: '2026-01-01T00:00:00.000Z' } };
        const expected = JSON.parse(JSON.stringify(payload));
        const pending = store.retain(identity, payload);
        payload.text = 'later edit';
        payload.images[0].base64 = 'later image';
        const ref = await pending;
        const loaded = await store.read(identity);
        const snapshotPreserved = loaded.payload.text === expected.text && loaded.payload.images.every((image, i) => image.base64 === expected.images[i].base64);
        const replay = await store.retain(identity, { images: expected.images, selectedContext: expected.selectedContext, text: expected.text });
        let conflict = false;
        try {
            await store.retain(identity, { ...expected, text: 'different intent' });
        }
        catch (error) {
            conflict = error.name === 'ComposerPayloadConflictError';
        }
        const wrongRelease = await store.release({ ...ref, fingerprint: '0'.repeat(64) });
        const stillPresent = Boolean(await store.read(identity));
        const raced = await Promise.allSettled(['first', 'second'].map(text => store.retain({ conversationId: 'conversation_fixture', key: 'race' }, { text, images: [] })));
        return { ref, snapshotPreserved, sameReplay: replay.fingerprint === ref.fingerprint && replay.savedAt === ref.savedAt, conflict, wrongRelease, stillPresent, racePass: raced.filter(r => r.status === 'fulfilled').length, raceRejected: raced.filter(r => r.status === 'rejected').length };
    });
    assert(retained.snapshotPreserved && retained.sameReplay && retained.conflict && !retained.wrongRelease && retained.stillPresent && retained.racePass === 1 && retained.raceRejected === 1, 'Retention invariants failed');
    await page.reload();
    await page.waitForFunction(() => window.payloadProbe?.ComposerPayloadStore);
    const reloaded = await page.evaluate(async () => {
        const store = new window.payloadProbe.ComposerPayloadStore();
        const identity = { conversationId: 'conversation_fixture', key: 'large' };
        const row = await store.read(identity);
        const exact = row.payload.images.every((image, i) => image.base64 === String.fromCharCode(65 + i).repeat(4 * 1024 * 1024));
        const catalog = await store.list(identity.conversationId);
        return { count: row.payload.images.length, exact, text: row.payload.text, fingerprint: row.fingerprint, catalogHasBody: catalog.some(r => 'body' in r || 'payload' in r) };
    });
    assert(reloaded.count === 4 && reloaded.exact && reloaded.text === 'original request' && reloaded.fingerprint === retained.ref.fingerprint && !reloaded.catalogHasBody, 'Reload lost data');
    const corrupted = await page.evaluate(async () => {
        const Store = window.payloadProbe.ComposerPayloadStore;
        const store = new Store({ databaseName: 'corruption' });
        const identity = { conversationId: 'conversation_fixture', key: 'corrupt' };
        const original = { text: 'original', images: [] };
        await store.retain(identity, original);
        const db = await new Promise((resolve, reject) => { const req = indexedDB.open('corruption', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        const row = await new Promise((resolve, reject) => { const req = db.transaction('submissions').objectStore('submissions').get([identity.conversationId, identity.key]); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        const bytes = new Uint8Array(await row.body.arrayBuffer());
        bytes[bytes.length - 3] ^= 1;
        row.body = new Blob([bytes]);
        await new Promise((resolve, reject) => { const tx = db.transaction('submissions', 'readwrite'); tx.objectStore('submissions').put(row); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
        db.close();
        let readRefused = false, retainRefused = false;
        try {
            await store.read(identity);
        }
        catch {
            readRefused = true;
        }
        try {
            await store.retain(identity, original);
        }
        catch {
            retainRefused = true;
        }
        return { readRefused, retainRefused, catalogCount: (await store.list(identity.conversationId)).length };
    });
    assert(corrupted.readRefused && corrupted.retainRefused && corrupted.catalogCount === 1, 'Corrupt data was accepted or removed');
    const quota = await context.newPage();
    await quota.goto('https://quota.invalid/');
    await quota.waitForFunction(() => window.payloadProbe?.ComposerPayloadStore);
    const cdp = await context.newCDPSession(quota);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: 'https://quota.invalid', quotaSize: 1024 * 1024 });
    const refused = await quota.evaluate(async () => {
        const store = new window.payloadProbe.ComposerPayloadStore();
        const identity = { conversationId: 'conversation_fixture', key: 'quota' };
        const draft = { text: 'keep draft', images: Array.from({ length: 4 }, () => ({ base64: 'A'.repeat(4 * 1024 * 1024), mime: 'image/png' })) };
        let sent = 0, error = null;
        try {
            await store.retain(identity, draft);
            sent++;
        }
        catch (e) {
            error = e.name;
        }
        return { sent, error, draftText: draft.text, draftImages: draft.images.length, stored: await store.read(identity) };
    });
    assert(refused.sent === 0 && refused.error && refused.draftText === 'keep draft' && refused.draftImages === 4 && refused.stored === null, 'Quota failure lost the draft or allowed send');
    const result = { retained, reloaded, corrupted, refused, scope: 'Storage primitive browser proof only; composer integration remains required.' };
    if (values.out) {
        fs.mkdirSync(values.out, { recursive: true });
        fs.writeFileSync(path.join(values.out, "store-browser.json"), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
}
finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
}
