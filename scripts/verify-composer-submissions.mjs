// Isolated Chromium checks for the submission adapter. Product acceptance is separate.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
const { values } = parseArgs({ options: { out: { type: 'string' }, chromium: { type: 'string' } } });
if (!globalThis.Bun || !values.out) throw new Error('Use pinned Bun and --out outside the checkout');
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
const source = path.resolve('src/lib/composerSubmissionPayloads.ts');
const entry = path.join(out, 'adapter-entry.ts');
fs.writeFileSync(entry, `import * as adapter from ${JSON.stringify(source)}; window.adapter = adapter;`);
const built = await Bun.build({ entrypoints: [entry], target: 'browser', outdir: out, naming: 'adapter.js' });
if (!built.success) throw new Error(String(built.logs));
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
const launch = () => chromium.launchPersistentContext(profile, { executablePath: values.chromium ?? chromium.executablePath(), args: ['--no-sandbox','--disable-dev-shm-usage'] });
let context;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const setup = async context => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/adapter.js') return route.fulfill({ contentType: 'application/javascript', path: path.join(out, 'adapter.js') });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<script src="/adapter.js"></script>' });
    return route.abort();
  });
};
try {
  context = await launch();
  await setup(context);
  const page = await context.newPage();
  await page.goto('https://submissions.invalid');
  const saved = await page.evaluate(async () => {
    const { ComposerSubmissionPayloads, withComposerSubmission } = window.adapter;
    const store = new ComposerSubmissionPayloads();
    const owner = { conversationId: 'conversation_fixture', key: 'original-key' };
    const submission = { text: 'authored text', images: Array.from({ length: 4 }, (_, i) => ({ id: 'i'+i, base64: String.fromCharCode(65+i).repeat(4*1024*1024), mime: 'image/png', preview: 'blob:old-document' })), files: [{ id: 'f1', name: 'fixture.bin', mime: 'application/octet-stream', base64: btoa(String.fromCharCode(...Array.from({length:256}, (_, i) => i))) }], runtime: {model:'fixture-model'}, selectedContext: { state: 'none', version: 1 }, policy: 'steer-if-active' };
    let unblock;
    const blocked = new Promise(resolve => { unblock = resolve; });
    let admitted = 0;
    const first = withComposerSubmission(owner.conversationId, async () => { await blocked; admitted++; });
    const duplicate = await withComposerSubmission(owner.conversationId, async () => { admitted++; });
    unblock();
    await first;
    const pending = store.retain(owner, submission);
    submission.text = 'later draft'; submission.images[0].base64 = 'later attachment';
    const ref = await pending;
    const envelope = { route:'runtime', body:{conversationId:owner.conversationId,idempotencyKey:owner.key,text:'bridge\nprelude\nauthored text',policy:'steer-if-active',runtime:{model:'fixture-model'},selectedContext:{state:'none',version:1}} };
    const original = await store.restore(owner);
    let incompleteRefused = false;
    try { await store.seal(ref,envelope); } catch { incompleteRefused = true; }
    if (!incompleteRefused) throw new Error('Missing attachment bytes were accepted');
    envelope.body.images = original.submission.images.map(({base64,mime})=>({base64,mime}));
    envelope.body.files = original.submission.files.map(({base64,name})=>({base64,name}));
    await store.seal(ref, envelope);
    let conflict = false;
    try { await store.seal(ref, {...envelope, body:{...envelope.body,text:'different wire'}}); } catch { conflict = true; }
    const restored = await store.restore(owner);
    return { admitted, duplicate, conflict, rawText:restored.submission.text, wireText:restored.envelope.body.text, ref, file:restored.submission.files[0].base64 };
  });
  assert(saved.admitted === 1 && !saved.duplicate && saved.conflict && saved.rawText === 'authored text', 'Submission capture/duplicate/wire conflict failed');
  await page.reload();
  const reload = await page.evaluate(async () => {
    const store = new window.adapter.ComposerSubmissionPayloads();
    const row = await store.restore({ conversationId:'conversation_fixture',key:'original-key' });
    return { exact:row.submission.images.every((image,i) => image.base64 === String.fromCharCode(65+i).repeat(4*1024*1024)), preview:row.submission.images[0].preview.startsWith('data:image/png;base64,'), file:row.submission.files[0].base64, wire:{text:row.envelope.body.text,images:row.envelope.body.images.length,files:row.envelope.body.files.length}, ref:row.ref };
  });
  assert(reload.exact && reload.preview && reload.file === saved.file && reload.ref.fingerprint === saved.ref.fingerprint, 'Reload lost original bytes');
  await context.close();
  context = await launch();
  await setup(context);
  const next = await context.newPage();
  await next.goto('https://submissions.invalid');
  const fresh = await next.evaluate(async () => {
    const row = await new window.adapter.ComposerSubmissionPayloads().restore({conversationId:'conversation_fixture',key:'original-key'});
    return {images:row.submission.images.length, file:row.submission.files[0].base64, key:row.envelope.body.idempotencyKey};
  });
  assert(fresh.images === 4 && fresh.file === saved.file && fresh.key === 'original-key', 'New context lost submission');
  const tab = await context.newPage();
  await tab.goto('https://submissions.invalid');
  const race = await Promise.all([next,tab].map((view,index)=>view.evaluate(async index=>{
    const store = new window.adapter.ComposerSubmissionPayloads();
    try {await store.retain({conversationId:'race-fixture',key:'shared-key'},{text:'writer-'+index,images:[],files:[]});return 'retained';}catch{return 'refused';}
  },index)));
  assert(race.filter(value=>value==='retained').length===1 && race.filter(value=>value==='refused').length===1,'Cross-tab conflicting writers both succeeded');
  const corruption = await tab.evaluate(async()=>{
    const store = new window.adapter.ComposerSubmissionPayloads('corruption');
    const owner={conversationId:'corrupt-fixture',key:'corrupt-key'};
    await store.retain(owner,{text:'original',images:[],files:[]});
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('corruption-submissions-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const tx=db.transaction('submissions','readwrite');
    const rows=tx.objectStore('submissions');const request=rows.get([owner.conversationId,owner.key]);
    request.onsuccess=()=>{const row=request.result;row.body=new Blob(['x'.repeat(row.bytes)]);rows.put(row);};
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    let refused=false;try{await store.restore(owner);}catch{refused=true;}
    return {refused,retained:(await store.list(owner.conversationId)).length};
  });
  assert(corruption.refused && corruption.retained===1,'Corrupt submission was accepted or evicted');
  const cleanup = await next.evaluate(async ref => {
    const store = new window.adapter.ComposerSubmissionPayloads();
    const row = await store.restore(ref);
    const wrong = await store.settle({...ref,fingerprint:'0'.repeat(64)});
    const released = await store.settle(ref);
    const restored = await store.restore(ref);
    let resurrected = false;
    try { await store.retain(ref,row.submission); resurrected = true; } catch {}
    return {wrong,released,restored,resurrected};
  }, saved.ref);
  assert(!cleanup.wrong && cleanup.released && cleanup.restored === null && !cleanup.resurrected, 'Terminal fence failed');
  const other = await context.newPage();
  await other.goto('https://quota.invalid');
  const cdp = await context.newCDPSession(other);
  await cdp.send('Storage.overrideQuotaForOrigin',{origin:'https://quota.invalid',quotaSize:1024*1024});
  const quota = await other.evaluate(async () => {
    const store = new window.adapter.ComposerSubmissionPayloads();
    const draft = {text:'keep draft',images:[{base64:'A'.repeat(16*1024*1024),mime:'image/png',preview:''}],files:[]};
    let eligible = 0, error = false;
    try { await store.retain({conversationId:'fixture',key:'quota'},draft); eligible++; } catch { error = true; }
    return {eligible,error,text:draft.text,bytes:draft.images[0].base64.length};
  });
  assert(quota.eligible === 0 && quota.error && quota.bytes === 16*1024*1024 && quota.text === 'keep draft','Quota admitted or cleared submission');
  const result = {saved,reload,fresh,race,corruption,cleanup,quota,scope:'Adapter only. No assembled composer or wire requests; consumer integration still required.'};
  fs.writeFileSync(path.join(out,'adapter-browser.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally { await context?.close(); }
