// The assembled composer in Chromium, against the real runtime handlers,
// journal, structured delivery queue and native queue executor, delivering to
// the installed Codex app-server. The model provider is a credential-free local
// Responses server that records what Codex sends it; no account is reachable.
// Everything runs in a private state directory.
//
//   bun scripts/verify-native-codex-delivery.mjs --out <dir> --codex <codex binary> [--chromium <chrome>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const {values}=parseArgs({options:{out:{type:'string'},codex:{type:'string'},chromium:{type:'string'}}});
if(!globalThis.Bun||!values.out||!values.codex)throw new Error('Use pinned Bun with --out outside the checkout and --codex <binary>');
const out=path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const sandbox=fs.mkdtempSync(path.join(process.env.TMPDIR??'/var/tmp','nc-'));
const {startNativeCodexRuntime}=await import('../src/lib/runtime/fixtures/nativeCodexRuntime.ts');
const {runtimeImageStore}=await import('../src/lib/runtime/runtimeImageStore.ts');
const {inboxFileBatchToken,inboxFilesDir}=await import('../src/lib/inboxFiles.ts');
const runtime=await startNativeCodexRuntime(sandbox,values.codex);
const {conversationId,threadId}=runtime;
const bundle=await Bun.build({entrypoints:['scripts/capture-composer-payloads.fixture.tsx'],target:'browser',define:{'process.env.NODE_ENV':JSON.stringify('production')},outdir:out,naming:'composer.js'});
if(!bundle.success)throw new Error(String(bundle.logs));
const cssPath=path.resolve('src/app/globals.css');
fs.writeFileSync(path.join(out,'composer.css'),(await postcss([tailwind()]).process(fs.readFileSync(cssPath,'utf8'),{from:cssPath,to:path.join(out,'composer.css')})).css);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const redact=value=>JSON.parse(JSON.stringify(value).replaceAll(sandbox,'<sandbox>'));
const slotKey='llvQueueAdmission:'+conversationId;
const codexPid=async()=>(await runtime.host().health()).pid;
/* A path as the Codex process itself resolves it, through its own mount namespace. */
const engineRead=async file=>fs.readFileSync(`/proc/${await codexPid()}/root${file}`);

/* Every runtime request the page puts on the wire, as the server received it. */
const wire=[];
/* The exact bodies, to ask the original key again after its terminal answer. */
const bodies=new Map();
const faults={dropQueue:false,holdQueue:null,dropSend:false,staleQueue:false};
let activePage=null;
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
  const body=request.postData()??undefined;
  const entry={method:request.method(),path:url.pathname,at:Date.now()};
  if(body&&(url.pathname==='/api/runtime/queue'||url.pathname==='/api/runtime/send')){
   const json=JSON.parse(body);
   if(!bodies.has(url.pathname+json.idempotencyKey))bodies.set(url.pathname+json.idempotencyKey,body);
   const slot=url.pathname==='/api/runtime/queue'?await activePage?.evaluate(key=>sessionStorage.getItem(key),slotKey).catch(()=>null):null;
   Object.assign(entry,{key:json.idempotencyKey,action:json.action,text:json.text,sha:sha(JSON.stringify(canonical(json))),bodyBytes:body.length,
    images:(json.images??[]).map(image=>sha(Buffer.from(image.base64,'base64'))),files:(json.files??[]).map(file=>({name:file.name,sha:sha(Buffer.from(file.base64,'base64'))})),
    binding:json.binding??null,slotChars:slot?.length??0});
  }
  if(!(request.method()==='GET'&&url.pathname==='/api/runtime/queue'))wire.push(entry);
  /* A binding that moved between the press and the journal: this one request
     reaches the real journal naming another account, which refuses it. */
  let forwarded=body;
  if(entry.key&&url.pathname==='/api/runtime/queue'&&faults.staleQueue){
   faults.staleQueue=false;entry.bindingRewritten=true;
   const json=JSON.parse(body);forwarded=JSON.stringify({...json,binding:{...json.binding,accountId:'another-account'}});
  }
  const response=await runtime.handle(new Request('http://localhost'+url.pathname+url.search,{method:request.method(),headers:{'content-type':'application/json'},...(forwarded===undefined?{}:{body:forwarded})}));
  const text=await response.text();
  entry.status=response.status;entry.answeredAt=Date.now();
  if(entry.key&&url.pathname==='/api/runtime/queue'){
   if(faults.dropQueue){faults.dropQueue=false;entry.answerDropped=true;return route.abort('failed');}
   if(faults.holdQueue){const hold=faults.holdQueue;faults.holdQueue=null;entry.answerHeld=true;await hold.promise;entry.answerReleasedAt=Date.now();}
  }
  if(entry.key&&url.pathname==='/api/runtime/send'&&faults.dropSend){faults.dropSend=false;entry.answerDropped=true;return route.abort('failed');}
  return route.fulfill({status:response.status,contentType:'application/json',body:text});
 });
};
const pageUrl=`https://native.invalid/?runtime=journal&card=${encodeURIComponent(conversationId)}&queue=${encodeURIComponent(threadId)}&path=${encodeURIComponent(runtime.artifactPath)}`;
const open=async()=>{
 const page=await context.newPage();page.setDefaultTimeout(30000);
 page.on('pageerror',error=>fs.appendFileSync(path.join(out,'page-errors.log'),String(error)+'\n'));
 await page.goto(pageUrl);await page.locator('textarea').waitFor();activePage=page;return page;
};
/* Codex decodes every attachment, so each is a genuinely valid PNG: 1024×1024
   RGB noise from its own seed, which does not compress below 3 MiB. */
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=buffer=>{let c=0xffffffff;for(const byte of buffer)c=crcTable[(c^byte)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length,0);head.write(type,4,'latin1');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);return Buffer.concat([head,data,crc]);};
const noisePng=seed=>{
 const side=1024,row=side*3+1,raw=Buffer.alloc(row*side);
 for(let offset=0,counter=0;offset<raw.length;counter++){const block=crypto.createHash('sha512').update(`${seed}:${counter}`).digest();block.copy(raw,offset);offset+=block.length;}
 for(let y=0;y<side;y++)raw[y*row]=0;
 const header=Buffer.alloc(13);header.writeUInt32BE(side,0);header.writeUInt32BE(side,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw,{level:1})),chunk('IEND',Buffer.alloc(0))]);
};
/* Four distinct PNGs of at least 3 MiB each. */
const imagesFor=fill=>Array.from({length:4},(_,index)=>({name:`native-${fill}-${index}.png`,mimeType:'image/png',buffer:noisePng(`${fill}-${index}`)}));
const binaryFor=fill=>({name:`native-${fill}.bin`,mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:64*1024},(_,index)=>(index*31+fill)%256))});
const tiles=page=>page.evaluate(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length);
const stage=async(page,text,files)=>{
 await page.locator('textarea').fill(text);
 if(files.length){await page.locator('input[type=file]').first().setInputFiles(files);await page.waitForFunction(count=>document.querySelectorAll('[data-testid="attachment-tile"]').length===count,files.length);}
};
const waitFor=async(check,what,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await Bun.sleep(50);}throw new Error('timed out: '+what);};
const writes=(route,key)=>wire.filter(entry=>entry.path===route&&entry.key===key);
const lastWrite=route=>wire.filter(entry=>entry.path===route&&entry.key).at(-1);
const slot=page=>page.evaluate(key=>sessionStorage.getItem(key),slotKey);
const storedEnvelopes=page=>page.evaluate(()=>new Promise((resolve,reject)=>{
 const request=indexedDB.open('llv-queue-admissions-v1');
 request.onerror=()=>reject(request.error);
 request.onsuccess=()=>{const count=request.result.transaction('submissions').objectStore('submissions').count();count.onsuccess=()=>resolve(count.result);count.onerror=()=>reject(count.error);};
}));
const trayStates=page=>page.evaluate(()=>[...document.querySelectorAll('[data-testid="attachment-tile"]')].map(tile=>`${tile.dataset.kind}:${tile.dataset.status}`).sort());
const entries=()=>runtime.journal.nativeQueueRead(conversationId);
const operationKey=operationId=>runtime.journal.db.query('SELECT idempotency_key FROM operations WHERE operation_id = ?').get(operationId)?.idempotency_key;
const operationsFor=key=>runtime.journal.db.query('SELECT operation_id FROM operations WHERE idempotency_key = ?').all(key).length;
const entryFor=key=>entries().find(entry=>entry.versions.some(version=>operationKey(version.operationId)===key));
const rpcCount=(method,predicate=()=>true)=>runtime.rpc.filter(call=>call.method===method&&predicate(call.params)).length;
const shas=files=>files.map(file=>sha(file.buffer));
/* The inbox path a queued entry's canonical text names for this file. */
const queuedFilePath=(entry,name)=>(entry?.proof?.input??[]).filter(item=>item.type==='text').flatMap(item=>item.text.split('\n')).find(line=>line.startsWith('/')&&line.endsWith('/'+name));
/* Provider requests whose newest user message carried exactly these images. */
const providerTurnsWith=images=>runtime.provider.requests.filter(request=>JSON.stringify(request.images)===JSON.stringify(images));
const providerTurnsWithText=text=>runtime.provider.requests.filter(request=>request.texts.some(value=>value.includes(text)));
const codexVersion=Bun.spawnSync([values.codex,'--version']).stdout.toString().trim();
/* The original request, sent again under its own key once its operation is terminal. */
const askAgain=async(route,key)=>{const response=await runtime.handle(new Request('http://localhost'+route,{method:'POST',headers:{'content-type':'application/json'},body:bodies.get(route+key)}));return {status:response.status,receipt:(await response.json().catch(()=>({}))).receipt?.status??null};};
const results={codexVersion,threadIdPrefix:threadId.slice(0,8)};
try{
 await launch();
 let page=await open();

 // 0. An ordinary message starts a turn; the provider keeps it open, so the thread is running.
 await stage(page,'Warm-up turn',[]);
 await page.locator('textarea').press('Enter');
 await waitFor(()=>runtime.provider.open()===1,'the warm-up turn to reach the provider');
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef!==null,'the warm-up turn to run');

 // 1. Four images and a binary file handed to Codex's queue as ONE envelope; its
 //    answer is held on the wire. Enter on a small command goes at once, while
 //    the answer is still held.
 const queued={text:'Queued with four images and a file',files:[...imagesFor(10),binaryFor(10)]};
 await stage(page,queued.text,queued.files);
 let releaseHeld;faults.holdQueue={promise:new Promise(resolve=>{releaseHeld=resolve;})};
 await page.locator('textarea').press('Alt+Enter');
 await waitFor(()=>lastWrite('/api/runtime/queue')?.answerHeld===true,'the large hand-off to be admitted with its answer held');
 queued.key=lastWrite('/api/runtime/queue').key;
 await page.waitForFunction(()=>document.querySelector('textarea').value===''&&document.querySelectorAll('[data-testid="attachment-tile"]').length===0);
 await waitFor(()=>entryFor(queued.key)?.state==='queued'&&entryFor(queued.key)?.nativeSubmissionId,'Codex to hold the queued entry');
 const sendsBefore=wire.filter(entry=>entry.path==='/api/runtime/send').length;
 await stage(page,'Small command while the queue answer is held',[]);
 const pressedAt=Date.now();
 await page.locator('textarea').press('Enter');
 await waitFor(()=>wire.filter(entry=>entry.path==='/api/runtime/send').length===sendsBefore+1,'the small command to reach the wire',5000);
 const small=lastWrite('/api/runtime/send');
 results.heldAnswer={queueAnswerStillHeld:!writes('/api/runtime/queue',queued.key)[0].answerReleasedAt,smallCommandWireMs:small.at-pressedAt,
  smallCommandStatus:null,draftCleared:await page.locator('textarea').inputValue()==='',slotCharsInFlight:writes('/api/runtime/queue',queued.key)[0].slotChars,
  queueBodyBytes:writes('/api/runtime/queue',queued.key)[0].bodyBytes,
  wireImagesMatch:JSON.stringify(writes('/api/runtime/queue',queued.key)[0].images)===JSON.stringify(shas(queued.files.slice(0,4))),
  wireFileMatch:JSON.stringify(writes('/api/runtime/queue',queued.key)[0].files)===JSON.stringify([{name:queued.files[4].name,sha:sha(queued.files[4].buffer)}])};
 releaseHeld();
 await waitFor(async()=>(await slot(page))===null,'the held answer to release the hand-off identity');
 await waitFor(()=>small.status!==undefined,'the small command answer');
 results.heldAnswer.smallCommandStatus=small.status;
 assert(results.heldAnswer.queueAnswerStillHeld&&results.heldAnswer.smallCommandWireMs<2000&&results.heldAnswer.draftCleared
  &&results.heldAnswer.slotCharsInFlight>0&&results.heldAnswer.slotCharsInFlight<4096&&results.heldAnswer.queueBodyBytes>16*1024*1024
  &&results.heldAnswer.wireImagesMatch&&results.heldAnswer.wireFileMatch,'The held queue answer blocked the next command');
 fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));

 // 2. The queued entry is dispatched by Codex as one canonical input with the
 //    exact images, and the file its words name reads back from Codex's own
 //    namespace byte for byte.
 for(let turns=0;turns<6&&entryFor(queued.key)?.state!=='delivered';turns++){
  while(runtime.provider.open()>0)runtime.provider.completeNext();
  await Bun.sleep(1000);
 }
 await waitFor(()=>entryFor(queued.key)?.state==='delivered','the queued entry to be delivered',60000);
 const queuedEntry=entryFor(queued.key);
 const localImages=(queuedEntry.proof?.input??[]).filter(item=>item.type==='localImage');
 const engineImages=[];for(const item of localImages)engineImages.push(sha(await engineRead(item.path)));
 const queuedFile=queuedFilePath(queuedEntry,queued.files[4].name);
 results.nativeDispatch={inputKinds:(queuedEntry.proof?.input??[]).map(item=>item.type),versions:queuedEntry.versions.length,
  filePathInInbox:Boolean(queuedFile),engineFileMatch:queuedFile?sha(await engineRead(queuedFile))===sha(queued.files[4].buffer):false,
  providerFileText:queuedFile?providerTurnsWith(shas(queued.files.slice(0,4))).some(request=>request.texts.some(text=>text.includes(queuedFile))):false,state:queuedEntry.state,binding:queuedEntry.binding,journalOperations:operationsFor(queued.key),
  queueAdds:rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(queuedEntry.clientUserMessageId)),
  proofClient:queuedEntry.proof?.clientUserMessageId===queuedEntry.clientUserMessageId,proofText:(queuedEntry.proof?.input??[]).filter(item=>item.type==='text').map(item=>item.text.slice(-40)),
  engineImagesMatch:JSON.stringify(engineImages)===JSON.stringify(shas(queued.files.slice(0,4))),
  providerTurns:providerTurnsWith(shas(queued.files.slice(0,4))).length,
  terminalReplay:await askAgain('/api/runtime/queue',queued.key),
  storeImagesMatch:JSON.stringify(queuedEntry.versions[0].images.map(ref=>sha(runtimeImageStore().read(ref))))===JSON.stringify(shas(queued.files.slice(0,4)))};
 results.nativeDispatch.fileSurvivesTerminalReplay=queuedFile?sha(fs.readFileSync(queuedFile))===sha(queued.files[4].buffer):false;
 assert(results.nativeDispatch.binding.threadId===threadId&&results.nativeDispatch.journalOperations===1&&results.nativeDispatch.queueAdds===1
  &&results.nativeDispatch.proofClient&&results.nativeDispatch.engineImagesMatch&&results.nativeDispatch.providerTurns===1&&results.nativeDispatch.storeImagesMatch
  &&results.nativeDispatch.filePathInInbox&&results.nativeDispatch.engineFileMatch&&results.nativeDispatch.providerFileText&&results.nativeDispatch.versions===1
  &&JSON.stringify([...results.nativeDispatch.inputKinds].sort())===JSON.stringify(['localImage','localImage','localImage','localImage','text'])
  &&results.nativeDispatch.terminalReplay.status===202&&results.nativeDispatch.terminalReplay.receipt==='delivered'&&results.nativeDispatch.fileSurvivesTerminalReplay
  &&operationsFor(queued.key)===1&&rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(queuedEntry.clientUserMessageId))===1,'Native dispatch was not one exact canonical input');
 fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef===null,'the thread to go idle');

 // 3. An image-and-file hand-off whose answer is lost; reload; the unresolved
 //    row replays the same operation once, and the file is still the one sent.
 await stage(page,'Warm-up before the lost answer',[]);
 await page.locator('textarea').press('Enter');
 await waitFor(()=>runtime.provider.open()===1,'a running turn before the lost answer');
 const lost={text:'Queued, answer lost',files:[...imagesFor(20),binaryFor(20)]};
 await stage(page,lost.text,lost.files);
 faults.dropQueue=true;
 await page.locator('textarea').press('Alt+Enter');
 await waitFor(()=>wire.some(entry=>entry.answerDropped&&entry.path==='/api/runtime/queue'),'the hand-off whose answer is lost');
 lost.key=wire.find(entry=>entry.answerDropped&&entry.path==='/api/runtime/queue').key;
 await page.locator(`[data-testid="native-queue-unresolved-row"][data-key="${lost.key}"]`).waitFor();
 await page.reload();await page.locator('textarea').waitFor();activePage=page;
 const wireAtReload=wire.filter(entry=>entry.key).length;await Bun.sleep(500);
 await page.locator(`[data-testid="native-queue-unresolved-row"][data-key="${lost.key}"] [data-testid="native-queue-unresolved-retry"]`).click();
 await waitFor(()=>writes('/api/runtime/queue',lost.key).length===2&&writes('/api/runtime/queue',lost.key)[1].status!==undefined,'the replay');
 await page.locator(`[data-testid="native-queue-unresolved-row"][data-key="${lost.key}"]`).waitFor({state:'detached'});
 for(let turns=0;turns<6&&entryFor(lost.key)?.state!=='delivered';turns++){while(runtime.provider.open()>0)runtime.provider.completeNext();await Bun.sleep(1000);}
 await waitFor(()=>entryFor(lost.key)?.state==='delivered','the recovered entry to be delivered',60000);
 const [lostWrite,replayWrite]=writes('/api/runtime/queue',lost.key);
 results.lostAnswer={requestsOnReload:wire.filter(entry=>entry.key).length-wireAtReload-1,sameEnvelope:lostWrite.sha===replayWrite.sha,sameBinding:JSON.stringify(lostWrite.binding)===JSON.stringify(replayWrite.binding),
  replayStatus:replayWrite.status,journalOperations:operationsFor(lost.key),queueAdds:rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(entryFor(lost.key).clientUserMessageId)),
  providerTurns:providerTurnsWith(shas(lost.files.slice(0,4))).length,slotAfter:await slot(page),
  replayFileMatch:JSON.stringify(replayWrite.files)===JSON.stringify([{name:lost.files[4].name,sha:sha(lost.files[4].buffer)}])};
 const lostFile=queuedFilePath(entryFor(lost.key),lost.files[4].name);
 results.lostAnswer.engineFileMatch=lostFile?sha(await engineRead(lostFile))===sha(lost.files[4].buffer):false;
 results.lostAnswer.terminalReplay=await askAgain('/api/runtime/queue',lost.key);
 results.lostAnswer.fileSurvivesTerminalReplay=lostFile?sha(fs.readFileSync(lostFile))===sha(lost.files[4].buffer):false;
 assert(results.lostAnswer.sameEnvelope&&results.lostAnswer.sameBinding&&results.lostAnswer.journalOperations===1&&results.lostAnswer.queueAdds===1
  &&results.lostAnswer.providerTurns===1&&results.lostAnswer.slotAfter===null&&results.lostAnswer.replayFileMatch&&results.lostAnswer.engineFileMatch
  &&results.lostAnswer.terminalReplay.receipt==='delivered'&&results.lostAnswer.fileSurvivesTerminalReplay&&operationsFor(lost.key)===1,'The lost hand-off was not recovered as one delivered operation');
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef===null,'the thread to go idle again');

 /* The unknown answer gave the draft back, and the reload restores its file as
    a named slot to attach again, never as bytes (#1224); nothing is sent from
    it. It is cleared the way an operator would before the next draft. */
 results.lostAnswer.trayAfterReload=await page.evaluate(()=>[...document.querySelectorAll('[data-testid="attachment-tile"]')].map(tile=>`${tile.dataset.kind}:${tile.dataset.status}`));
 while(await tiles(page))await page.locator('[data-testid="attachment-tile"] button[aria-label^="Remove"]').first().click();

 // 4. The same kind of draft through Enter: four images and the document, with its answer lost.
 const mixed={text:'Images and a document',files:[...imagesFor(30),binaryFor(30)]};
 await stage(page,mixed.text,mixed.files);
 assert(await tiles(page)===5,'The Enter draft was not staged whole');
 faults.dropSend=true;
 await page.locator('textarea').press('Enter');
 await waitFor(()=>wire.some(entry=>entry.answerDropped&&entry.path==='/api/runtime/send'),'the ordinary send whose answer is lost');
 mixed.key=wire.find(entry=>entry.answerDropped&&entry.path==='/api/runtime/send').key;
 await waitFor(()=>providerTurnsWith(shas(mixed.files.slice(0,4))).length===1,'the ordinary turn to reach the provider',60000);
 const ordinaryTurn=providerTurnsWith(shas(mixed.files.slice(0,4)))[0];
 const filePath=ordinaryTurn.texts.join('\n').split('\n').find(line=>line.endsWith(mixed.files[4].name));
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.receipts()).some(receipt=>receipt.idempotencyKey===mixed.key&&receipt.status==='delivered'),'the ordinary send to be delivered');
 await page.reload();await page.locator('textarea').waitFor();activePage=page;
 await Bun.sleep(1500);
 /* The original key asked again after its terminal answer: the accepted file must survive. */
 const original=writes('/api/runtime/send',mixed.key)[0];
 const mixedOperation=runtime.journal.db.query('SELECT operation_id FROM operations WHERE idempotency_key = ?').get(mixed.key)?.operation_id;
 const engineFileMatch=filePath?sha(await engineRead(filePath))===sha(mixed.files[4].buffer):false;
 const recoveryRows=await page.evaluate(()=>document.querySelectorAll('[data-payload-key]').length);
 const terminalReplay=await askAgain('/api/runtime/send',mixed.key);
 results.ordinaryEnvelope={wireImages:original.images.length,wireFiles:original.files.length,wireImagesMatch:JSON.stringify(original.images)===JSON.stringify(shas(mixed.files.slice(0,4))),
  wireFileMatch:original.files[0]?.sha===sha(mixed.files[4].buffer),providerTurns:providerTurnsWith(shas(mixed.files.slice(0,4))).length,
  providerText:ordinaryTurn.texts.join('\n').includes(mixed.text),filePathInInbox:Boolean(filePath),
  engineFileMatch,recoveryRows,retryPosts:wire.filter(entry=>entry.method==='POST'&&entry.path.startsWith('/api/runtime/operations/')).length,
  turnStarts:rpcCount('turn/start',params=>params.clientUserMessageId===mixedOperation),
  requestsOnReload:wire.filter(entry=>entry.key===mixed.key).length-1,terminalReplay,journalOperations:operationsFor(mixed.key),
  fileSurvivesTerminalReplay:filePath?fs.existsSync(filePath)&&sha(fs.readFileSync(filePath))===sha(mixed.files[4].buffer):false,
  providerTurnsAfterReplay:null,draft:await page.locator('textarea').inputValue()};
 await Bun.sleep(1500);
 results.ordinaryEnvelope.providerTurnsAfterReplay=providerTurnsWith(shas(mixed.files.slice(0,4))).length;
 assert(results.ordinaryEnvelope.wireImagesMatch&&results.ordinaryEnvelope.wireFileMatch&&results.ordinaryEnvelope.providerTurns===1&&results.ordinaryEnvelope.providerText
  &&results.ordinaryEnvelope.engineFileMatch&&results.ordinaryEnvelope.fileSurvivesTerminalReplay&&results.ordinaryEnvelope.providerTurnsAfterReplay===1
  &&results.ordinaryEnvelope.turnStarts===1&&results.ordinaryEnvelope.requestsOnReload===0&&results.ordinaryEnvelope.journalOperations===1
  &&results.ordinaryEnvelope.recoveryRows===0&&results.ordinaryEnvelope.retryPosts===0,'The ordinary image-plus-file envelope was not delivered exactly once with its file intact');
 fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));

 // 5. The journal refuses a four-image-and-file hand-off, and the answer lands
 //    only after the operator has started a newer draft. The refused copy keeps
 //    its bytes through a reload, never lands on the newer draft, comes back
 //    whole into a clear composer, and queued again is one new operation that
 //    Codex delivers with the same bytes.
 while(await tiles(page))await page.locator('[data-testid="attachment-tile"] button[aria-label^="Remove"]').first().click();
 const refused={text:'Refused behind a newer draft',files:[...imagesFor(40),binaryFor(40)]};
 await stage(page,refused.text,refused.files);
 let releaseRefusal;faults.holdQueue={promise:new Promise(resolve=>{releaseRefusal=resolve;})};faults.staleQueue=true;
 await page.locator('textarea').press('Alt+Enter');
 await waitFor(()=>lastWrite('/api/runtime/queue')?.answerHeld===true,'the refused hand-off with its answer held');
 refused.key=lastWrite('/api/runtime/queue').key;
 await page.waitForFunction(()=>document.querySelector('textarea').value===''&&document.querySelectorAll('[data-testid="attachment-tile"]').length===0);
 await page.locator('textarea').fill('Newer draft typed while the answer was held');
 releaseRefusal();
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${refused.key}"]`).waitFor();
 const refusedWrite=writes('/api/runtime/queue',refused.key)[0];
 const refusedBatch=path.join(inboxFilesDir(),inboxFileBatchToken(refused.key));
 results.lateRefusal={status:refusedWrite.status,bindingRewritten:refusedWrite.bindingRewritten===true,journalOperations:operationsFor(refused.key),queuedEntries:entryFor(refused.key)?1:0,
  inboxBatchReleased:!fs.existsSync(refusedBatch),draft:await page.locator('textarea').inputValue(),tiles:await tiles(page),
  slotKeepsRefusedCopy:JSON.parse(await slot(page)??'[]').some(record=>record.key===refused.key&&record.refused&&record.payload?.images===4&&record.payload?.files===1),
  storedEnvelopes:await storedEnvelopes(page)};
 await page.screenshot({path:path.join(out,'late-refusal-newer-draft.png')});
 await page.reload();await page.locator('textarea').waitFor();activePage=page;
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${refused.key}"]`).waitFor();
 Object.assign(results.lateRefusal,{draftAfterReload:await page.locator('textarea').inputValue(),storedEnvelopesAfterReload:await storedEnvelopes(page),
  refusedRowsAfterReload:await page.locator('[data-testid="native-queue-refused-row"]').count()});
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${refused.key}"] [data-testid="native-queue-refused-restore"]`).click();
 await page.getByText('holds another draft',{exact:false}).first().waitFor();
 results.lateRefusal.restoreOverNewerDraft=await page.locator('textarea').inputValue();
 /* The newer draft goes out with Enter and keeps a turn running, so the
    message queued again waits in Codex's queue as the first one did. */
 await page.locator('textarea').press('Enter');
 await waitFor(()=>runtime.provider.open()===1,'the newer draft turn to reach the provider');
 await page.waitForFunction(()=>document.querySelector('textarea').value==='');
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${refused.key}"] [data-testid="native-queue-refused-restore"]`).click();
 await page.waitForFunction(text=>document.querySelector('textarea').value===text,refused.text);
 await page.waitForFunction(()=>document.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length===5);
 results.lateRefusal.restoredTray=await trayStates(page);
 await page.locator('textarea').press('Alt+Enter');
 await waitFor(()=>lastWrite('/api/runtime/queue')?.key!==refused.key&&lastWrite('/api/runtime/queue')?.status!==undefined,'the restored message to be queued again');
 const again=lastWrite('/api/runtime/queue');
 await waitFor(async()=>!(await slot(page)),'the new operation to settle and the refused copy to be taken over');
 await page.locator('[data-testid="native-queue-refused-row"]').waitFor({state:'detached'});
 for(let turns=0;turns<6&&entryFor(again.key)?.state!=='delivered';turns++){while(runtime.provider.open()>0)runtime.provider.completeNext();await Bun.sleep(1000);}
 await waitFor(()=>entryFor(again.key)?.state==='delivered','the message queued again to be delivered',60000);
 const againEntry=entryFor(again.key);
 const againFile=queuedFilePath(againEntry,refused.files[4].name);
 const againImages=[];for(const item of (againEntry.proof?.input??[]).filter(item=>item.type==='localImage'))againImages.push(sha(await engineRead(item.path)));
 Object.assign(results.lateRefusal,{againStatus:again.status,newKey:again.key!==refused.key,againBinding:againEntry.binding,
  wireImagesMatch:JSON.stringify(again.images)===JSON.stringify(shas(refused.files.slice(0,4))),
  wireFileMatch:JSON.stringify(again.files)===JSON.stringify([{name:refused.files[4].name,sha:sha(refused.files[4].buffer)}]),
  inputKinds:(againEntry.proof?.input??[]).map(item=>item.type),engineImagesMatch:JSON.stringify(againImages)===JSON.stringify(shas(refused.files.slice(0,4))),
  engineFileMatch:againFile?sha(await engineRead(againFile))===sha(refused.files[4].buffer):false,againJournalOperations:operationsFor(again.key),
  queueAdds:rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(againEntry.clientUserMessageId)),
  providerTurns:providerTurnsWith(shas(refused.files.slice(0,4))).length,storedEnvelopesAfterDelivery:await storedEnvelopes(page)});
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef===null,'the thread to go idle after the refusal scenario');
 assert(results.lateRefusal.status===409&&results.lateRefusal.bindingRewritten&&results.lateRefusal.journalOperations===1&&results.lateRefusal.queuedEntries===0
  &&results.lateRefusal.inboxBatchReleased&&results.lateRefusal.draft==='Newer draft typed while the answer was held'&&results.lateRefusal.tiles===0
  &&results.lateRefusal.slotKeepsRefusedCopy&&results.lateRefusal.storedEnvelopes===1&&results.lateRefusal.storedEnvelopesAfterReload===1&&results.lateRefusal.refusedRowsAfterReload===1
  &&results.lateRefusal.draftAfterReload==='Newer draft typed while the answer was held'&&results.lateRefusal.restoreOverNewerDraft==='Newer draft typed while the answer was held'
  &&JSON.stringify(results.lateRefusal.restoredTray)===JSON.stringify(['file:ready','image:ready','image:ready','image:ready','image:ready'])
  &&results.lateRefusal.againStatus===202&&results.lateRefusal.newKey&&results.lateRefusal.againBinding.threadId===threadId
  &&results.lateRefusal.wireImagesMatch&&results.lateRefusal.wireFileMatch&&results.lateRefusal.engineImagesMatch&&results.lateRefusal.engineFileMatch
  &&JSON.stringify([...results.lateRefusal.inputKinds].sort())===JSON.stringify(['localImage','localImage','localImage','localImage','text'])
  &&results.lateRefusal.againJournalOperations===1&&results.lateRefusal.queueAdds===1&&results.lateRefusal.providerTurns===1&&results.lateRefusal.storedEnvelopesAfterDelivery===0,
  'A late refusal did not keep the whole message recoverable until it was queued again');

 // 6. A refused copy the operator discards: its identity and bytes go, and the
 //    draft it gave back stays theirs.
 const discarded={text:'Refused, then discarded',files:[binaryFor(50)]};
 await stage(page,discarded.text,discarded.files);
 faults.staleQueue=true;
 await page.locator('textarea').press('Alt+Enter');
 await waitFor(()=>lastWrite('/api/runtime/queue')?.bindingRewritten===true&&lastWrite('/api/runtime/queue')?.status!==undefined,'the second refusal');
 discarded.key=lastWrite('/api/runtime/queue').key;
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${discarded.key}"]`).waitFor();
 await page.waitForFunction(text=>document.querySelector('textarea').value===text,discarded.text);
 const slotBeforeDiscard=await slot(page);
 await page.locator(`[data-testid="native-queue-refused-row"][data-key="${discarded.key}"] [data-testid="native-queue-refused-discard"]`).click();
 await page.locator('[data-testid="native-queue-refused-row"]').waitFor({state:'detached'});
 results.discard={status:lastWrite('/api/runtime/queue').status,keptBeforeDiscard:Boolean(slotBeforeDiscard?.includes(discarded.key)),slotAfter:await slot(page),
  storedEnvelopes:await storedEnvelopes(page),draft:await page.locator('textarea').inputValue(),tray:await trayStates(page),journalOperations:operationsFor(discarded.key)};
 assert(results.discard.status===409&&results.discard.keptBeforeDiscard&&results.discard.slotAfter===null&&results.discard.storedEnvelopes===0
  &&results.discard.draft===discarded.text&&JSON.stringify(results.discard.tray)===JSON.stringify(['file:ready'])&&results.discard.journalOperations===1,'Discarding a refused copy did not remove exactly it');

 results.totals={providerRequests:runtime.provider.requests.length,queueAdds:rpcCount('thread/queue/add'),turnStarts:rpcCount('turn/start'),journalEntries:entries().length,
  entryStates:entries().map(entry=>entry.state)};
 fs.writeFileSync(path.join(out,'native-codex-delivery.json'),JSON.stringify(redact(results),null,2));
 fs.writeFileSync(path.join(out,'wire.json'),JSON.stringify(redact(wire),null,2));
 console.log(JSON.stringify(redact(results)));
}catch(error){fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));throw error;}
finally{await context?.close();await runtime.close();}
