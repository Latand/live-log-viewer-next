// Add to context beside the attachment work, in Chromium, against the real
// send, queue and injection routes, runtime journal, structured delivery queue
// and the installed Codex app-server. The model provider is the credential-free
// local Responses server of the native delivery verifier; no account is
// reachable and everything runs in a private state directory.
//
// Three races, each of which put one document into two operations:
//   1. an unanswered Add to context, then Alt+Enter and the menu's Queue for Codex;
//   2. a large queue hand-off still saving to IndexedDB, then Add to context;
//   3. an ordinary send still saving to IndexedDB, then Add to context.
// Every case runs and reports; the run fails when any case does.
//
//   bun scripts/verify-native-codex-injection-races.mjs --out <dir> --codex <codex binary> [--chromium <chrome>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
const {values}=parseArgs({options:{out:{type:'string'},codex:{type:'string'},chromium:{type:'string'}}});
if(!globalThis.Bun||!values.out||!values.codex)throw new Error('Use pinned Bun with --out outside the checkout and --codex <binary>');
const out=path.resolve(values.out);fs.mkdirSync(out,{recursive:true});
const sandbox=fs.mkdtempSync(path.join(process.env.TMPDIR??'/var/tmp','ni-'));
const {startNativeCodexRuntime}=await import('../src/lib/runtime/fixtures/nativeCodexRuntime.ts');
/* A writer claim, as a runtime host that owns the thread holds: injection admission freezes it. */
const runtime=await startNativeCodexRuntime(sandbox,values.codex,{writerClaimOwner:'fixture-runtime-host'});
const {conversationId,threadId}=runtime;
const bundle=await Bun.build({entrypoints:['scripts/capture-composer-payloads.fixture.tsx'],target:'browser',define:{'process.env.NODE_ENV':JSON.stringify('production')},outdir:out,naming:'composer.js'});
if(!bundle.success)throw new Error(String(bundle.logs));
const cssPath=path.resolve('src/app/globals.css');
fs.writeFileSync(path.join(out,'composer.css'),(await postcss([tailwind()]).process(fs.readFileSync(cssPath,'utf8'),{from:cssPath,to:path.join(out,'composer.css')})).css);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const redact=value=>JSON.parse(JSON.stringify(value).replaceAll(sandbox,'<sandbox>'));

/* Every POST the page puts on the send, queue and injection routes, as the server received it. */
const wire=[];
const ROUTES=['/api/runtime/send','/api/runtime/queue','/api/runtime/inject'];
const faults={holdInject:null};
const profile=fs.mkdtempSync(path.join(out,'profile-'));
const context=await chromium.launchPersistentContext(profile,{executablePath:values.chromium??chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage'],viewport:{width:1000,height:900}});
await context.route('**/*',async route=>{
 const request=route.request();const url=new URL(request.url());
 if(url.pathname==='/composer.js')return route.fulfill({contentType:'application/javascript',path:path.join(out,'composer.js')});
 if(url.pathname==='/composer.css')return route.fulfill({contentType:'text/css',path:path.join(out,'composer.css')});
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/composer.css"></head><body><div id="app" style="position:relative;width:650px;height:800px;margin:24px"></div><script src="/composer.js"></script></body></html>'});
 if(url.pathname==='/fixture/receipts')return route.fulfill({contentType:'application/json',body:JSON.stringify(await runtime.receipts())});
 if(!url.pathname.startsWith('/api/runtime/'))return route.abort();
 const body=request.postData()??undefined;
 let entry=null;
 if(body&&request.method()==='POST'&&ROUTES.includes(url.pathname)){
  const json=JSON.parse(body);
  entry={path:url.pathname,key:json.idempotencyKey,text:json.text,files:(json.files??[]).map(file=>({name:file.name,sha:sha(Buffer.from(file.base64,'base64'))})),at:Date.now()};
  wire.push(entry);
 }
 const response=await runtime.handle(new Request('http://localhost'+url.pathname+url.search,{method:request.method(),headers:{'content-type':'application/json'},...(body===undefined?{}:{body})}));
 const text=await response.text();
 if(entry){
  entry.status=response.status;
  if(entry.path==='/api/runtime/inject')entry.answer=text.slice(0,600);
  if(entry.path==='/api/runtime/inject'&&faults.holdInject){const hold=faults.holdInject;faults.holdInject=null;entry.answerHeld=true;await hold;entry.answerReleased=true;}
 }
 return route.fulfill({status:response.status,contentType:'application/json',body:text});
});
const page=await context.newPage();page.setDefaultTimeout(30000);
page.on('pageerror',error=>fs.appendFileSync(path.join(out,'page-errors.log'),String(error)+'\n'));
await page.goto(`https://native.invalid/?runtime=journal&inject=1&card=${encodeURIComponent(conversationId)}&queue=${encodeURIComponent(threadId)}&path=${encodeURIComponent(runtime.artifactPath)}`);
await page.locator('textarea').waitFor();

const document_=(name,bytes)=>({name,mimeType:'application/octet-stream',buffer:Buffer.from(Array.from({length:bytes},(_,index)=>(index*37+name.length)%256))});
const tiles=()=>page.evaluate(()=>document.querySelectorAll('[data-testid="attachment-tile"]').length);
const draft=()=>page.locator('textarea').inputValue();
const waitFor=async(check,what,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await Bun.sleep(50);}throw new Error('timed out: '+what);};
const stage=async(text,files)=>{
 await page.locator('textarea').fill(text);
 await page.locator('input[type=file]').first().setInputFiles(files);
 await page.waitForFunction(count=>[...document.querySelectorAll('[data-testid="attachment-tile"]')].filter(tile=>tile.dataset.status==='ready').length===count,files.length);
};
/* Leaves the composer empty for the next case, whatever the previous one did. */
const clear=async()=>{
 await page.keyboard.press('Escape').catch(()=>{});
 await page.locator('textarea').fill('');
 for(const remove of await page.locator('[data-testid="attachment-tile"] button[aria-label^="Remove "]').all())await remove.click().catch(()=>{});
 await waitFor(async()=>await tiles()===0,'the tray to empty');
};
const choose=async label=>{
 const item=page.getByRole('menuitem',{name:new RegExp(label)});
 if(!await item.isVisible().catch(()=>false))await page.getByRole('button',{name:'Send options',exact:true}).click();
 await item.click();
};
const posts=(route,since)=>wire.filter(entry=>entry.path===route&&entry.at>=since);
const carrying=(name,since)=>wire.filter(entry=>entry.at>=since&&entry.files.some(file=>file.name===name));
const injectRpc=name=>runtime.rpc.filter(call=>call.method==='thread/inject_items'&&(!name||JSON.stringify(call.params).includes(name))).length;
/* Long enough for a press that was going to reach the wire to have reached it. */
const quiet=()=>Bun.sleep(1500);
const results={codexVersion:Bun.spawnSync([values.codex,'--version']).stdout.toString().trim(),threadIdPrefix:threadId.slice(0,8),cases:{}};
const run=async(name,body)=>{
 const record={};results.cases[name]=record;
 try{await body(record);record.pass=true;}
 catch(error){record.pass=false;record.error=String(error?.message??error);}
 finally{fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(redact({results,wire}),null,2));}
};
const check=(record,ok,message)=>{if(!ok)throw new Error(message+': '+JSON.stringify(redact(record)));};

try{
 // 0. An ordinary message starts a turn; the provider keeps it open, so the thread is running.
 await page.locator('textarea').fill('Warm-up turn');
 await page.locator('textarea').press('Enter');
 await waitFor(()=>runtime.provider.open()===1,'the warm-up turn to reach the provider');
 await waitFor(async()=>(await runtime.host().health()).activeTurnRef!==null,'the warm-up turn to run');

 // 1. An unanswered Add to context is carrying a document. Alt+Enter and the
 //    menu's Queue for Codex both refuse, keeping the words typed for them; once
 //    the injection is answered the queued words go on their own.
 await run('heldInjectionThenQueue',async record=>{
  const since=Date.now();
  const notes=document_('held-injection-notes.bin',4096);
  await stage('Read the held-injection notes',[notes]);
  let release;faults.holdInject=new Promise(resolve=>{release=resolve;});
  try{
   await choose('Add to context');
   await waitFor(()=>posts('/api/runtime/inject',since).at(-1)?.answerHeld===true,'the injection to be admitted with its answer held');
   await page.locator('textarea').fill('Queue this for later');
   await page.locator('textarea').press('Alt+Enter');
   await quiet();
   record.altEnter={queuePosts:posts('/api/runtime/queue',since).length,carrying:carrying(notes.name,since).length,draft:await draft(),tiles:await tiles()};
   await choose('Queue for Codex');
   await quiet();
   record.menu={queuePosts:posts('/api/runtime/queue',since).length,carrying:carrying(notes.name,since).length,draft:await draft(),tiles:await tiles()};
  }finally{release();}
  const injection=posts('/api/runtime/inject',since)[0];
  await waitFor(()=>injection.answerReleased===true,'the held injection answer');
  record.injectStatus=injection.status;
  record.injectFileMatches=JSON.stringify(injection.files)===JSON.stringify([{name:notes.name,sha:sha(notes.buffer)}]);
  check(record,record.altEnter.queuePosts===0&&record.altEnter.carrying===1&&record.altEnter.draft==='Queue this for later'&&record.altEnter.tiles===1,
   'Alt+Enter handed a document an unanswered Add to context carries to the queue');
  check(record,record.menu.queuePosts===0&&record.menu.carrying===1&&record.menu.draft==='Queue this for later'&&record.menu.tiles===1,
   'Queue for Codex handed a document an unanswered Add to context carries to the queue');
  check(record,injection.status===202&&record.injectFileMatches,'The injection was not admitted with its document');
  await waitFor(async()=>await tiles()===0,'the accepted injection to take its document');
  await page.locator('textarea').press('Alt+Enter');
  await waitFor(()=>posts('/api/runtime/queue',since).length===1,'the queued words to reach the wire');
  await waitFor(()=>injectRpc(notes.name)===1,'Codex to receive the injection');
  await quiet();
  const queued=posts('/api/runtime/queue',since)[0];
  Object.assign(record,{queuedText:queued.text,queuedFiles:queued.files.length,queueStatus:queued.status,carryingTotal:carrying(notes.name,since).length,
   injectRpcCarryingNotes:injectRpc(notes.name),journalInjectOperations:runtime.journal.db.query('SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?').get(injection.key).n});
  check(record,record.queuedText==='Queue this for later'&&record.queuedFiles===0&&record.carryingTotal===1&&record.injectRpcCarryingNotes===1&&record.journalInjectOperations===1,
   'The document reached more than one operation');
 });
 await clear();

 // 2. A queue hand-off too large for the slot saves its envelope to IndexedDB
 //    first, holding its draft and document in the tray. Add to context during
 //    that save sends nothing; the hand-off then carries the document once.
 await run('heldQueueSaveThenInject',async record=>{
  const since=Date.now();const injectBefore=injectRpc();
  const large=document_('held-queue-save.bin',400*1024);
  await stage('Queue the large held-save document',[large]);
  await page.evaluate(()=>window.payloadFixture.holdStorage());
  try{
   await page.locator('textarea').press('Alt+Enter');
   await quiet();
   record.saving={queuePosts:posts('/api/runtime/queue',since).length,draft:await draft(),tiles:await tiles()};
   await choose('Add to context');
   await quiet();
   record.pressed={injectPosts:posts('/api/runtime/inject',since).length,carrying:carrying(large.name,since).length,draft:await draft()};
  }finally{await page.evaluate(()=>window.releasePayloadStorage?.());}
  check(record,record.saving.queuePosts===0&&record.saving.draft==='Queue the large held-save document'&&record.saving.tiles===1,'The held save did not hold the hand-off');
  check(record,record.pressed.injectPosts===0&&record.pressed.carrying===0,'Add to context carried a document a held queue save still holds');
  await waitFor(()=>posts('/api/runtime/queue',since).length===1&&posts('/api/runtime/queue',since)[0].status!==undefined,'the hand-off to reach the wire');
  await quiet();
  const queued=posts('/api/runtime/queue',since)[0];
  Object.assign(record,{queueStatus:queued.status,queuedFileMatches:JSON.stringify(queued.files)===JSON.stringify([{name:large.name,sha:sha(large.buffer)}]),
   carryingTotal:carrying(large.name,since).length,injectPostsTotal:posts('/api/runtime/inject',since).length,injectRpcDuring:injectRpc()-injectBefore,tilesAfter:await tiles()});
  check(record,record.queuedFileMatches&&record.carryingTotal===1&&record.injectPostsTotal===0&&record.injectRpcDuring===0&&record.tilesAfter===0,
   'The document reached more than one operation');
 });
 await clear();

 // 3. An ordinary send keeps its submission in IndexedDB before the wire.
 //    Add to context during that save sends nothing; the send carries the document once.
 await run('heldSendSaveThenInject',async record=>{
  const since=Date.now();const injectBefore=injectRpc();
  const notes=document_('held-send-save.bin',4096);
  await stage('Answer with the held-save notes',[notes]);
  await page.evaluate(()=>window.payloadFixture.holdStorage());
  try{
   await page.locator('textarea').press('Enter');
   await quiet();
   record.saving={sendPosts:posts('/api/runtime/send',since).length,draft:await draft(),tiles:await tiles()};
   await choose('Add to context');
   await quiet();
   record.pressed={injectPosts:posts('/api/runtime/inject',since).length,carrying:carrying(notes.name,since).length,draft:await draft()};
  }finally{await page.evaluate(()=>window.releasePayloadStorage?.());}
  check(record,record.saving.sendPosts===0&&record.saving.draft==='Answer with the held-save notes'&&record.saving.tiles===1,'The held save did not hold the send');
  check(record,record.pressed.injectPosts===0&&record.pressed.carrying===0,'Add to context carried a document a held send save still holds');
  await waitFor(()=>posts('/api/runtime/send',since).length===1&&posts('/api/runtime/send',since)[0].status!==undefined,'the send to reach the wire');
  await quiet();
  const sent=posts('/api/runtime/send',since)[0];
  Object.assign(record,{sendStatus:sent.status,sentFileMatches:JSON.stringify(sent.files)===JSON.stringify([{name:notes.name,sha:sha(notes.buffer)}]),
   carryingTotal:carrying(notes.name,since).length,injectPostsTotal:posts('/api/runtime/inject',since).length,injectRpcDuring:injectRpc()-injectBefore,tilesAfter:await tiles()});
  check(record,record.sentFileMatches&&record.carryingTotal===1&&record.injectPostsTotal===0&&record.injectRpcDuring===0&&record.tilesAfter===0,
   'The document reached more than one operation');
 });

 results.totals={providerRequests:runtime.provider.requests.length,injectItems:injectRpc(),queueAdds:runtime.rpc.filter(call=>call.method==='thread/queue/add').length,
  turnStarts:runtime.rpc.filter(call=>call.method==='turn/start').length};
 results.pass=Object.values(results.cases).every(record=>record.pass);
 fs.writeFileSync(path.join(out,'native-codex-injection-races.json'),JSON.stringify(redact(results),null,2));
 fs.writeFileSync(path.join(out,'wire.json'),JSON.stringify(redact(wire),null,2));
 console.log(JSON.stringify(redact(results)));
}finally{await context.close();await runtime.close();}
process.exit(results.pass?0:1);
