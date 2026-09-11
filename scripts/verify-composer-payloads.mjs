// Assembled composer acceptance with synthetic backend and files only.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const { values } = parseArgs({ options: {out:{type:'string'},chromium:{type:'string'},baseline:{type:'boolean',default:false}} });
if (!globalThis.Bun || !values.out) throw new Error('Use pinned Bun and --out outside checkout');
const out = path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const bundle = await Bun.build({entrypoints:['scripts/capture-composer-payloads.fixture.tsx'],target:'browser',define:{'process.env.NODE_ENV':JSON.stringify('production')},outdir:out,naming:'composer.js'});
if(!bundle.success) throw new Error(String(bundle.logs));
const cssPath = path.resolve('src/app/globals.css');
const css = await postcss([tailwind()]).process(fs.readFileSync(cssPath,'utf8'),{from:cssPath,to:path.join(out,'composer.css')});
fs.writeFileSync(path.join(out,'composer.css'),css.css);
const browser = await chromium.launch({executablePath:values.chromium ?? chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage']});
const assert = (ok,reason)=>{if(!ok)throw new Error(reason);};
try {
 const context = await browser.newContext({viewport:{width:1000,height:900}});
 await context.route('**/*',r=>{
  const u = new URL(r.request().url());
  if(u.pathname==='/composer.js')return r.fulfill({contentType:'application/javascript',path:path.join(out,'composer.js')});
  if(u.pathname==='/composer.css')return r.fulfill({contentType:'text/css',path:path.join(out,'composer.css')});
  if(u.pathname==='/')return r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/composer.css"></head><body><div id="app" style="position:relative;width:650px;height:800px;margin:24px"></div><script src="/composer.js"></script></body></html>'});
  return r.abort();
 });
 const page=await context.newPage();
 page.setDefaultTimeout(15000);
 page.on("console",message=>fs.appendFileSync(path.join(out,"console.log"),message.text()+"\n"));
 page.on('pageerror',e=>fs.appendFileSync(path.join(out,'page-errors.log'),String(e)+'\n'));
 await page.goto('https://composer.invalid/');
 await page.locator('textarea').waitFor();
 await page.locator('textarea').fill('Original four-image submission');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=','base64');
 const images=Array.from({length:4},(_,i)=>({name:`synthetic-${i}.png`,mimeType:'image/png',buffer:Buffer.concat([png,Buffer.alloc(3*1024*1024-png.length,i)])}));
 const file={name:'synthetic.bin',mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:256},(_,i)=>i))};
 await page.locator('input[type=file]').first().setInputFiles([...images,file]);
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length===5).catch(async()=>{await page.screenshot({path:path.join(out,'intake.png')});});
 await page.screenshot({path:path.join(out,'before-send.png')});
 await page.locator('textarea').press('Enter');
 await page.waitForFunction(()=>window.payloadFixture.requests.length===1,{},{timeout:15000}).catch(async error=>{await page.screenshot({path:path.join(out,'failed-send.png')});fs.writeFileSync(path.join(out,'failed-dom.txt'),await page.locator('body').innerText());throw error;});
 await page.waitForFunction(()=>window.payloadFixture.state().outbox[0]?.deliveryReceipt?.resend==='safe');
 const before=await page.evaluate(()=>({requests:window.payloadFixture.requests.map(r=>({key:r.idempotencyKey,images:r.images?.length,bytes:r.images?.map(i=>i.base64.length),files:r.files?.length})),pending:window.payloadFixture.state().pending.map(p=>({key:p.key,complete:p.payloadComplete,images:p.images.length,files:p.files?.length})),text:document.querySelector('textarea').value}));
 await page.reload();await page.locator('textarea').waitFor();
 await page.waitForTimeout(500);
 const after=await page.evaluate(()=>({requests:window.payloadFixture.requests.length,pending:window.payloadFixture.state().pending.map(p=>({key:p.key,complete:p.payloadComplete,images:p.images.length,files:p.files?.length})),text:document.body.innerText}));
 await page.screenshot({path:path.join(out,'after-reload.png')});
 const result={before,after,baseline:values.baseline};
 fs.writeFileSync(path.join(out,'composer-browser.json'),JSON.stringify(result,null,2));
 if(values.baseline)assert(before.requests[0].images===4 && after.requests===0 && after.pending.some(p=>p.complete===false&&p.images===0),'Baseline did not reproduce payload loss');
 else {
   await page.locator('[data-payload-key] summary').first().click();
   await page.locator('[data-payload-retry]').click();
   await page.waitForFunction(()=>window.payloadFixture.retries.length===1,{},{timeout:15000}).catch(async error=>{await page.screenshot({path:path.join(out,'failed-send.png')});fs.writeFileSync(path.join(out,'failed-dom.txt'),await page.locator('body').innerText());throw error;});
   // The admitted operation is retried by the journal; the bytes stay retained until its leaf settles.
   const retried=await page.evaluate(async key=>{const row=(await window.payloadFixture.saved()).find(item=>item?.ref.key===key);return {retries:window.payloadFixture.retries,resends:window.payloadFixture.requests.length,images:row?.envelope.body.images.length,bytes:row?.envelope.body.images.map(i=>i.base64.length),files:row?.envelope.body.files.length};},before.requests[0].key);
   assert(retried.retries.join()==='fixture-operation' && retried.resends===0 && retried.images===4 && retried.files===1 && retried.bytes.every(n=>n===4194304),'Retry resent or lost the retained attachment bytes');
   result.retried=retried;
   await page.screenshot({path:path.join(out,'recovery-open.png')});
   fs.writeFileSync(path.join(out,'composer-browser.json'),JSON.stringify(result,null,2));
 }
 console.log(JSON.stringify(result));
}finally{await browser.close();}
