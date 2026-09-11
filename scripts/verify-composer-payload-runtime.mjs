// Assembled composer against the real runtime handlers and journal, in a
// private state directory, with a fake engine host. No provider or account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const {values}=parseArgs({options:{out:{type:'string'},chromium:{type:'string'}}});
if(!globalThis.Bun||!values.out)throw new Error('Use pinned Bun and --out outside checkout');
const out=path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const sandbox=fs.mkdtempSync(path.join(process.env.TMPDIR??'/var/tmp','llv-payload-e2e-'));
const {startComposerPayloadRuntime}=await import('../src/lib/runtime/fixtures/composerPayloadRuntime.ts');
const runtime=await startComposerPayloadRuntime(sandbox);
const bundle=await Bun.build({entrypoints:['scripts/capture-composer-payloads.fixture.tsx'],target:'browser',define:{'process.env.NODE_ENV':JSON.stringify('production')},outdir:out,naming:'composer.js'});
if(!bundle.success)throw new Error(String(bundle.logs));
const cssPath=path.resolve('src/app/globals.css');
fs.writeFileSync(path.join(out,'composer.css'),(await postcss([tailwind()]).process(fs.readFileSync(cssPath,'utf8'),{from:cssPath,to:path.join(out,'composer.css')})).css);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const redact=value=>JSON.parse(JSON.stringify(value).replaceAll(sandbox,'<sandbox>'));
/* Every request the page puts on the runtime routes, as the server received it. */
const wire=[];
let corruptNextSend=false,conflictNextSend=false;
const profile=fs.mkdtempSync(path.join(out,'profile-'));
let context;
const launch=async()=>{
 context=await chromium.launchPersistentContext(profile,{executablePath:values.chromium??chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage'],viewport:{width:1000,height:900}});
 await context.route('**/*',async route=>{
  const request=route.request();const url=new URL(request.url());
  if(url.pathname==='/composer.js')return route.fulfill({contentType:'application/javascript',path:path.join(out,'composer.js')});
  if(url.pathname==='/composer.css')return route.fulfill({contentType:'text/css',path:path.join(out,'composer.css')});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/composer.css"></head><body><div id="app" style="position:relative;width:650px;height:800px;margin:24px"></div><script src="/composer.js"></script></body></html>'});
  if(url.pathname==='/fixture/receipts')return route.fulfill({contentType:'application/json',body:JSON.stringify(await runtime.receipts())});
  if(!url.pathname.startsWith('/api/runtime/'))return route.abort();
  let body=request.postData()??undefined;
  const entry={method:request.method(),path:url.pathname};
  if(body&&url.pathname==='/api/runtime/send'){
   const json=JSON.parse(body);
   Object.assign(entry,{key:json.idempotencyKey,sha:sha(body),images:(json.images??[]).map(image=>sha(image.base64)),files:(json.files??[]).map(file=>sha(file.base64))});
   // A proxy that cut the body short: the real handler refuses it before admission.
   if(corruptNextSend){corruptNextSend=false;entry.corrupted=true;body=body.slice(0,Math.floor(body.length/2));}
  }
  wire.push(entry);
  if(conflictNextSend&&url.pathname==='/api/runtime/send'){
   // An answer that names no operation yet cannot prove nothing was admitted.
   conflictNextSend=false;entry.status=409;entry.synthetic=true;
   return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'idempotency key already belongs to another request'})});
  }
  const response=await runtime.handle(new Request('http://localhost'+url.pathname+url.search,{method:request.method(),headers:{'content-type':'application/json'},...(body===undefined?{}:{body})}));
  const text=await response.text();entry.status=response.status;
  return route.fulfill({status:response.status,contentType:'application/json',body:text});
 });
};
const url=`https://composer.invalid/?runtime=journal&card=${encodeURIComponent(runtime.conversationId)}&path=${encodeURIComponent(runtime.artifactPath)}`;
const open=async()=>{const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>fs.appendFileSync(path.join(out,'page-errors.log'),String(error)+'\n'));await page.goto(url);await page.locator('textarea').waitFor();return page;};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=','base64');
const attachmentsFor=(fill,imageBytes)=>{
 const images=Array.from({length:4},(_,index)=>({name:`synthetic-${fill}-${index}.png`,mimeType:'image/png',buffer:Buffer.concat([png,Buffer.alloc(imageBytes-png.length,fill+index)])}));
 return [...images,{name:`synthetic-${fill}.bin`,mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:256},(_,index)=>(index+fill)%256))}];
};
const messages=[
 {text:'Recovered by the receipt Retry',fill:10,imageBytes:3*1024*1024},
 {text:'Recovered by the saved-message Retry after reload',fill:20,imageBytes:3*1024*1024},
 {text:'Recovered by the delivery notice Retry in a new browser context',fill:30,imageBytes:3*1024*1024},
 {text:'Refused before admission, then sent again',fill:40,imageBytes:64*1024},
 {text:'Answered 409 without an operation',fill:50,imageBytes:64*1024},
].map(message=>({...message,files:attachmentsFor(message.fill,message.imageBytes)}));
const sends=key=>wire.filter(entry=>entry.path==='/api/runtime/send'&&entry.key===key);
const retriesOf=operationId=>wire.filter(entry=>entry.path===`/api/runtime/operations/${operationId}`&&entry.method==='POST');
const waitFor=async(check,what,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await Bun.sleep(50);}throw new Error('timed out: '+what);};
const submit=async(page,message)=>{
 const before=wire.filter(entry=>entry.path==='/api/runtime/send').length;
 await page.locator('textarea').fill(message.text);
 await page.locator('input[type=file]').first().setInputFiles(message.files);
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length===5);
 await page.locator('textarea').press('Enter');
 await waitFor(()=>wire.filter(entry=>entry.path==='/api/runtime/send').length===before+1,'the submission to reach the wire');
 message.key=wire.filter(entry=>entry.path==='/api/runtime/send').at(-1).key;
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length===0);
};
const openReceipts=async page=>{const details=page.locator('details:has([data-runtime-receipt-details])').first();if(!await details.evaluate(element=>element.open))await details.locator('> summary').click();};
const operationOf=message=>runtime.journal.db.query('SELECT operation_id FROM operations WHERE idempotency_key = ?').get(message.key)?.operation_id??null;
const saved=page=>page.evaluate(async()=>(await window.payloadFixture.saved()).filter(Boolean).map(row=>({key:row.ref.key,operations:row.operations,retry:row.retry,receipt:row.receipt&&{operationId:row.receipt.operationId,status:row.receipt.status},images:row.submission.images.map(image=>image.base64),files:row.submission.files.map(file=>file.base64)})));
const expected=message=>({images:message.files.slice(0,4).map(file=>file.buffer.toString('base64')),files:[message.files[4].buffer.toString('base64')]});
const deliveredFor=message=>runtime.delivered.filter(entry=>entry.text.startsWith(message.text));
const checkDelivered=message=>{
 const deliveries=deliveredFor(message);const want=expected(message);
 return {count:deliveries.length,textMatches:deliveries.every(entry=>entry.text.split('\n')[0]===message.text),
  imagesMatch:deliveries.every(entry=>JSON.stringify(entry.images.map(image=>image.base64))===JSON.stringify(want.images)),
  filesMatch:deliveries.every(entry=>JSON.stringify(entry.files.map(file=>file.base64))===JSON.stringify(want.files))};
};
const results={};
try{
 await launch();
 let page=await open();
 // 1. Three complete submissions admitted while the engine host is down.
 for(const message of messages.slice(0,3)){
  await submit(page,message);
  await waitFor(()=>runtime.journal.operationResult(operationOf(message)??'')?.receipt.status==='failed','the queue to fence '+message.text);
  message.operationId=operationOf(message);
 }
 await page.waitForFunction(count=>document.querySelectorAll('[data-payload-key]').length===count,3);
 let retained=[];
 await waitFor(async()=>(retained=await saved(page)).length===3&&retained.every(row=>row.retry==='operation'),'the failures to be observed durably');
 results.admittedAndFenced=messages.slice(0,3).map(message=>{
  const row=retained.find(item=>item.key===message.key);const want=expected(message);
  return {status:runtime.journal.operationResult(message.operationId).receipt.status,reason:runtime.journal.operationResult(message.operationId).receipt.reason,
   retained:Boolean(row),bytesMatch:Boolean(row)&&JSON.stringify(row.images)===JSON.stringify(want.images)&&JSON.stringify(row.files)===JSON.stringify(want.files),
   imageBytes:row?.images.map(image=>Buffer.from(image,'base64').length),route:row?.retry};
 });
 assert(results.admittedAndFenced.every(item=>item.status==='failed'&&item.retained&&item.bytesMatch&&item.route==='operation')&&runtime.delivered.length===0,'Fenced submissions lost bytes, delivered, or lacked the operation route');
 // 2. Retry while the host is still down is refused by the server and delivers nothing.
 const second=messages[1];
 await page.locator(`[data-payload-key="${second.key}"] summary`).click();
 await page.locator(`[data-payload-key="${second.key}"] [data-payload-retry]`).click();
 await waitFor(()=>retriesOf(second.operationId).length===1&&retriesOf(second.operationId)[0].status!==undefined,'the refused retry');
 await Bun.sleep(300);
 results.retryWhileDown={status:retriesOf(second.operationId)[0].status,delivered:runtime.delivered.length,journal:runtime.journal.operationResult(second.operationId).receipt.status,
  retryStillOffered:await page.locator(`[data-payload-key="${second.key}"] [data-payload-retry]`).count()};
 assert(results.retryWhileDown.status===503&&results.retryWhileDown.delivered===0&&results.retryWhileDown.retryStillOffered===1,'A retry against a down host delivered or lost its route');
 await page.screenshot({path:path.join(out,'fenced-before-host.png')});
 // 3. The host becomes available. The established receipt Retry delivers message one.
 await runtime.hostUp();
 const first=messages[0];
 const sendsBefore=wire.filter(entry=>entry.path==='/api/runtime/send').length;
 results.feedBubbleRetryForAdmitted=await page.locator(`[data-outbox-retry="${first.key}"]`).count();
 await openReceipts(page);
 await page.locator(`[data-runtime-receipt-details] [data-operation="${first.operationId}"]`).getByRole('button',{name:'Retry'}).click();
 await waitFor(()=>deliveredFor(first).length===1,'the receipt retry delivery');
 await page.waitForFunction(key=>!document.querySelector(`[data-payload-key="${key}"]`),first.key);
 results.receiptRetry={retries:retriesOf(first.operationId).map(entry=>entry.status),resends:wire.filter(entry=>entry.path==='/api/runtime/send').length-sendsBefore,...checkDelivered(first),
  released:!(await saved(page)).some(row=>row.key===first.key),othersRetained:(await saved(page)).map(row=>row.key).sort().join()===[messages[1].key,messages[2].key].sort().join()};
 assert(results.feedBubbleRetryForAdmitted===0&&results.receiptRetry.retries.join()==='202'&&results.receiptRetry.resends===0&&results.receiptRetry.count===1&&results.receiptRetry.imagesMatch&&results.receiptRetry.filesMatch&&results.receiptRetry.released&&results.receiptRetry.othersRetained,'Receipt retry did not deliver once through the operation contract');
 // 4. Reload; the saved-message Retry delivers message two, and a double click stays one delivery.
 await page.reload();await page.locator(`[data-payload-key="${second.key}"]`).waitFor();
 const wireAtReload=wire.length;await Bun.sleep(500);
 results.reloadInert={requests:wire.length-wireAtReload,delivered:runtime.delivered.length};
 assert(results.reloadInert.requests===0&&results.reloadInert.delivered===1,'Reload dispatched or delivered');
 await page.locator(`[data-payload-key="${second.key}"] summary`).click();
 await page.locator(`[data-payload-key="${second.key}"] [data-payload-retry]`).dblclick();
 await waitFor(()=>deliveredFor(second).length===1,'the saved-message retry delivery');
 await page.waitForFunction(key=>!document.querySelector(`[data-payload-key="${key}"]`),second.key);
 await Bun.sleep(500);
 results.recoveryRetry={retries:retriesOf(second.operationId).map(entry=>entry.status),resends:sends(second.key).length-1,...checkDelivered(second),released:!(await saved(page)).some(row=>row.key===second.key)};
 assert(results.recoveryRetry.resends===0&&results.recoveryRetry.count===1&&results.recoveryRetry.imagesMatch&&results.recoveryRetry.filesMatch&&results.recoveryRetry.released,'Saved-message retry did not deliver once');
 // 5. A new browser context; the collapsed delivery notice Retry delivers message three.
 await context.close();await launch();page=await open();
 const third=messages[2];
 await page.locator(`[data-payload-key="${third.key}"]`).waitFor();
 await page.locator('[data-delivery-notice-retry]').waitFor();
 await page.locator('[data-delivery-notice-retry]').click();
 await waitFor(()=>deliveredFor(third).length===1,'the notice retry delivery');
 await page.waitForFunction(key=>!document.querySelector(`[data-payload-key="${key}"]`),third.key);
 await Bun.sleep(300);
 results.noticeRetry={retries:retriesOf(third.operationId).map(entry=>entry.status),resends:sends(third.key).length-1,...checkDelivered(third),released:!(await saved(page)).some(row=>row.key===third.key),
  incompleteClaims:await page.locator('[data-payload-incomplete]').count()};
 assert(results.noticeRetry.retries.join()==='202'&&results.noticeRetry.resends===0&&results.noticeRetry.count===1&&results.noticeRetry.imagesMatch&&results.noticeRetry.filesMatch&&results.noticeRetry.released&&results.noticeRetry.incompleteClaims===0,'Notice retry did not deliver once, or a delivered message still reads incomplete');
 // 6. Receipt and parent links: each leaf names the operation its own message owns.
 results.lineage=[];
 for(const message of messages.slice(0,3)){
  const leaf=runtime.journal.db.query('SELECT receipt_json FROM operations WHERE operation_id <> ? AND receipt_json LIKE ?').all(message.operationId,`%"retryOfOperationId":"${message.operationId}"%`).map(row=>JSON.parse(row.receipt_json));
  const snapshot=runtime.registry.readOnlySnapshot();
  const reservation=Object.values(snapshot.heldDeliveries).find(item=>item.command.operationId===message.operationId);
  const query=await page.evaluate(async operationId=>(await (await fetch(`/api/runtime/operations/${encodeURIComponent(operationId)}`)).json()).receipt,leaf[0]?.operationId);
  results.lineage.push({leaves:leaf.length,status:leaf[0]?.status,parent:leaf[0]?.retryOfOperationId===message.operationId,presentedUnder:leaf[0]?.presentationOperationId===message.operationId,
   attemptOwnerParent:snapshot.deliveryOperationOwners[leaf[0]?.operationId]?.retryOfOperationId===message.operationId,reservation:reservation?.state,leafQuery:query?.status});
 }
 assert(results.lineage.every(item=>item.leaves===1&&item.status==='delivered'&&item.parent&&item.presentedUnder&&item.attemptOwnerParent&&item.reservation==='delivered'&&item.leafQuery==='delivered'),'Retry lineage is not one delivered leaf per message');
 // 7. Repeating a retry after delivery converges on the delivered leaf.
 const repeat=await page.evaluate(async operationId=>{const response=await fetch(`/api/runtime/operations/${encodeURIComponent(operationId)}`,{method:'POST'});return {status:response.status,body:await response.json()};},first.operationId);
 await page.reload();await page.locator('textarea').waitFor();await Bun.sleep(500);
 results.repeatAndReload={repeatStatus:repeat.status,repeatReceipt:repeat.body.receipt?.status,delivered:runtime.delivered.length,retained:(await saved(page)).length,incompleteClaims:await page.locator('[data-payload-incomplete]').count()};
 assert(results.repeatAndReload.repeatStatus===200&&results.repeatAndReload.repeatReceipt==='delivered'&&results.repeatAndReload.delivered===3&&results.repeatAndReload.retained===0&&results.repeatAndReload.incompleteClaims===0,'A repeat or reload duplicated delivery or left a false incomplete claim');
 // 8. A refusal before admission offers the sealed envelope again, truthfully, across reload.
 const refused=messages[3];
 corruptNextSend=true;await submit(page,refused);
 await page.locator(`[data-payload-key="${refused.key}"]`).waitFor();
 await page.reload();await page.locator(`[data-payload-key="${refused.key}"] summary`).click();
 const refusedText=await page.locator(`[data-payload-key="${refused.key}"] [data-payload-reason]`).innerText();
 results.preAdmission={firstStatus:sends(refused.key)[0].status,corrupted:sends(refused.key)[0].corrupted===true,journalOperation:operationOf(refused),reason:refusedText,
  retryOffered:await page.locator(`[data-payload-key="${refused.key}"] [data-payload-retry]`).count(),discardOffered:await page.locator(`[data-payload-key="${refused.key}"] [data-payload-discard]`).count()};
 assert(results.preAdmission.firstStatus===400&&!results.preAdmission.journalOperation&&refusedText.includes('invalid JSON')&&results.preAdmission.retryOffered===1&&results.preAdmission.discardOffered===1,'Pre-admission refusal lacked a truthful recovery route');
 await page.screenshot({path:path.join(out,'pre-admission-refusal.png')});
 await page.locator(`[data-payload-key="${refused.key}"] [data-payload-retry]`).click();
 await waitFor(()=>deliveredFor(refused).length===1,'the resent refusal delivery');
 await page.waitForFunction(key=>!document.querySelector(`[data-payload-key="${key}"]`),refused.key);
 const [firstAttempt,secondAttempt]=sends(refused.key);
 Object.assign(results.preAdmission,{resendStatus:secondAttempt.status,sameKey:secondAttempt.key===firstAttempt.key,sameEnvelope:secondAttempt.sha===firstAttempt.sha,...checkDelivered(refused)});
 assert(results.preAdmission.sameEnvelope&&results.preAdmission.resendStatus===202&&results.preAdmission.count===1&&results.preAdmission.imagesMatch&&results.preAdmission.filesMatch,'Resent refusal changed its envelope or did not deliver once');
 // 9. A 409 that names no operation stays unknown: no local resend, no discard.
 const conflicted=messages[4];
 conflictNextSend=true;await submit(page,conflicted);
 await page.locator(`[data-payload-key="${conflicted.key}"]`).waitFor();
 await page.reload();await page.locator(`[data-payload-key="${conflicted.key}"] summary`).click();await Bun.sleep(500);
 results.ambiguous409={sends:sends(conflicted.key).length,retryOffered:await page.locator(`[data-payload-key="${conflicted.key}"] [data-payload-retry]`).count(),
  discardOffered:await page.locator(`[data-payload-key="${conflicted.key}"] [data-payload-discard]`).count(),retained:(await saved(page)).some(row=>row.key===conflicted.key),
  reason:await page.locator(`[data-payload-key="${conflicted.key}"] [data-payload-reason]`).innerText()};
 assert(results.ambiguous409.sends===1&&results.ambiguous409.retryOffered===0&&results.ambiguous409.discardOffered===0&&results.ambiguous409.retained,'An ambiguous 409 was treated as no-effect');
 await page.screenshot({path:path.join(out,'ambiguous-409.png')});
 results.totals={engineDeliveries:runtime.delivered.length,sends:wire.filter(entry=>entry.path==='/api/runtime/send').map(entry=>({status:entry.status,corrupted:Boolean(entry.corrupted),synthetic:Boolean(entry.synthetic)})),
  operationRetries:wire.filter(entry=>entry.path.startsWith('/api/runtime/operations/')&&entry.method==='POST').map(entry=>entry.status)};
 assert(results.totals.engineDeliveries===4,'Unexpected engine delivery count');
 fs.writeFileSync(path.join(out,'runtime-e2e.json'),JSON.stringify(redact(results),null,2));
 console.log(JSON.stringify(redact(results)));
}catch(error){fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify(redact({results,wire}),null,2));throw error;}
finally{await context?.close();await runtime.close();fs.rmSync(sandbox,{recursive:true,force:true});}
