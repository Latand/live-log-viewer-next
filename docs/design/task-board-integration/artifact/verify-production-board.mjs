import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {browser,pageFor,out} from './revision3-browser.mjs';
const report={subject:'production SchemeBoard, BranchPane, LogFeed, useLogTail, logBus, TmuxComposerCore',cases:[]};
try {
 console.log('production stress: opening');
 const p=await pageFor(process.env.BOARD_SCENE??'dense');console.log('production stress: ready');
 await p.waitForFunction(()=>window.__productionBoard);
 const snapshot=()=>p.evaluate(()=>window.__productionBoard.snapshot());
 await p.evaluate(()=>window.__productionBoard.zoom(1));await p.waitForTimeout(200);
 const initial=await snapshot();
 const paths=initial.nodes.slice(0,3).map(n=>n.path);
 for(const target of paths) {
  await p.evaluate(target=>{const {nodes,vp}=window.__productionBoard.snapshot(),n=nodes.find(n=>n.path===target);window.__productionBoard.camera({x:vp.w/2-n.x-n.w/2,y:vp.h/2-n.y-n.h/2,z:1});},target);
  await p.waitForTimeout(1000);console.log('production stress: warming '+target);
  if(process.env.BOARD_EXPECT_RED!=="1")await p.locator('[data-native-path='+JSON.stringify(target)+'] textarea').first().waitFor({state:"visible"});
 }
 await p.screenshot({path:path.join(out,'production-native-before.png')});
 assert.equal((await snapshot()).cam.z,1);
 const activePath=paths.at(-1);let deliveryKey=null;let cardId=null;let beforeHiddenAnchor=null;
 const input=p.locator('[data-native-path='+JSON.stringify(activePath)+'] textarea').first();
 if(process.env.BOARD_EXPECT_RED!=='1') {
  await input.waitFor({state:'visible'});
  const feed=p.locator('[data-native-path='+JSON.stringify(activePath)+'] [data-log-feed-scroller]');
  await p.evaluate(path=>{for(let i=0;i<80;i++)window.__fixtureSource.append(path,'assistant','Anchor history '+i);},activePath);
  await p.waitForTimeout(1500);
  await feed.hover();await p.mouse.wheel(0,-800);await p.waitForTimeout(300);
  const anchor=()=>feed.evaluate(el=>{const frame=el.getBoundingClientRect(),row=[...el.querySelectorAll('[data-feed-key]')].find(row=>row.getBoundingClientRect().bottom>frame.top);return row?{key:row.dataset.feedKey,offset:(row.getBoundingClientRect().top-frame.top)/(frame.height/el.clientHeight)}:null;});
  const beforeAnchor=await anchor();assert(beforeAnchor);
  await input.fill('Retained production draft');
  await input.evaluate(el=>el.setSelectionRange(3,11));
  const before=await p.locator('[data-native-owner]').count();
  await p.evaluate(path=>window.__productionBoard.expand(path),activePath);
  await p.waitForTimeout(700);
  assert.equal(await p.locator('[data-native-owner]').count(),before);
  const expanded=p.getByRole('dialog').locator('textarea').first();
  assert.equal(await expanded.inputValue(),'Retained production draft');
  assert.deepEqual(await expanded.evaluate(el=>[el.selectionStart,el.selectionEnd]),[3,11]);
  await p.screenshot({path:path.join(out,'production-native-full.png')});
  await p.evaluate(()=>window.__productionBoard.collapse());await p.waitForTimeout(700);
  assert.equal(await input.inputValue(),'Retained production draft');
  const afterAnchor=await anchor();assert.equal(afterAnchor?.key,beforeAnchor.key);assert(Math.abs(afterAnchor.offset-beforeAnchor.offset)<2);
 }
 console.log('production stress: retained reader checked');
 if(process.env.BOARD_RUNTIME==='1') {
  await input.fill('One original production delivery');
  await input.locator('xpath=ancestor::form').locator('button[type=submit]').click();
  await p.waitForFunction(()=>window.__sampleTransport.runtimeOperations().length===1);
  const operation=await p.evaluate(()=>window.__sampleTransport.runtimeOperations()[0]);
  deliveryKey=operation[0];cardId=operation[1].conversationId;
  console.log('production stress: waiting queued receipt');
  await p.waitForFunction(({id,key})=>window.__productionDelivery.runtime().store.sessions[id]?.recentReceipts.some(receipt=>receipt.idempotencyKey===key&&receipt.status==='queued'),{id:cardId,key:deliveryKey});
  assert.equal(operation[1].attempts,1);
  await input.fill('Next unsent draft');await input.evaluate(el=>el.setSelectionRange(2,8));
 }
 beforeHiddenAnchor=await p.locator('[data-native-path='+JSON.stringify(activePath)+'] [data-log-feed-scroller]').evaluate(el=>{const frame=el.getBoundingClientRect(),row=[...el.querySelectorAll('[data-feed-key]')].find(row=>row.getBoundingClientRect().bottom>frame.top);return row?.dataset.feedKey;});
 await p.evaluate(()=>window.__productionBoard.camera({x:-100000,y:-100000,z:1}));await p.waitForTimeout(1000);
 const read=()=>p.evaluate(()=>({native:structuredClone(window.__nativeCounters??{}),shell:structuredClone(window.__shellCounters??{}),parse:structuredClone(window.__sourceParses??{}),chrome:structuredClone(window.__chromeCounters??{}),owners:structuredClone(window.__ownerCounters??{}),timers:structuredClone(window.__viewTimers??{}),logCallbacks:structuredClone(window.__logCallbacks??{}),runtime:Object.fromEntries(Object.entries(window.__runtimeCallbacks??{}).filter(([key])=>key.startsWith("native:")))}));
 await p.evaluate(()=>{window.__hiddenMutations=0;window.__hiddenObservers=[...document.querySelectorAll('[data-native-owner]')].map(element=>{const observer=new MutationObserver(records=>window.__hiddenMutations+=records.length);observer.observe(element,{subtree:true,attributes:true,characterData:true,childList:true});return observer;});});
 const before=await read();const start=Date.now();
 if(process.env.BOARD_EXPECT_RED!=='1')for(const path of paths){
  assert(before.native[path]?.panes>0,'pane probe must be exercised');assert(before.shell[path]>0,'outer probe must be exercised');assert(before.chrome[path]>0,'chrome probe must be exercised');assert(before.owners[path]>0,'owner probe must be exercised');assert(before.logCallbacks[path]>0,'real log subscription must be exercised');
 }

 if(deliveryKey) {
  for(const state of ['uncertain','delivered']){
   await p.evaluate(({key,state})=>window.__sampleTransport.runtimeReceipt(key,state),{key:deliveryKey,state});await p.waitForFunction(({id,key,state})=>window.__productionDelivery.runtime().store.sessions[id]?.recentReceipts.some(receipt=>receipt.idempotencyKey===key&&receipt.status===state),{id:cardId,key:deliveryKey,state});
   const receipt=await p.evaluate(({id})=>window.__productionDelivery.runtime().store.sessions[id].recentReceipts[0],{id:cardId});
   assert.equal(receipt.status,state);assert.equal(receipt.idempotencyKey,deliveryKey);
   const outbox=await p.evaluate(id=>window.__productionDelivery.readOutbox(id),cardId);
   if(state==='uncertain')assert(outbox.some(entry=>entry.id===deliveryKey),'unknown delivery must retain the original outbox operation');

  }
 }
 if(deliveryKey)await p.evaluate(path=>window.__fixtureSource.append(path,'user','One original production delivery'),activePath);
 await p.evaluate(path=>{for(let i=0;i<100;i++)window.__fixtureSource.append(path,'assistant','Production incoming message '+i);},activePath);

 for(let i=0;i<20;i++){await p.evaluate(i=>window.__productionBoard.camera({x:-100000-i*20,y:-100000,z:1}),i);await p.waitForTimeout(25);}
 await p.waitForTimeout(21000);
 const after=await read();
 const changes=[];
 for(const bucket of Object.keys(after))for(const [key,value] of Object.entries(after[bucket]))if(JSON.stringify(value)!==JSON.stringify(before[bucket][key]))changes.push({bucket,key,before:before[bucket][key],after:value});
 const mutations=await p.evaluate(()=>{for(const observer of window.__hiddenObservers)observer.disconnect();return window.__hiddenMutations;});
 if(deliveryKey){
  const operation=await p.evaluate(()=>window.__sampleTransport.runtimeOperations()[0]);assert.equal(operation[0],deliveryKey);assert.equal(operation[1].attempts,1);
  await p.evaluate(path=>window.__productionBoard.expand(path),activePath);await p.waitForTimeout(700);
  assert.equal(await input.inputValue(),'Next unsent draft');assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[2,8]);
  await p.waitForTimeout(600);assert.equal(await p.locator('[data-native-path='+JSON.stringify(activePath)+'] [data-log-feed-scroller]').evaluate(el=>{const frame=el.getBoundingClientRect(),row=[...el.querySelectorAll('[data-feed-key]')].find(row=>row.getBoundingClientRect().bottom>frame.top);return row?.dataset.feedKey;}),beforeHiddenAnchor);assert.equal(await p.locator('[data-native-path='+JSON.stringify(activePath)+']').getByText('One original production delivery',{exact:true}).count(),1);
 }
 report.cases.push({paths,changes,mutations,deliveryKey,durationMs:Date.now()-start,errors:p.errors});

 if(process.env.BOARD_EXPECT_RED==='1')assert(changes.length>0,'baseline must expose hidden work');
 else {assert.deepEqual(changes,[],'hidden production views must remain dormant');assert.equal(mutations,0);}
 assert.deepEqual(p.errors,[]);
}finally{fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'production-board'+(process.env.BOARD_EXPECT_RED==='1'?'-red':'')+'.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
