
import fs from 'node:fs';import path from 'node:path';import {browser,pageFor,focus,zoom,out} from './revision3-browser.mjs';
const findings=[];
try{for(const scene of ['workspace','dense'])for(const w of [1280,1440,1920]){
 const p=await pageFor(scene,w,w===1280?800:w===1440?900:1080);
 await focus(p,scene==='workspace'?'index':'dense-2-1');
 for(const z of [.32,.4,.52,.58,.6,.71,.8,.82,1]){
 await zoom(p,z);await p.waitForTimeout(90);
 const result=await p.evaluate(()=>{
  const r=document.querySelector('[data-board-preview]').getBoundingClientRect(),safe={x:r.x+16,y:r.y+64,right:r.right-16,bottom:r.bottom-74};
  const boxes=[...document.querySelectorAll('[data-map-node],[data-relation-node],[data-native-pane][data-eligible="true"]')].map(el=>{const b=el.getBoundingClientRect();return {id:el.dataset.mapNode??el.dataset.relationNode??el.dataset.nativePane,ref:!!el.dataset.relationNode,x:Math.max(b.x,safe.x),y:Math.max(b.y,safe.y),right:Math.min(b.right,safe.right),bottom:Math.min(b.bottom,safe.bottom)};}).filter(b=>b.x<b.right&&b.y<b.bottom);
  const overlaps=[];
  for(let i=0;i<boxes.length;i++)for(const b of boxes.slice(i+1)){const a=boxes[i];if(a.id!==b.id&&Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)overlaps.push([a,b]);}
  const tips=[...document.querySelectorAll('[data-edge]')].flatMap(el=>{const [x,y]=el.dataset.tip.split(',').map(Number);return x<16||x>r.width-16||y<64||y>r.height-74?[{edge:el.dataset.edge,x,y}]:[];});
  return {overlaps,tips};
 });
 if(result.overlaps.length||result.tips.length)findings.push({scene,w,z,...result});
 }
 await p.close();
}}finally{await browser.close();fs.writeFileSync(path.join(out,'displayed-inspection.json'),JSON.stringify(findings,null,2));}
console.log(JSON.stringify(findings));
