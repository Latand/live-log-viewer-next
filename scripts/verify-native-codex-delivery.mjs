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
const faults={dropQueue:false,holdQueue:null,dropSend:false};
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
  const response=await runtime.handle(new Request('http://localhost'+url.pathname+url.search,{method:request.method(),headers:{'content-type':'application/json'},...(body===undefined?{}:{body})}));
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
const entries=()=>runtime.journal.nativeQueueRead(conversationId);
const operationKey=operationId=>runtime.journal.db.query('SELECT idempotency_key FROM operations WHERE operation_id = ?').get(operationId)?.idempotency_key;
const operationsFor=key=>runtime.journal.db.query('SELECT operation_id FROM operations WHERE idempotency_key = ?').all(key).length;
const entryFor=key=>entries().find(entry=>entry.versions.some(version=>operationKey(version.operationId)===key));
const rpcCount=(method,predicate=()=>true)=>runtime.rpc.filter(call=>call.method===method&&predicate(call.params)).length;
const shas=files=>files.map(file=>sha(file.buffer));
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

 // 1. A four-image hand-off to Codex's queue; its answer is held on the wire.
 //    Enter on a small command goes at once, while the answer is still held.
 const queued={text:'Queued with four images',files:imagesFor(10)};
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
  queueBodyBytes:writes('/api/runtime/queue',queued.key)[0].bodyBytes};
 releaseHeld();
 await waitFor(async()=>(await slot(page))===null,'the held answer to release the hand-off identity');
 await waitFor(()=>small.status!==undefined,'the small command answer');
 results.heldAnswer.smallCommandStatus=small.status;
 assert(results.heldAnswer.queueAnswerStillHeld&&results.heldAnswer.smallCommandWireMs<2000&&results.heldAnswer.draftCleared
  &&results.heldAnswer.slotCharsInFlight>0&&results.heldAnswer.slotCharsInFlight<4096&&results.heldAnswer.queueBodyBytes>16*1024*1024,'The held queue answer blocked the next command');
 fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));

 // 2. The queued entry is dispatched by Codex as one canonical input with the exact images.
 for(let turns=0;turns<6&&entryFor(queued.key)?.state!=='delivered';turns++){
  while(runtime.provider.open()>0)runtime.provider.completeNext();
  await Bun.sleep(1000);
 }
 await waitFor(()=>entryFor(queued.key)?.state==='delivered','the queued entry to be delivered',60000);
 const queuedEntry=entryFor(queued.key);
 const localImages=(queuedEntry.proof?.input??[]).filter(item=>item.type==='localImage');
 const engineImages=[];for(const item of localImages)engineImages.push(sha(await engineRead(item.path)));
 results.nativeDispatch={state:queuedEntry.state,binding:queuedEntry.binding,journalOperations:operationsFor(queued.key),
  queueAdds:rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(queuedEntry.clientUserMessageId)),
  proofClient:queuedEntry.proof?.clientUserMessageId===queuedEntry.clientUserMessageId,proofText:(queuedEntry.proof?.input??[]).filter(item=>item.type==='text').map(item=>item.text.slice(-40)),
  engineImagesMatch:JSON.stringify(engineImages)===JSON.stringify(shas(queued.files)),
  providerTurns:providerTurnsWith(shas(queued.files)).length,
  terminalReplay:await askAgain('/api/runtime/queue',queued.key),
  storeImagesMatch:JSON.stringify(queuedEntry.versions[0].images.map(ref=>sha(runtimeImageStore().read(ref))))===JSON.stringify(shas(queued.files))};
 assert(results.nativeDispatch.binding.threadId===threadId&&results.nativeDispatch.journalOperations===1&&results.nativeDispatch.queueAdds===1
  &&results.nativeDispatch.proofClient&&results.nativeDispatch.engineImagesMatch&&results.nativeDispatch.providerTurns===1&&results.nativeDispatch.storeImagesMatch
  &&results.nativeDispatch.terminalReplay.status===202&&operationsFor(queued.key)===1&&rpcCount('thread/queue/add',params=>JSON.stringify(params).includes(queuedEntry.clientUserMessageId))===1,'Native dispatch was not one exact canonical input');
 fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef===null,'the thread to go idle');

 // 3. A hand-off whose answer is lost; reload; the unresolved row replays the same operation once.
 await stage(page,'Warm-up before the lost answer',[]);
 await page.locator('textarea').press('Enter');
 await waitFor(()=>runtime.provider.open()===1,'a running turn before the lost answer');
 const lost={text:'Queued, answer lost',files:imagesFor(20)};
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
  providerTurns:providerTurnsWith(shas(lost.files)).length,slotAfter:await slot(page)};
 assert(results.lostAnswer.sameEnvelope&&results.lostAnswer.sameBinding&&results.lostAnswer.journalOperations===1&&results.lostAnswer.queueAdds===1
  &&results.lostAnswer.providerTurns===1&&results.lostAnswer.slotAfter===null,'The lost hand-off was not recovered as one delivered operation');
 while(runtime.provider.open()>0)runtime.provider.completeNext();
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef===null,'the thread to go idle again');

 // 4. Codex's queue has no place for a document: the hand-off is refused whole, nothing leaves.
 const mixed={text:'Images and a document',files:[...imagesFor(30),binaryFor(30)]};
 await stage(page,mixed.text,mixed.files);
 const queueWritesBefore=wire.filter(entry=>entry.path==='/api/runtime/queue').length;
 await page.locator('textarea').press('Alt+Enter');
 await page.getByText('takes text and images only',{exact:false}).first().waitFor();
 await Bun.sleep(300);
 results.queueWithDocument={writes:wire.filter(entry=>entry.path==='/api/runtime/queue').length-queueWritesBefore,draft:await page.locator('textarea').inputValue(),tiles:await tiles(page)};
 assert(results.queueWithDocument.writes===0&&results.queueWithDocument.draft===mixed.text&&results.queueWithDocument.tiles===5,'A document was dropped by a queue hand-off');

 // 5. The same draft through Enter: four images and the document, with its answer lost.
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

 results.totals={providerRequests:runtime.provider.requests.length,queueAdds:rpcCount('thread/queue/add'),turnStarts:rpcCount('turn/start'),journalEntries:entries().length,
  entryStates:entries().map(entry=>entry.state)};
 fs.writeFileSync(path.join(out,'native-codex-delivery.json'),JSON.stringify(redact(results),null,2));
 fs.writeFileSync(path.join(out,'wire.json'),JSON.stringify(redact(wire),null,2));
 console.log(JSON.stringify(redact(results)));
}catch(error){fs.writeFileSync(path.join(out,'partial.json'),JSON.stringify(redact({results,wire,provider:runtime.provider.requests,entries:entries(),rpc:runtime.rpc.map(call=>call.method)}),null,2));throw error;}
finally{await context?.close();await runtime.close();}
