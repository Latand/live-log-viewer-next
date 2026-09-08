import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {browser,pageFor,out} from './revision3-browser.mjs';
const report={cases:[]};
try {
 for(const count of (process.env.BOARD_NAV_COUNT ? [Number(process.env.BOARD_NAV_COUNT)] : [24,100,1000])){
  const p=await pageFor('multi-'+count);await p.waitForFunction(()=>window.__productionBoard);
  if(count===24){
   await p.evaluate(()=>window.__productionBoard.zoom(.07));await p.waitForTimeout(150);
   const id=await p.evaluate(()=>window.__productionBoard.snapshot().tasks[0].id);
   await p.evaluate(id=>{const {tasks,cam,vp}=window.__productionBoard.snapshot(),task=tasks.find(t=>t.id===id);window.__productionBoard.camera({x:vp.w/2-task.pos.x*cam.z-130,y:vp.h/2-task.pos.y*cam.z-80,z:cam.z});},id);await p.waitForTimeout(150);
   const card=p.locator('[data-scheme-task='+JSON.stringify(id)+']');const before=await card.boundingBox();assert(before);
   await p.mouse.move(before.x+12,before.y+12);await p.mouse.down();await p.mouse.move(before.x+82,before.y+47,{steps:5});await p.mouse.up();await p.waitForTimeout(600);
   const after=await card.boundingBox();assert(after);assert(Math.abs(after.x-before.x-70)<1);assert(Math.abs(after.y-before.y-35)<1);
   const accepted=await p.evaluate(id=>window.__sampleTransport.tasks().find(t=>t.id===id),id);assert.equal(accepted.placement,'pinned');
   for(const z of [.58,.07]){await p.evaluate(z=>window.__productionBoard.zoom(z),z);await p.waitForTimeout(150);assert.deepEqual(await p.evaluate(id=>window.__productionBoard.snapshot().tasks.find(t=>t.id===id).pos,id),accepted.pos);}
   await p.screenshot({path:path.join(out,'production-pin-7.png')});
   await p.reload({waitUntil:'networkidle'});await p.waitForFunction(()=>window.__productionBoard);assert.deepEqual(await p.evaluate(id=>window.__productionBoard.snapshot().tasks.find(t=>t.id===id).pos,id),accepted.pos);
   report.pin={displacement:{x:after.x-before.x,y:after.y-before.y},accepted:accepted.pos,reloaded:true};
  }
  await p.getByRole('button',{name:'Task history',exact:true}).click();const panel=p.locator('[data-task-workflow-panel]');
  const ids=await panel.locator('option').evaluateAll(options=>options.map(o=>o.value).filter(Boolean));
  assert.equal(ids.length,Math.ceil(count/4));let reached=0;
  for(const id of ids){
   if(reached)await p.getByRole('button',{name:'Task history',exact:true}).click();
   await panel.locator('select').selectOption(id);const buttons=panel.locator('[data-work-reference] button');const last=buttons.last();
   const target=await last.getAttribute('data-conversation-path');assert(target);await last.click();
   await p.waitForFunction(target=>window.__productionBoard.snapshot().selected===target,target);reached++;if(reached%25===0)console.log(JSON.stringify({count,reached}));
  }
  report.cases.push({conversations:count,tasks:ids.length,lastWorkersOpened:reached,errors:p.errors});assert.deepEqual(p.errors,[]);await p.close();
 }
}finally{fs.writeFileSync(path.join(out,'production-navigation.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
