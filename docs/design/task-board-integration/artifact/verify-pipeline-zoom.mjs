import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {browser,pageFor,out} from './revision3-browser.mjs';
const results=[];
try {
 for (const width of [1280,1440,1920]) for (const theme of ['light','dark']) {
  const p=await pageFor('pipelines',width,962,theme);
  await p.waitForFunction(()=>window.__productionBoard?.snapshot().groups.length===3, null, {timeout:30000});
  await p.evaluate(()=>window.__productionBoard.camera({x:80,y:130,z:.34}));
  await p.waitForTimeout(600);
  const result=await p.evaluate(()=>{
    const board=window.__productionBoard.snapshot();
    const groups=[...document.querySelectorAll('[data-scheme-group-id]')].map(el=>{
      const r=el.getBoundingClientRect(), h=el.querySelector('button').getBoundingClientRect();
      return {id:el.dataset.schemeGroupId,x:r.x,y:r.y,w:r.width,h:r.height,header:{x:h.x,y:h.y,w:h.width,h:h.height}};
    });
    const headers=groups.map(g=>g.header);
    const overlaps=headers.flatMap((a,i)=>headers.slice(i+1).filter(b=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y));
    const stagePixels=[...document.querySelectorAll("[data-pipeline-stage-label]")].map(el=>parseFloat(getComputedStyle(el).fontSize)*board.cam.z);
    return {groups,stagePixels,headerOverlaps:overlaps.length,nodes:board.nodes.map(n=>({path:n.path,w:n.w*.34,h:n.h*.34,presentation:n.presentation})),errors:[]};
  });
  await p.screenshot({path:path.join(out,`pipelines-${width}-${theme}.png`)});
  results.push({width,theme,...result});
  if(process.env.BOARD_EXPECT_FIXED==='1') {
    assert.equal(result.headerOverlaps,0);
    assert(result.groups.every(g=>g.header.x>=g.x && g.header.x+g.header.w<=g.x+g.w+1));
    assert(result.groups.every(g=>g.h<400),'compact one/two-stage pipeline height');
    assert(result.nodes.every(n=>n.presentation==='summary'));
    assert.equal(result.stagePixels.length,4);
    assert(result.stagePixels.every(size=>size>=10));
  }
  await p.close();
 }
} finally {fs.writeFileSync(path.join(out,'pipeline-zoom.json'),JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results));
