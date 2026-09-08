
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import os from 'node:os';
import {browser,pageFor,snapshot,focus,zoom,out} from './revision3-browser.mjs';
const report={transport:'isolated browser artifact routing; no preview server',hardware:{cpu:os.cpus()[0].model,cores:os.cpus().length},matrix:[],counters:[],behaviors:[],errors:[]};
const settle=p=>p.waitForTimeout(120);
const shot=(p,name)=>p.screenshot({path:path.join(out,name+'.png')});
const counters=p=>p.evaluate(()=>({native:window.__nativeCounters??{},view:window.__viewCounters??{},feed:window.__feedInputs??{},parses:window.__sourceParses??{}}));
function geometry(s){
  const overlap=(a,b)=>Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>.1&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>.1;
  for(let i=0;i<s.geometry.length;i++)for(const b of s.geometry.slice(i+1))assert(!overlap(s.geometry[i],b),'node overlap');
  for(let i=0;i<s.regions.length;i++){
    const g=s.regions[i],r=g.box;
    for(const id of g.children){const b=s.geometry.find(n=>n.id===id);assert(b.x>=r.x+19.9&&b.y>=r.y+35.9&&b.x+b.w<=r.x+r.w-19.9&&b.y+b.h<=r.y+r.h-19.9,'group containment');}
    for(const h of s.regions.slice(i+1))assert(!overlap(r,h.box),'group overlap');
  }
}
async function endpoints(p){
 return p.evaluate(()=>{
  const board=document.querySelector('[data-board-preview]').getBoundingClientRect();
  return [...document.querySelectorAll('[data-edge]')].map(e=>{
    const id=e.dataset.edge.split(':')[1],el=document.querySelector('[data-relation-node="'+id+'"]')??document.querySelector('[data-native-pane="'+id+'"][data-eligible="true"]')??document.querySelector('[data-map-node="'+id+'"]');
    if(!el)return {edge:e.dataset.edge,error:'missing target'};
    let r=el.getBoundingClientRect();if(e.dataset.continuation){r={left:Math.max(r.left,board.x+16),right:Math.min(r.right,board.right-16),top:Math.max(r.top,board.y+64),bottom:Math.min(r.bottom,board.bottom-74)};}const [x,y]=e.dataset.tip.split(',').map(Number),px=x+board.x,py=y+board.y;
    const error=Math.min(Math.abs(px-r.left)+Math.max(r.top-py,py-r.bottom,0),Math.abs(px-r.right)+Math.max(r.top-py,py-r.bottom,0),Math.abs(py-r.top)+Math.max(r.left-px,px-r.right,0),Math.abs(py-r.bottom)+Math.max(r.left-px,px-r.right,0));
    return {edge:e.dataset.edge,error};
  });
 });
}
try{
 if(!process.argv.includes('--counters-only'))for(const scene of ['workspace','dense'])for(const [w,h] of [[1280,800],[1440,900],[1920,1080]])for(const theme of ['light','dark']){
  const p=await pageFor(scene,w,h,theme),id=scene==='workspace'?'index':'dense-2-1',name=scene+'-'+w+'-'+theme;
  geometry(await snapshot(p));await shot(p,name+'-fit');
  await focus(p,id);await settle(p);
  for(const z of [1,.82,.8,.71,.6,.58,.52,.4,.32,.22,.14,.07,.14,.22,.32,.4,.52,.58,.6,.71,.8,.82,1]){
    await zoom(p,z);await settle(p);const s=await snapshot(p);geometry(s);
    const ports=await endpoints(p);assert(ports.every(x=>x.error<1.5),JSON.stringify(ports));
    if([1,.71,.58,.4,.07].includes(z)&&!report.matrix.some(c=>c.name===name&&c.z===z))await shot(p,name+'-'+Math.round(z*100));
    report.matrix.push({name,z,regions:s.regions.length,nodes:s.geometry.length,ports:ports.length,containment:true,overlaps:0,maxPortError:Math.max(0,...ports.map(e=>e.error))});
  }
  report.errors.push(...p.errors);await p.close();
 }
 if(!process.argv.includes('--matrix-only'))for(const scene of ['dense','scale-100','scale-1000']){
  const p=await pageFor(scene);
  // Warm every dense conversation; scale scenes sample three native lifetimes.
  const s=await snapshot(p),ids=s.nodes.filter(n=>n.kind==='conversation').map(n=>n.id);
  for(const id of (scene==='dense'?ids:ids.slice(0,3))){await focus(p,id);await settle(p);}
  await p.evaluate(()=>window.__boardPreview.fit());await p.waitForTimeout(400);
  const before=await counters(p);
  await p.evaluate(()=>{
    window.__hiddenMutations=0;
    for(const e of document.querySelectorAll('.fb-native-clip'))new MutationObserver(ms=>window.__hiddenMutations+=ms.length).observe(e,{subtree:true,childList:true,characterData:true,attributes:true});
  });
  const frames=[];
  for(let i=0;i<20;i++){
    frames.push(await p.evaluate(async i=>{
      const start=performance.now(),c=window.__boardPreview.snapshot().camera;
      window.__boardPreview.camera({...c,x:c.x+(i%2?8:-8)});
      await new Promise(requestAnimationFrame);return performance.now()-start;
    },i));
  }
  await p.evaluate(ids=>{
    for(let i=0;i<100;i++)window.__fixtureSource.append('/fixture/conversations/'+ids[i%ids.length]+'.jsonl','assistant','Hidden backlog record '+i);
    for(const state of ['pending','accepted','unknown','terminal'])window.__fixtureSource.receipt('original-key-'+state,state);
  },ids);
  await p.waitForTimeout(21000);
  const after=await counters(p),metrics=await p.evaluate(()=>({mutations:window.__hiddenMutations,eligible:document.querySelectorAll('[data-eligible="true"]').length,dom:document.getElementsByTagName('*').length,longTasks:window.__longTasks,durable:window.__durableFixture}));
  assert.deepEqual(after,before,'hidden content executed in '+scene);assert.equal(metrics.mutations,0);
  assert.equal(Object.values(metrics.durable.messages).reduce((a,b)=>a+b,0),100);
  assert.equal(metrics.eligible,0);assert.equal(Object.values(after.view).reduce((n,c)=>n+(c.active??0),0),0);
  report.counters.push({scene,conversations:ids.length,panCount:20,hiddenMessages:100,waitMs:21000,delta:'zero',frames,metrics,before,after});
  await shot(p,scene+'-scale-overview');
  await focus(p,ids[0]);await settle(p);
  assert.equal(await p.locator('[data-eligible="true"]').count(),1);
  const lines=await p.locator('[data-eligible="true"] [data-log-feed-scroller]').getAttribute('data-tail-line-count');
  assert.equal(Number(lines),await p.evaluate(id=>window.__fixtureSource.lines('/fixture/conversations/'+id+'.jsonl').length,ids[0]));
  // Camera-only moves with unchanged eligibility leave active content stable too.
  const activeBefore=await counters(p);
  for(let i=0;i<20;i++){await p.evaluate(i=>{const c=window.__boardPreview.snapshot().camera;window.__boardPreview.camera({...c,x:c.x+(i%2?2:-2)});},i);await p.waitForTimeout(10);}
  assert.deepEqual(await counters(p),activeBefore,'active camera-only renders');
  report.behaviors.push({scene,reentryLines:Number(lines),activeCameraRenders:0});
  report.errors.push(...p.errors);await p.close();
 }
 assert.equal(report.errors.length,0);
}finally{
 fs.writeFileSync(path.join(out,process.argv.includes('--matrix-only')?'matrix.json':process.argv.includes('--counters-only')?'counters.json':'verification.json'),JSON.stringify(report,null,2));await browser.close();
}
console.log(JSON.stringify({matrix:report.matrix.length,counters:report.counters.length,behaviors:report.behaviors,errors:report.errors}));
