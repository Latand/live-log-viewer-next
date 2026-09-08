import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {browser,pageFor,out} from './revision3-browser.mjs';
const report={cases:[],failures:[]};
try{
 for(const width of (process.env.BOARD_QUICK==='1'?[Number(process.env.BOARD_WIDTH??1440)]:[1280,1440,1920]))for(const theme of (process.env.BOARD_QUICK==='1'?['light']:['light','dark'])){
  const p=await pageFor(process.env.BOARD_SCENE??'multi-24',width,900,theme);await p.waitForFunction(()=>window.__productionBoard);
  const readers=await p.evaluate(()=>window.__productionBoard.snapshot().nodes.map(n=>n.path));
  for(const reader of (process.env.BOARD_QUICK==='1'?readers.slice(0,1):readers))for(const z of [.07,.219,.22,.221,.4,.52,.58,.719,.72,.721,.819,.82,.821,1]){
   await p.evaluate(({reader,z})=>{window.__productionBoard.reader(reader);window.__productionBoard.zoom(z);},{reader,z});
   await p.waitForTimeout(30);
   await p.evaluate(reader=>{const {nodes,cam,vp}=window.__productionBoard.snapshot(),n=nodes.find(n=>n.path===reader);window.__productionBoard.camera({x:vp.w/2-(n.x+n.w/2)*cam.z,y:vp.h/2-(n.y+n.h/2)*cam.z,z:cam.z});},reader);
   await p.waitForTimeout(90);
   const result=await p.evaluate(()=>{
    const s=window.__productionBoard.snapshot(),failures=[];
    const viewport=document.querySelector('[aria-label^="Agent board"]').getBoundingClientRect();
    const displayed=new Map([...document.querySelectorAll('[data-scheme-node],[data-scheme-task]')].filter(el=>el.getBoundingClientRect().width>0).map(el=>[el.dataset.schemeNode??'task::'+el.dataset.schemeTask,el.getBoundingClientRect()]));
    const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.6 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.6;
    for(const [id,rect]of displayed){for(const [other,box]of displayed)if(id<other&&overlap(rect,box))failures.push('node overlap '+id+' / '+other);}
    const groups=[...document.querySelectorAll('[data-scheme-group-id]')];
    for(let i=0;i<groups.length;i++){
     const rect=groups[i].getBoundingClientRect(),group=s.groups.find(g=>g.key===groups[i].dataset.schemeGroupId);
     for(const key of group.members){const child=displayed.get(key);if(child&&(child.left<rect.left-.6||child.top<rect.top-.6||child.right>rect.right+.6||child.bottom>rect.bottom+.6))failures.push('containment '+key);}
     for(let j=i+1;j<groups.length;j++)if(overlap(rect,groups[j].getBoundingClientRect()))failures.push('group overlap');
    }
    const chips=[...document.querySelectorAll('[data-edge-chip]')].map(el=>el.getBoundingClientRect());
    for(let i=0;i<chips.length;i++)for(let j=i+1;j<chips.length;j++)if(overlap(chips[i],chips[j]))failures.push('continuation label overlap');
    let edgeChecks=0;
    for(const g of document.querySelectorAll('[data-task-edge]')){
     const target=displayed.get(g.dataset.taskEdgeTarget);if(!target)continue;
     const circle=g.querySelector('circle');const cx=Number(circle.getAttribute('cx')),cy=Number(circle.getAttribute('cy'));
     const x=viewport.left+s.cam.x+cx*s.cam.z,y=viewport.top+s.cam.y+cy*s.cam.z;
     const error=Math.min(Math.abs(x-target.left),Math.abs(x-target.right),Math.abs(y-target.top),Math.abs(y-target.bottom));
     if(error>1)failures.push('edge target error '+error);edgeChecks++;
     const line=g.querySelector('path'),matrix=line.getScreenCTM(),length=line.getTotalLength();
     for(let step=1;step<32;step++){
      const sample=line.getPointAtLength(length*step/32),point=new DOMPoint(sample.x,sample.y).matrixTransform(matrix);
      for(const [id,rect]of displayed){
       if(id===g.dataset.taskEdgeTarget||id==='task::'+g.dataset.taskEdgeSource)continue;
       if(point.x>rect.left+1&&point.x<rect.right-1&&point.y>rect.top+1&&point.y<rect.bottom-1){failures.push('edge crosses '+id+' from '+g.dataset.taskEdge+' route '+JSON.stringify(s.routes.find(([key])=>key===g.dataset.taskEdge))); step=32;break;}
      }
     }

    }
    return {failures,displayed:displayed.size,groups:groups.length,edgeChecks,cam:s.cam};
   });
   report.cases.push({width,theme,reader,z,...result});
   if(report.cases.length%28===0)console.log(JSON.stringify({progress:report.cases.length,width,theme}));
   if(result.failures.length){report.failures.push({width,theme,reader,z,failures:result.failures});await p.screenshot({path:path.join(out,'geometry-failure-'+width+'-'+theme+'-'+z+'.png')});throw Error(JSON.stringify(report.failures.at(-1)));}
   if(z===.58&&reader===readers[0])await p.screenshot({path:path.join(out,'production-geometry-'+width+'-'+theme+'.png')});
  }
  await p.close();console.log(JSON.stringify({width,theme,cases:report.cases.length}));
 }
}finally{fs.writeFileSync(path.join(out,'production-geometry'+(process.env.BOARD_QUICK==='1'?'-quick':'')+'.json'),JSON.stringify(report,null,2));await browser.close();}
assert.equal(report.failures.length,0);console.log(JSON.stringify({cases:report.cases.length,failures:report.failures.length}));
