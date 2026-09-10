// Behavioral acceptance through actual browser controls, using the product fixture.
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
const {values}=parseArgs({options:{out:{type:'string'},assets:{type:'string'},chromium:{type:'string'}}});
if(!values.out||!values.assets)throw new Error('--out and --assets are required');
const out=path.resolve(values.out),assets=path.resolve(values.assets);fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'profile-'));
const launch=()=>chromium.launchPersistentContext(profile,{executablePath:values.chromium??chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage'],viewport:{width:1000,height:900}});
let context;
const results={};
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const setup=async()=>{
 context=await launch();
 await context.route('**/*',r=>{
  const pathname=new URL(r.request().url()).pathname;
  if(pathname==='/composer.js')return r.fulfill({contentType:'application/javascript',path:path.join(assets,'composer.js')});
  if(pathname==='/composer.css')return r.fulfill({contentType:'text/css',path:path.join(assets,'composer.css')});
  if(pathname==='/')return r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/composer.css"></head><body><div id="app" style="position:relative;width:650px;height:800px;margin:24px"></div><script src="/composer.js"></script></body></html>'});
  return r.abort();
 });
};
const open=async(name,mode='safe')=>{
 const page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',e=>fs.appendFileSync(path.join(out,'page-errors.log'),name+': '+e+'\n'));
 await page.goto(`https://${name}.invalid/?mode=${mode}`);await page.locator('textarea').waitFor();return page;
};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=','base64');
const files=Array.from({length:4},(_,i)=>({name:`synthetic-${i}.png`,mimeType:'image/png',buffer:Buffer.concat([png,Buffer.alloc(3*1024*1024-png.length,i)])}));
files.push({name:'synthetic.bin',mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:256},(_,i)=>i))});
const stage=async(page,text)=>{await page.locator('textarea').fill(text);await page.locator('input[type=file]').first().setInputFiles(files);await page.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length===5);};
const sent=async page=>{await page.waitForFunction(()=>window.payloadFixture.requests.length===1,{},{timeout:15000});if(!page.url().includes('mode=unknown'))await page.waitForFunction(()=>window.payloadFixture.state().outbox.find(e=>e.id===window.payloadFixture.requests[0]?.idempotencyKey)?.deliveryReceipt?.resend==='safe');};
const digest=page=>page.evaluate(async()=>{
 const request=window.payloadFixture.requests[0];
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(request)));
 return {key:request.idempotencyKey,sha:Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join(''),images:request.images.length,files:request.files.length};
});
const savedCount=page=>page.evaluate(async()=>(await window.payloadFixture.saved()).filter(Boolean).length);
try{
 await setup();
 // A real IndexedDB quota refuses the actual Send before clearing anything.
 const quota=await open('quota');await stage(quota,'Keep this draft');
 const cdp=await context.newCDPSession(quota);await cdp.send('Storage.overrideQuotaForOrigin',{origin:'https://quota.invalid',quotaSize:1024*1024});
 await quota.locator('textarea').press('Enter');await quota.getByText('Could not save the complete message.',{exact:false}).first().waitFor();
 results.quota=await quota.evaluate(()=>({requests:window.payloadFixture.requests.length,text:document.querySelector('textarea').value,tiles:document.querySelectorAll('[data-testid="attachment-tile"]').length}));
 assert(results.quota.requests===0&&results.quota.text==='Keep this draft'&&results.quota.tiles===5,'Quota cleared draft or reached wire');
 await quota.screenshot({path:path.join(out,'quota-preserves-draft.png')});await quota.close();
 const wireQuota=await open('wire-quota');await stage(wireQuota,'Keep draft if envelope storage fails');
 const wireCdp=await context.newCDPSession(wireQuota);await wireCdp.send('Storage.overrideQuotaForOrigin',{origin:'https://wire-quota.invalid',quotaSize:24*1024*1024});
 await wireQuota.locator('textarea').press('Enter');await wireQuota.getByText('Could not save the complete message.',{exact:false}).first().waitFor();
 results.wireQuota=await wireQuota.evaluate(()=>({requests:window.payloadFixture.requests.length,text:document.querySelector('textarea').value,tiles:document.querySelectorAll('[data-testid="attachment-tile"]').length}));
 assert(results.wireQuota.requests===0&&results.wireQuota.tiles===5&&results.wireQuota.text==='Keep draft if envelope storage fails','Second-phase quota lost draft or sent');
 await wireQuota.locator('[data-payload-key] summary').click();
 await wireQuota.getByText('Remove saved preparation',{exact:true}).click();await wireQuota.waitForFunction(async()=>!(await window.payloadFixture.saved()).length);
 results.wireQuota.explicitPreparationDiscard=true;await wireQuota.close();

 const denied=await context.newPage();denied.setDefaultTimeout(15000);
 await denied.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true}));
 await denied.goto('https://denied.invalid/');await denied.locator('textarea').waitFor();await stage(denied,'Storage unavailable draft');
 await denied.locator('textarea').press('Enter');await denied.waitForTimeout(200);
 results.inaccessible=await denied.evaluate(()=>({requests:window.payloadFixture.requests.length,text:document.querySelector('textarea').value,tiles:document.querySelectorAll('[data-testid="attachment-tile"]').length}));
 assert(results.inaccessible.requests===0&&results.inaccessible.tiles===5&&results.inaccessible.text==='Storage unavailable draft','Inaccessible storage lost draft or sent');await denied.close();
 // Edits and a later attachment survive; the duplicate Enter creates no second submission.
 const race=await open('race');await stage(race,'Original before async storage');
 await race.evaluate(()=>{window.payloadFixture.select('original');window.payloadFixture.holdStorage();});
 await race.locator('textarea').press('Enter');await race.locator('textarea').press('Enter');
 await race.locator('textarea').fill('Later draft must survive');
 await race.locator('input[type=file]').first().setInputFiles({name:'later.png',mimeType:'image/png',buffer:png});
 await race.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length===6);
 await race.evaluate(()=>window.releasePayloadStorage());await sent(race);
 results.race=await race.evaluate(()=>({requests:window.payloadFixture.requests.length,text:document.querySelector('textarea').value,tiles:document.querySelectorAll('[data-testid="attachment-tile"]').length,wireText:window.payloadFixture.requests[0].text,images:window.payloadFixture.requests[0].images.length,files:window.payloadFixture.requests[0].files.length}));
 assert(results.race.requests===1&&results.race.text==='Later draft must survive'&&results.race.tiles===1&&results.race.images===4&&results.race.files===1&&results.race.wireText==='Original before async storage','Async save raced the next draft');
 results.originalBytes=await race.evaluate(expected=>{
  const request=window.payloadFixture.requests[0];
  return {images:request.images.every((image,i)=>image.base64===expected.images[i]),file:request.files[0].base64===expected.file};
 },{images:files.slice(0,4).map(file=>file.buffer.toString('base64')),file:files[4].buffer.toString('base64')});
 assert(results.originalBytes.images&&results.originalBytes.file,'Initial wire changed original uploaded bytes');
 const first=await digest(race);
 const beforeBubble=await race.evaluate(()=>window.payloadFixture.requests.length);
 await race.locator('[data-outbox-retry]').first().click();
 await race.waitForFunction(count=>window.payloadFixture.requests.length===count+1,beforeBubble);
 results.bubbleRetry=await race.evaluate(()=>({sameKey:window.payloadFixture.requests[0].idempotencyKey===window.payloadFixture.requests[1].idempotencyKey,images:window.payloadFixture.requests[1].images.length,files:window.payloadFixture.requests[1].files.length}));
 assert(results.bubbleRetry.sameKey&&results.bubbleRetry.images===4&&results.bubbleRetry.files===1,'Existing bubble retry bypassed payload retention');
 await race.waitForFunction(()=>window.payloadFixture.state().outbox[0]?.state==='failed');
 await race.evaluate(()=>window.payloadFixture.switchCard(true));await race.waitForTimeout(100);await race.evaluate(()=>window.payloadFixture.switchCard(false));
 await race.locator('[data-payload-key]').waitFor();assert(await savedCount(race)===1,'Card switch lost payload');
 await race.reload();await race.locator('[data-payload-key]').waitFor();await race.evaluate(()=>{window.payloadFixture.profile();window.payloadFixture.select('later');});await race.locator('[data-payload-key] summary').click();await race.locator('[data-payload-retry]').click();await sent(race);
 const second=await digest(race);results.sameKeyRetry={first,second};assert(first.key===second.key&&first.sha===second.sha,'Reload retry changed complete wire envelope');
 // Unknown original stays inert after reload and after closing the browser context.
 const unknown=await open('unknown','unknown');await stage(unknown,'Unknown original');await unknown.locator('textarea').press('Enter');await sent(unknown);
 const unknownKey=(await digest(unknown)).key;await unknown.reload();await unknown.locator('[data-payload-key]').waitFor();await unknown.waitForTimeout(200);
 assert(await unknown.evaluate(()=>window.payloadFixture.requests.length)===0,'Unknown redispatched on reload');
 await unknown.locator('[data-payload-key] summary').click();assert(await unknown.locator('[data-payload-retry]').count()===0,'Unknown offered local resend');
 await unknown.screenshot({path:path.join(out,'unknown-no-resend.png')});
 await context.close();await setup();const fresh=await open('unknown','unknown');await fresh.locator('[data-payload-key]').waitFor();
 results.newContext=await fresh.evaluate(async()=>{const rows=await window.payloadFixture.saved();return {requests:window.payloadFixture.requests.length,images:rows[0].submission.images.map(i=>i.base64.length),files:rows[0].submission.files.length,key:rows[0].ref.key};});
 assert(results.newContext.requests===0&&results.newContext.key===unknownKey&&results.newContext.images.every(n=>n===4194304)&&results.newContext.files===1,'New context lost bytes or sent unknown');
 const reopenedSafe=await open('race');await reopenedSafe.locator('[data-payload-key] summary').click();await reopenedSafe.locator('[data-payload-retry]').click();await sent(reopenedSafe);
 results.safeNewContext=await digest(reopenedSafe);assert(results.safeNewContext.key===first.key&&results.safeNewContext.sha===first.sha,'Fresh context safe retry changed original envelope');
 const legacy=await open('legacy');
 await legacy.evaluate(()=>{
   const pending=Array.from({length:4},(_,i)=>({key:'report-'+i,text:'Worker report '+i,images:[],payloadComplete:false}));
   sessionStorage.setItem('llvPendingSend:conversation_payload_fixture',JSON.stringify(pending));
   sessionStorage.setItem('llvRecoveryReceipts:conversation_payload_fixture',JSON.stringify(pending.map((p,i)=>({conversationId:'conversation_payload_fixture',idempotencyKey:p.key,operationId:'report-op-'+i,kind:'send',status:'uncertain',resend:'verify-first',reason:'Synthetic bounded transcript tail is unavailable',at:new Date().toISOString(),revision:1}))));
   window.payloadFixture.seedLegacyOutbox(pending);
   window.payloadFixture.remount();
 });
 await legacy.locator('[data-payload-incomplete]').first().waitFor();
 assert(await legacy.locator('[data-payload-incomplete]').count()===4,'Legacy records vanished');
 await legacy.locator('[data-payload-incomplete] summary').first().click();
 await legacy.locator('[data-payload-incomplete] button').first().click();
 results.legacy=await legacy.evaluate(()=>({requests:window.payloadFixture.requests.length,refreshes:window.payloadFixture.refreshes(),genericTimeouts:document.body.innerText.split('Delivery confirmation timed out.').length-1,claimsSaved:document.body.innerText.includes('complete copy saved')}));
 assert(results.legacy.requests===0&&results.legacy.refreshes>0&&results.legacy.genericTimeouts===0&&!results.legacy.claimsSaved,'Legacy recovery made a false claim or resent');await legacy.screenshot({path:path.join(out,'legacy-report-diagnostics.png')});
 await legacy.locator('textarea').fill('A separately authored new instruction');await legacy.locator('textarea').press('Enter');await sent(legacy);
 results.legacyNewDraft=await legacy.evaluate(async()=>({requests:window.payloadFixture.requests.map(r=>({key:r.idempotencyKey,text:r.text})),saved:(await window.payloadFixture.saved()).map(r=>({key:r.ref.key,text:r.submission.text})),old:window.payloadFixture.state().pending.filter(p=>p.key.startsWith('report-')).map(p=>({key:p.key,incomplete:p.payloadComplete===false}))}));
 assert(results.legacyNewDraft.requests.length===1&&results.legacyNewDraft.requests[0].text==='A separately authored new instruction'&&!results.legacyNewDraft.requests[0].key.startsWith('report-')&&results.legacyNewDraft.old.length===4&&results.legacyNewDraft.old.every(p=>p.incomplete)&&results.legacyNewDraft.saved.length===1,'Incomplete old generation blocked or hijacked new message');

 // Foreign/stale evidence cannot clean; a matching terminal receipt does.
 const terminal=await open('terminal');await stage(terminal,'Terminal evidence');await terminal.locator('textarea').press('Enter');await sent(terminal);
 const key=(await digest(terminal)).key;
 const evidence={conversationId:'conversation_payload_fixture',idempotencyKey:key,operationId:'fixture-operation',kind:'send',status:'delivered',at:new Date().toISOString(),revision:2};
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,conversationId:'foreign-conversation'}]),evidence);await terminal.waitForTimeout(150);
 assert(await savedCount(terminal)===1,'Foreign receipt deleted payload');
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,revision:0}]),evidence);await terminal.waitForTimeout(150);assert(await savedCount(terminal)===1,'Stale receipt deleted payload');
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,status:'uncertain',resend:'verify-first',revision:5}]),evidence);await terminal.waitForFunction(async()=>{const rows=await window.payloadFixture.saved();return rows[0]?.receipt?.revision===5;});assert(await savedCount(terminal)===1,'Unknown admission deleted payload');
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,revision:3}]),evidence);await terminal.waitForTimeout(200);assert(await savedCount(terminal)===1,'Older positive receipt overrode newer unknown');
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,status:'queued',revision:6}]),evidence);await terminal.waitForTimeout(200);assert(await savedCount(terminal)===1,'Admission alone deleted payload');
 await terminal.evaluate(r=>window.payloadFixture.receipts([{...r,revision:7}]),evidence);await terminal.waitForFunction(async()=>!(await window.payloadFixture.saved()).filter(Boolean).length);
 results.terminal={foreignRetained:true,staleRetained:true,matchingReleased:true,newerUnknownRetained:true,admittedRetained:true};
 await terminal.reload();await terminal.locator('textarea').waitFor();await terminal.waitForTimeout(200);assert(await terminal.evaluate(()=>window.payloadFixture.requests.length)===0,'Terminal orphan queue resent');
 // A corrupted raw row stays retained, visibly incomplete, with no local retry.
 const corrupt=await open('corrupt');await stage(corrupt,'Corrupted record');await corrupt.locator('textarea').press('Enter');await sent(corrupt);
 const corruptKey=(await digest(corrupt)).key;
 await corrupt.evaluate(async key=>{const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('llv-composer-submissions-v1');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});const tx=db.transaction('submissions','readwrite');const store=tx.objectStore('submissions');const req=store.get(['conversation_payload_fixture',key]);req.onsuccess=()=>{const row=req.result;row.body=new Blob(['x'.repeat(row.bytes)]);store.put(row);};await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();},corruptKey);
 await corrupt.reload();await corrupt.getByText('The saved message could not be verified.',{exact:false}).waitFor();assert(await corrupt.locator('[data-payload-retry]').count()===0,'Corruption offered retry');
 results.corruption={requests:await corrupt.evaluate(()=>window.payloadFixture.requests.length),retained:true};assert(results.corruption.requests===0,'Corruption reached wire');await corrupt.screenshot({path:path.join(out,'corrupt-recovery.png')});
 fs.writeFileSync(path.join(out,'scenarios.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}catch(error){fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify(results,null,2));throw error;}finally{await context?.close();}
