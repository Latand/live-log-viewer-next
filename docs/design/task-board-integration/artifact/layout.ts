import type { WorkNode, WorkEdge, Point } from './fixtures';
import { nodeFrame, type Camera } from './semantic';
export type Box = { x: number; y: number; w: number; h: number };
export const intersects = (a: Box, b: Box, gap = 0) => Math.min(a.x+a.w, b.x+b.w)-Math.max(a.x,b.x)>-gap && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>-gap;
export const envelope = (boxes: Box[], pad = 20, heading = 36): Box => {
  const x = Math.min(...boxes.map(b=>b.x))-pad, y = Math.min(...boxes.map(b=>b.y))-heading;
  return {x,y,w:Math.max(...boxes.map(b=>b.x+b.w))+pad-x,h:Math.max(...boxes.map(b=>b.y+b.h))+pad-y};
};
// Deterministic separation in authored order. A colliding later box moves
// along the less expensive positive axis, then is checked again.
function separate(items: {id:string; box:Box}[], gap: number, locked = new Set<string>()) {
  items.sort((a,b)=>Number(locked.has(b.id))-Number(locked.has(a.id)));
  for(let i=1;i<items.length;i++) {
    if(locked.has(items[i].id))continue;
    const b=items[i].box;
    for(let pass=0;pass<=i;pass++) {
      let moved=false;
      for(let j=0;j<i;j++) { const a=items[j].box;
        if(!intersects(a,b,gap)) continue;
        const dx=a.x+a.w+gap-b.x, dy=a.y+a.h+gap-b.y;
        if(dx<dy) b.x+=dx; else b.y+=dy;
        moved=true;
      }
      if(!moved) break;
    }
  }
}
export function layoutScene(nodes: WorkNode[], groups: {id:string;label:string;tone:string}[], camera:Camera, height:number, reader:string|null, dense:boolean, pins:Record<string,Point>) {
  const aggregate=camera.z<.22;
  const shown=aggregate ? nodes.filter(n=>n.kind==='task'||!n.group) : nodes;
  const frames=new Map(shown.map(n=>[n.id, aggregate ? {w:n.kind==='task'?240:184,h:104,native:false,nativeScale:1,rich:false} : nodeFrame(n,camera,height,reader,dense)]));
  const boxes=new Map<string,Box>(shown.map(n=>{ const p=pins[n.id]??n, f=frames.get(n.id)!; return [n.id,{x:p.x*camera.z-f.w/2,y:p.y*camera.z-f.h/2,w:f.w,h:f.h}] as const; }));
  if(aggregate){
    const taskGroups=groups.filter(g=>shown.some(n=>n.group===g.id));
    const columns=Math.min(3,taskGroups.length),width=columns*312-32;
    taskGroups.forEach((g,i)=>{const n=shown.find(n=>n.group===g.id)!;const b=boxes.get(n.id)!;if(pins[n.id])return;b.x=i%columns*312+20;b.y=180+Math.floor(i/columns)*192+36;});
    shown.filter(n=>!n.group).forEach((n,i)=>{const b=boxes.get(n.id)!;if(pins[n.id])return;b.x=width/2-b.w/2+i*212;b.y=0;});
  }
  const regions=groups.filter(g=>shown.some(n=>n.group===g.id)).map(g=>{
    const children=shown.filter(n=>n.group===g.id);
    const items=children.map(n=>({id:n.id,box:boxes.get(n.id)!}));
    const locked=new Set(children.filter(n=>pins[n.id]||n.id===reader).map(n=>n.id));
    separate(items,28,locked);
    return {...g,children:children.map(n=>n.id),box:envelope(items.map(i=>i.box))};
  });
  const loose=shown.filter(n=>!n.group).map(n=>({id:n.id,box:{...boxes.get(n.id)!},children:[n.id],label:'',tone:''}));
  const units=[...regions,...loose];
  const origins=new Map(units.map(g=>[g.id,{...g.box}]));
  const locked=new Set(units.filter(g=>g.children.some(id=>pins[id]||id===reader)).map(g=>g.id));
  separate(units,32,locked);
  for(const g of units){const origin=origins.get(g.id)!;const sx=g.box.x-origin.x,sy=g.box.y-origin.y;
    for(const id of g.children){const b=boxes.get(id)!;b.x+=sx;b.y+=sy;}
  }
  return {aggregate,shown,frames,boxes,regions,bounds:envelope(units.map(g=>g.box),0,0)};
}
// Ports and references use the same screen rectangle; arrow tips have zero gap.
export function ports(a:Box,b:Box,returned=false) {
  const ac={x:a.x+a.w/2,y:a.y+a.h/2},bc={x:b.x+b.w/2,y:b.y+b.h/2};
  if(returned){const y=Math.min(a.y,b.y)-22;return {start:{x:ac.x,y:a.y},end:{x:bc.x,y:b.y},d:`M ${ac.x} ${a.y} C ${ac.x} ${y}, ${bc.x} ${y}, ${bc.x} ${b.y}`,label:{x:(ac.x+bc.x)/2,y:y-5},ux:0,uy:1};}
  if(Math.abs(bc.x-ac.x)>Math.abs(bc.y-ac.y)){
    const s=bc.x>ac.x?1:-1,start={x:ac.x+s*a.w/2,y:ac.y},end={x:bc.x-s*b.w/2,y:bc.y},mid=(start.x+end.x)/2;
    return {start,end,d:`M ${start.x} ${start.y} C ${mid} ${start.y}, ${mid} ${end.y}, ${end.x} ${end.y}`,label:{x:mid,y:(ac.y+bc.y)/2-8},ux:s,uy:0};
  }
  const s=bc.y>ac.y?1:-1,start={x:ac.x,y:ac.y+s*a.h/2},end={x:bc.x,y:bc.y-s*b.h/2},mid=(start.y+end.y)/2;
  return {start,end,d:`M ${start.x} ${start.y} C ${start.x} ${mid}, ${end.x} ${mid}, ${end.x} ${end.y}`,label:{x:(ac.x+bc.x)/2+8,y:mid},ux:0,uy:s};
}
export function visibleEdges(edges:WorkEdge[],nodes:WorkNode[],aggregate:boolean){
  if(!aggregate)return edges;
  const owner=new Map(nodes.map(n=>[n.id,n.group?nodes.find(t=>t.kind==='task'&&t.group===n.group)?.id??n.id:n.id]));
  const seen=new Set<string>();
  return edges.flatMap(e=>{const from=owner.get(e.from)!,to=owner.get(e.to)!,key=from+':'+to;if(from===to||seen.has(key))return [];seen.add(key);return [{...e,from,to}];});
}
