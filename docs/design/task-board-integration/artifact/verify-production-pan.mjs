import fs from 'node:fs';
import assert from 'node:assert/strict';
import {browser,pageFor,out} from './revision3-browser.mjs';
const cases=[];
try {
 for(const count of [24,100,1000]){
  const p=await pageFor('multi-'+count);await p.waitForFunction(()=>window.__productionBoard);
  await p.evaluate(()=>window.__productionBoard.camera({x:-100000,y:-100000,z:.4}));await p.waitForTimeout(700);
  const frames=[];
  for(let i=0;i<20;i++)frames.push(await p.evaluate(async i=>{
   const start=performance.now();window.__productionBoard.camera({x:-100000-i*20,y:-100000,z:.4});
   await new Promise(requestAnimationFrame);return performance.now()-start;
  },i));
  assert.deepEqual(p.errors,[]);cases.push({conversations:count,frames});await p.close();
 }
}finally{fs.writeFileSync(out+'/production-pan.json',JSON.stringify(cases,null,2));await browser.close();}
console.log(JSON.stringify(cases.map(c=>{const s=[...c.frames].sort((a,b)=>a-b);return {conversations:c.conversations,medianMs:s[10],p95Ms:s[18]};})));
