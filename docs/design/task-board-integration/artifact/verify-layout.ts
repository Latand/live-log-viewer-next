
import { fixtureScene } from './fixtures';
import { layoutScene, intersects, ports } from './layout';
import assert from 'node:assert/strict';
const checks:any[]=[];
for(const sceneName of ['workspace','dense','scale-100','scale-1000']){
  const scene=fixtureScene(sceneName);
  const readers=scene.nodes.filter(n=>n.file);
  for(const height of [694,794,974]){
    for(const reader of (readers.length>24?readers.slice(0,3):readers)){
      for(const z of [.07,.14,.219,.22,.32,.4,.52,.58,.6,.71,.8,.82,1,1.35]){
        const l=layoutScene(scene.nodes,scene.groups,{x:0,y:0,z},height,reader.id,sceneName!=='workspace',{});
        const b=[...l.boxes];
        for(let i=0;i<b.length;i++)for(let j=i+1;j<b.length;j++)assert(!intersects(b[i][1],b[j][1]),sceneName+' '+z+' '+reader.id+' nodes '+b[i][0]+'/'+b[j][0]);
        for(let i=0;i<l.regions.length;i++){
          const g=l.regions[i],r=g.box;
          for(const id of g.children){const n=l.boxes.get(id)!;assert(n.x>=r.x+19.99&&n.y>=r.y+35.99&&n.x+n.w<=r.x+r.w-19.99&&n.y+n.h<=r.y+r.h-19.99,'containment '+id);}
          for(const h of l.regions.slice(i+1))assert(!intersects(r,h.box),'groups '+g.id+'/'+h.id);
        }
        checks.push({scene:sceneName,height,reader:reader.id,z,nodes:b.length,groups:l.regions.length});
      }
    }
  }
}
let pinChecks=0;
for(const sceneName of ['workspace','dense']){
  const scene=fixtureScene(sceneName);
  for(const pin of scene.nodes.filter(n=>n.kind==='task'||n.file)) {
  for(const z of [.07,.32,.58,.71,.82,1])for(const reader of scene.nodes.filter(n=>n.file)){
    const pos={x:pin.x-500,y:pin.y-500};
    const l=layoutScene(scene.nodes,scene.groups,{x:0,y:0,z},794,reader.id,sceneName==='dense',{[pin.id]:pos});
    if(l.boxes.has(pin.id)){const b=l.boxes.get(pin.id)!;assert(Math.abs(b.x+b.w/2-pos.x*z)<.001&&Math.abs(b.y+b.h/2-pos.y*z)<.001,'pin moved');pinChecks++;}
  }
}
}
await Bun.write(new URL('./out/revision3/layout-checks.json',import.meta.url),JSON.stringify({checks:checks.length,pinChecks,violations:0,cases:checks},null,2));
console.log(JSON.stringify({checks:checks.length,pinChecks,violations:0}));
