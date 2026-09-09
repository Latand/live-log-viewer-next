'use client';

import { Activity, Component, memo, useMemo, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointer } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpRight, Check, CircleHelp, Focus, Grip, Info, Minus, Moon, MoreHorizontal, Pin, Plus, Sun, X } from 'lucide-react';
import { BranchPane } from '@/components/BranchPane';
import { SchemeBoard as NativeBoard } from '@native-board';
import { appendMessage, files, fixtureScene, latestSummary, selectFixtureScene, type Point, type WorkEdge, type WorkNode } from './fixtures';
import { layoutScene, intersects, ports, visibleEdges, type Box } from './layout';
import { nodeFrame, essentialRole, essentialState, W, H, type Camera } from './semantic';

type Visit = { camera: Camera; reader: string | null; selected: string | null };
type Saved = { camera: Camera | null; pins: Record<string, Point>; selected: string | null; reader: string | null; history: Visit[] };
const saved: Saved = { camera: null, pins: {}, selected: null, reader: null, history: [] };
const editable = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('input,textarea,[contenteditable=true]'));
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const stateText = { running: 'Working', waiting: '1 finding', done: 'Complete', queued: 'Waiting for review' };

export function SchemeBoard(props: any) {
  if (new URLSearchParams(location.search).has('baseline')) return <NativeBoard {...props} />;
  return <FreshBoard {...props} />;
}

function FreshBoard(props: any) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [camera, setCamera] = useState<Camera>(saved.camera ?? { x: 0, y: 0, z: .2 });
  const cam = useRef(camera); cam.current = camera;
  const [pins, setPins] = useState(saved.pins);
  const [selected, setSelected] = useState<string | null>(saved.selected);
  const [reader, setReader] = useState<string | null>(saved.reader);
  const [trail, setTrail] = useState<Visit[]>(saved.history);
  const [context, setContext] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<WorkNode | null>(null);
  const [notice, setNotice] = useState('');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'light');
  const [extra, setExtra] = useState<WorkNode[]>([]);
  const [scenario, setScenario] = useState<string>(() => new URLSearchParams(location.search).get('scene') ?? 'workspace');
  const suppressClick = useRef(false);
  const holdingSpace = useRef(false);
  const gesture = useRef<{ id: number; kind: 'pan' | 'node'; start: Point; initial: Camera; node?: WorkNode; origin?: Point; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; center: Point; camera: Camera } | null>(null);
  const state = useRef<any>(null);
  const scene = fixtureScene(scenario);
  const activeNodes = [...scene.nodes, ...extra];
  const activeEdges: WorkEdge[] = [...scene.edges, ...extra.map(n => ({ from: scenario === 'dense' ? 'dense-6-3' : 'integrate', to: n.id }))];
  const near = camera.z >= .82;
  const layout = useMemo(() => layoutScene(activeNodes, scene.groups, camera, size.h || 794, reader, scenario !== 'workspace', pins), [scenario, extra, camera.z, size.h, reader, pins]);
  const at = (n: WorkNode) => { const b = layout.boxes.get(n.id); return b ? { x: (b.x+b.w/2)/camera.z, y: (b.y+b.h/2)/camera.z } : pins[n.id] ?? n; };
  const actions = useRef<any>(null);
  actions.current = { start, pinNode, openConversation, close: () => setExpanded(null), details: (n: WorkNode) => { setSelected(n.id); setContext(n.id); } };
  const selectedNode = activeNodes.find(n => n.id === selected);
  const readingNode = activeNodes.find(n => n.id === reader && n.kind === 'conversation');
  const frame = (n: WorkNode) => nodeFrame(n, camera, size.h || 794, reader, scenario === 'dense');

  useEffect(() => {
    saved.camera = camera; saved.pins = pins; saved.selected = selected; saved.reader = reader; saved.history = trail;
  }, [camera, pins, selected, reader, trail]);

  function remember() {
    const previous = { camera: { ...cam.current }, reader, selected };
    setTrail(prev => [...prev.slice(-11), previous]);
  }
  function move(next: Camera) { cam.current = next; setCamera(next); }
  function fit(rememberPlace = true) {
    const element = viewport.current; if (!element) return;
    const bounds = element.getBoundingClientRect();
    let z = .38;
    let fitted = layoutScene(activeNodes, scene.groups, {x:0,y:0,z}, bounds.height, null, scenario !== 'workspace', pins);
    while ((fitted.bounds.w > bounds.width-70 || fitted.bounds.h > bounds.height-150) && z > .071) {
      z = Math.max(.07,z*.85);
      fitted = layoutScene(activeNodes, scene.groups, {x:0,y:0,z}, bounds.height, null, scenario !== 'workspace', pins);
    }
    if (rememberPlace) remember();
    setReader(null);
    move({z, x:(bounds.width-fitted.bounds.w)/2-fitted.bounds.x, y:70+(bounds.height-140-fitted.bounds.h)/2-fitted.bounds.y});
  }

  function focus(n: WorkNode) {
    setSelected(n.id); setContext(null);
    if (n.kind !== 'conversation') { setContext(n.id); return; }
    setReader(n.id); remember();
    const z = Math.min(1, (size.h - 160) / H);
    const target = layoutScene(activeNodes, scene.groups, {x:0,y:0,z}, size.h, n.id, scenario !== 'workspace', pins).boxes.get(n.id)!;
    const p = {x:(target.x+target.w/2)/z,y:(target.y+target.h/2)/z};
    move({ z, x: size.w / 2 - p.x * z, y: (size.h - 10) / 2 - p.y * z });
  }
  function back() {
    if (expanded) { setExpanded(null); return; }
    if (context) { setContext(null); return; }
    if (!trail.length) return;
    const visit = trail[trail.length - 1];
    move(visit.camera); setReader(visit.reader); setSelected(visit.selected); setTrail(prev => prev.slice(0, -1));
  }
  function zoom(factor: number, anchor = { x: size.w / 2, y: size.h / 2 }) {
    const prior = cam.current, z = clamp(prior.z * factor, .07, 1.35);
    const next = { z, x: anchor.x - (anchor.x - prior.x) / prior.z * z, y: anchor.y - (anchor.y - prior.y) / prior.z * z };
    if(z===.07){
      const overview=layoutScene(activeNodes,scene.groups,{x:0,y:0,z},size.h,null,scenario!=='workspace',pins).bounds;
      next.x=(size.w-overview.w)/2-overview.x;
      next.y=70+(size.h-140-overview.h)/2-overview.y;
    }
    if (!readingNode && z > .52) {
      const candidates = activeNodes.filter(n => n.file).map(n => ({ n, x: next.x + at(n).x * z, y: next.y + at(n).y * z }))
        .filter(p => p.x > 40 && p.x < size.w - 40 && p.y > 60 && p.y < size.h - 60)
        .sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y));
      if (candidates[0]) setReader(candidates[0].n.id);
    }
    move(next);
  }
  function release(id: string) {
    setPins(prev => { const next = { ...prev }; delete next[id]; return next; });
    setNotice('Returned to automatic position');
  }
  function pinNode(n: WorkNode) {
    if (pins[n.id]) release(n.id);
    else { setPins(prev => ({ ...prev, [n.id]: { ...at(n) } })); setNotice('Position pinned'); }
  }
  function openConversation(n: WorkNode) {
    setSelected(n.id); setReader(n.id); setContext(null); setExpanded(n);
    props.onConversationOpened?.(n.file?.path);
  }
  useEffect(() => {
    const n = activeNodes.find(n => n.file?.path === props.focus);
    if (n && size.w && n.id !== reader) focus(n);
  }, [props.focus]);
  useEffect(() => {
    const el = viewport.current!;
    let first = true;
    const observer = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect;
      setSize({ w, h });
      if (first && !saved.camera) fit(false);
      first = false;
    });
    observer.observe(el);
    // The first effect may have already saved the initial camera.
    if (saved.camera?.x === 0 && saved.camera?.y === 0) fit(false);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement;
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.fb-expanded [aria-label$="(Esc)"]')?.focus({ preventScroll: true }));
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [expanded]);
  state.current = { camera, pins, selected, trail, size, near, reader, scenario, nodes: activeNodes.map(n => ({ id: n.id, kind: n.kind, x: at(n).x, y: at(n).y })), context, expanded: expanded?.id ?? null, aggregate:layout.aggregate, geometry:[...layout.boxes].map(([id,b])=>({id,...b})), regions:layout.regions };
  useEffect(() => {
    (window as any).__boardPreview = { snapshot: () => state.current, camera: (next: Camera) => move(next), zoom: (z: number) => zoom(z/cam.current.z), expand: (id:string) => { const n=activeNodes.find(n=>n.id===id); if(n) openConversation(n); },
      focus: (id: string) => { const n = activeNodes.find(n => n.id === id); if (n) focus(n); },
      fit: () => fit(), update: () => { const n = readingNode ?? activeNodes.find(n => n.file); if (n?.file) appendMessage(n.file.path, 'assistant', 'The sample check is complete. The related worker can now review the result.'); } };

  });
  useEffect(() => {
    const el = viewport.current!;
    const onWheel = (event: WheelEvent) => {
      if (expanded || !(event.target as Element).closest('[data-board-preview],[data-native-pane]')) return;
      if (context && (event.target as Element).closest('.fb-popover')) return;
      const insideConversation = (event.target as Element).closest('[data-native-pane]');
      if (insideConversation && !event.ctrlKey && !event.metaKey && !holdingSpace.current) return;
      event.preventDefault();
      const r = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * .007), { x: event.clientX - r.left, y: event.clientY - r.top });
      else move({ ...cam.current, x: cam.current.x - event.deltaX, y: cam.current.y - event.deltaY });
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (expanded || context)) { event.preventDefault(); back(); return; }
      if (expanded && event.key === 'Tab') {
        const controls = [...document.querySelectorAll<HTMLElement>('.fb-expanded button:not([disabled]),.fb-expanded textarea,.fb-expanded input,.fb-expanded [tabindex="0"]')].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (expanded || editable(event.target)) return;
      if (event.code === 'Space' && !(event.target as Element)?.closest('button')) { holdingSpace.current = true; event.preventDefault(); }
      if (event.key === 'Escape') { event.preventDefault(); back(); }
      if (event.key === 'Home' || event.key === '0') { event.preventDefault(); fit(); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.25); }
      if (event.key === '-') { event.preventDefault(); zoom(.8); }
      if (event.key.toLowerCase() === 'p' && selectedNode) { event.preventDefault(); pinNode(selectedNode); }
      if (event.key.toLowerCase() === 'r' && selectedNode && pins[selectedNode.id]) { event.preventDefault(); release(selectedNode.id); }
      if (event.key === '?' && !event.ctrlKey) setContext(prev => prev === 'help' ? null : 'help');
      if (event.altKey && selectedNode && event.key.startsWith('Arrow')) {
        event.preventDefault();
        const p = at(selectedNode), delta = 30 / camera.z;
        setPins(prev => ({ ...prev, [selectedNode.id]: { x: p.x + (event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0), y: p.y + (event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0) } }));
      }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') holdingSpace.current = false; };
    const blur = () => { holdingSpace.current = false; };
    window.addEventListener('keydown', key); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  });

  function start(event: ReactPointer, node?: WorkNode) {
    if (event.button !== 0 && event.button !== 1) return;
    if (!node && (event.target as Element).closest('button,input,textarea,[data-native-pane],.fb-popover') && !holdingSpace.current) return;
    if (node && (event.target as Element).closest('button,input,textarea') && !(event.target as Element).closest('[data-map-node]')) return;
    const target = viewport.current!;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = target.getBoundingClientRect();
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }, camera: { ...cam.current } };
      gesture.current = null;
    } else {
      gesture.current = { id: event.pointerId, kind: node && !holdingSpace.current ? 'node' : 'pan', start: { x: event.clientX, y: event.clientY }, initial: { ...cam.current }, node, origin: node ? at(node) : undefined, moved: false };
    }
    suppressClick.current = false;
    if (node) { setSelected(node.id); if (node.kind === 'conversation' && frame(node).native) setReader(node.id); event.stopPropagation(); }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (event.button === 1) event.preventDefault();
  }
  function drag(event: ReactPointer) {
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()], p = pinch.current;
      const z = clamp(p.camera.z * Math.hypot(a.x - b.x, a.y - b.y) / p.distance, .07, 1.35);
      const r = viewport.current!.getBoundingClientRect();
      move({ z, x: (a.x + b.x) / 2 - r.left - (p.center.x - p.camera.x) / p.camera.z * z, y: (a.y + b.y) / 2 - r.top - (p.center.y - p.camera.y) / p.camera.z * z });
      return;
    }
    const g = gesture.current; if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.start.x, dy = event.clientY - g.start.y;
    if (Math.hypot(dx, dy) < 4 && !g.moved) return;
    g.moved = true;
    if (g.kind === 'pan') move({ ...g.initial, x: g.initial.x + dx, y: g.initial.y + dy });
    else if (g.node && g.origin) setPins(prev => ({ ...prev, [g.node!.id]: { x: g.origin!.x + dx / g.initial.z, y: g.origin!.y + dy / g.initial.z } }));
  }
  function end(event: ReactPointer) {
    pointers.current.delete(event.pointerId);
    if (pinch.current) { if (pointers.current.size < 2) pinch.current = null; gesture.current = null; suppressClick.current = true; return; }
    const g = gesture.current; gesture.current = null;
    suppressClick.current = Boolean(g?.moved || event.type === 'pointercancel');
    if (g?.node && g.moved) setNotice('Position pinned · R to release');
  }

  function activate(n: WorkNode) {
    if (suppressClick.current) { suppressClick.current = false; return; }
    focus(n);
  }
  const byId = new Map(activeNodes.map(n => [n.id, n]));
  const detailNode = activeNodes.find(n => n.id === context);
  const screen = new Map([...layout.boxes].map(([id,b])=>[id,{...b,x:b.x+camera.x,y:b.y+camera.y}]));
  const safe = {x:16,y:64,w:size.w-32,h:size.h-138};
  const edges = visibleEdges(activeEdges,activeNodes,layout.aggregate);
  const markers: {node:WorkNode;box:Box;side:string}[]=[];
  // Only wholly offscreen neighbors need a boundary reference.
  if(reader && !layout.aggregate && screen.has(reader) && intersects(screen.get(reader)!,safe)) {
    const neighbors=new Set(edges.filter(e=>e.from===reader||e.to===reader).map(e=>e.from===reader?e.to:e.from));
    for(const id of neighbors){const b=screen.get(id);if(!b||intersects(b,safe))continue;
      const side=b.x+b.w/2 < size.w/2?'left':'right';
      markers.push({node:byId.get(id)!,side,box:{x:side==='left'?18:size.w-208,y:116,w:190,h:88}});
    }
    const occupied=[...screen.values()].filter(b=>intersects(b,safe));
    for(const m of markers){
      let placed=false;
      for(const height of [88,32]){
        for(const side of [m.side,m.side==='left'?'right':'left']){
          for(let y=116;y+height<=safe.y+safe.h-8;y+=8){
            const candidate={x:side==='left'?18:size.w-208,y,w:190,h:height};
            if(occupied.some(b=>intersects(candidate,b,8)))continue;
            m.box=candidate;m.side=side;occupied.push(candidate);placed=true;break;
          }
          if(placed)break;
        }
        if(placed)break;
      }
    }
  }
  const clipped=new Set<string>();
  const displayed = new Map([...screen].map(([id,b])=>{
    if(!intersects(b,safe))return [id,b];
    const x=Math.max(b.x,safe.x),y=Math.max(b.y,safe.y),right=Math.min(b.x+b.w,safe.x+safe.w),bottom=Math.min(b.y+b.h,safe.y+safe.h);
    if(x!==b.x||y!==b.y||right!==b.x+b.w||bottom!==b.y+b.h)clipped.add(id);
    return [id,{x,y,w:right-x,h:bottom-y}];
  }));
  for(const m of markers) displayed.set(m.node.id,m.box);
  const nativeBounds=viewport.current?.getBoundingClientRect();
  const labelledContinuations=new Set<string>();
  return <div ref={viewport} className={['fb-viewport',near?'fb-near':'fb-far',scenario==='dense'?'fb-dense':''].join(' ')} data-board-preview data-zoom={camera.z.toFixed(4)}
    tabIndex={-1} aria-label="Conversation board"
    onScroll={event=>{event.currentTarget.scrollLeft=0;event.currentTarget.scrollTop=0;}}
    onPointerDown={e => start(e)} onPointerMove={drag} onPointerUp={end} onPointerCancel={end}
    onDoubleClick={e => { if (!(e.target as Element).closest('button,[data-native-pane],.fb-popover')) fit(); }}>
    <div className="fb-scene-clip"><div className="fb-world" style={{transform:'translate('+camera.x+'px,'+camera.y+'px)'}}>
      <svg className="fb-graph" aria-label="Task ownership and pipeline relationships">
        {layout.regions.map(g=><g key={g.id} data-group-id={g.id} className={'fb-group fb-'+g.tone}>
          <rect x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx={16} fill="var(--fb-group-fill)" stroke="var(--fb-group-line)" />
          {!layout.aggregate && intersects({...g.box,x:g.box.x+camera.x,y:g.box.y+camera.y},safe) && <text x={Math.max(g.box.x+20,20-camera.x)} y={Math.max(g.box.y+23,82-camera.y)} fontSize={12} className="fb-group-label">{g.label}</text>}
        </g>)}
      </svg>
      {layout.shown.filter(n => { const b = screen.get(n.id); return b && intersects(b, safe); }).map(n=>{
        const b=layout.boxes.get(n.id)!,f=layout.frames.get(n.id)!,pinned=Boolean(pins[n.id]),taskRich=n.kind==='task'&&f.rich;
        const children=activeNodes.filter(c=>c.group===n.group&&c.kind==='conversation');
        return <div key={n.id} className={'fb-node-anchor '+(selected===n.id?'fb-selected':'')} style={{left:b.x,top:b.y}} data-node-id={n.id}>
          {!f.native && <button data-map-node={n.id} title={n.title} className={['fb-map-node','fb-kind-'+n.kind,'fb-status-'+n.status,taskRich?'fb-task-near':'',layout.aggregate?'fb-aggregate':'',f.rich&&n.kind==='conversation'?'fb-reading-summary':''].join(' ')}
            style={{width:b.w,height:b.h}} aria-label={n.title+'. '+essentialRole(n)+'. '+essentialState(n)}
            onPointerDown={e=>start(e,n)} onClick={e=>{if(e.detail===0)suppressClick.current=false;activate(n);}} onFocus={()=>setSelected(n.id)}>
            <span className="fb-node-role">{essentialRole(n)}{pinned&&<Pin size={11}/>}</span>
            <span className="fb-node-title">{n.title}</span>
            {f.rich&&f.h>180&&<span className="fb-task-description">{n.kind==='conversation'?latestSummary(n):n.detail}</span>}
            <span className="fb-node-status"><span className="fb-dot"/>{layout.aggregate&&n.kind==='task'?essentialState(n)+' · '+children.length+' conversations · '+children.filter(c=>c.status==='waiting').length+' returned':essentialState(n)}</span>
          </button>}
        </div>;
      })}
    </div>
    <svg className="fb-screen-edges" aria-label="Displayed relationship endpoints">
      {edges.map((edge,i)=>{
        const a=displayed.get(edge.from),b=displayed.get(edge.to);
        if(!a||!b||!intersects(a,safe)||!intersects(b,safe))return null;
        let port=ports(a,b,edge.kind==='fail');
        if(layout.aggregate && edge.kind==='assignment'){
          const sx=a.x+a.w/2,sy=a.y+a.h,gutter=b.x-28,ty=b.y+b.h/2;
          port={...port,start:{x:sx,y:sy},end:{x:b.x,y:ty},ux:1,uy:0,d:'M '+sx+' '+sy+' L '+sx+' '+(sy+24)+' L '+gutter+' '+(sy+24)+' L '+gutter+' '+ty+' L '+b.x+' '+ty};
        }
        const {x:tx,y:ty}=port.end,{ux,uy}=port;
        const continuation=clipped.has(edge.to)&&(Math.abs(tx-safe.x)<.01||Math.abs(tx-safe.x-safe.w)<.01||Math.abs(ty-safe.y)<.01||Math.abs(ty-safe.y-safe.h)<.01);
        const labelContinuation=continuation&&!labelledContinuations.has(edge.to);
        if(labelContinuation)labelledContinuations.add(edge.to);
        const arrow='M '+(tx-ux*6-uy*3)+' '+(ty-uy*6+ux*3)+' L '+tx+' '+ty+' L '+(tx-ux*6+uy*3)+' '+(ty-uy*6-ux*3);
        return <g key={i} data-edge={edge.from+':'+edge.to} data-tip={tx+','+ty} data-continuation={continuation||undefined} className={'fb-edge '+(edge.kind==='fail'?'fb-fail-edge':'')}>
          <path d={port.d} fill="none" strokeWidth={1.5} strokeDasharray={edge.kind==='fail'||edge.label==='shared index'?'5 4':undefined}/>
          <path d={arrow} fill="none" strokeWidth={1.5}/>
          {labelContinuation&&<g aria-label={byId.get(edge.to)?.title+' continues offscreen'}><circle cx={tx} cy={ty} r={3} fill="var(--fb-canvas)" stroke="var(--fb-line)"/><text x={Math.max(90,Math.min(size.w-110,tx))} y={ty<100?ty+15:ty-8} textAnchor="middle" fontSize={11}>{byId.get(edge.to)?.title} ↗</text></g>}
          {edge.label&&<text x={port.label.x} y={port.label.y} textAnchor="middle" fontSize={11}>{edge.label}</text>}
        </g>;
      })}
    </svg>
    {activeNodes.filter(n=>n.file).map(n=>{
      const b=screen.get(n.id),f=layout.frames.get(n.id),full=expanded?.id===n.id;
      const eligible=full||(!expanded&&Boolean(b&&f?.native&&intersects(b,safe)));
      return <NativeSlot key={n.id} node={n} eligible={eligible} full={full} pinned={Boolean(pins[n.id])} box={b} bounds={nativeBounds} scale={f?.nativeScale??1} actions={actions}/>;
    })}
    {markers.map(m=><button key={m.node.id} data-relation-node={m.node.id} className={'fb-relation-marker fb-status-'+m.node.status} style={{left:m.box.x,top:m.box.y,width:m.box.w,height:m.box.h}} onPointerDown={e=>e.stopPropagation()} onClick={()=>focus(m.node)}>
      <span className="fb-marker-role">{m.side==='left'?'← ':''}{essentialRole(m.node)}{m.side==='right'?' →':''}</span><strong>{m.node.title}</strong><span className="fb-marker-state">{essentialState(m.node)}</span>
    </button>)}
    </div><div className="fb-bottom-bar" data-board-controls>
      <div className="fb-navigation">
        {trail.length > 0 && <><button onClick={back} title="Return to previous view · Esc" aria-label="Return to previous view"><ArrowLeft size={15} /><span>Return</span></button><span className="fb-divider" /></>}
        <button aria-label="Zoom out" title="Zoom out · −" onClick={() => zoom(.8)}><Minus size={15} /></button>
        <span className="fb-zoom-label" aria-live="off">{Math.round(camera.z * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom in · +" onClick={() => zoom(1.25)}><Plus size={15} /></button>
        <span className="fb-divider" />
        <button aria-label="Fit graph" title="Fit graph · Home" onClick={() => fit()}><Focus size={16} /></button>
        <button aria-label="Board help" title="Board help · ?" onClick={() => setContext(prev => prev === 'help' ? null : 'help')}><CircleHelp size={15} /></button>
      </div>
    </div>
    <div className="fb-preview-tools"><button aria-label="Preview options" onClick={() => setContext(prev => prev === 'preview' ? null : 'preview')}>Preview <MoreHorizontal size={15} /></button></div>
    {notice && <div className="fb-notice" role="status">{notice}</div>}
    {context && <aside className="fb-popover" aria-label={detailNode ? `${detailNode.title} details` : context === 'help' ? 'Board help' : 'Preview options'}>
      <div className="fb-popover-heading"><span>{detailNode ? detailNode.role : context === 'help' ? 'Move through your work' : 'Synthetic preview'}</span><button aria-label="Close details" onClick={() => setContext(null)}><X size={17} /></button></div>
      {detailNode ? <>
        <h2>{detailNode.title}</h2><p>{detailNode.detail}</p>
        {detailNode.kind==='task'&&<div className="fb-task-members">{activeNodes.filter(n=>n.group===detailNode.group&&n.kind!=='task').map(n=><button className="fb-option" key={n.id} onClick={()=>focus(n)}>{n.title} · {essentialState(n)}</button>)}</div>}
        <div className="fb-relation-list">{[...new Set(activeEdges.filter(e => e.from === detailNode.id || e.to === detailNode.id).map(e => e.from === detailNode.id ? e.to : e.from))].map(id => {
          const other = byId.get(id)!;
          const links = activeEdges.filter(e => (e.from === detailNode.id && e.to === id) || (e.to === detailNode.id && e.from === id));
          const label = links.some(e => e.kind === 'fail') ? 'Review / return' : links[0].from === detailNode.id ? 'To' : 'From';
          return <button key={id} onClick={() => focus(other)}><span>{label}</span>{other.title}<ArrowUpRight size={13} /></button>;
        })}</div>
        <div className="fb-context-actions"><button onClick={() => pinNode(detailNode)}><Pin size={14} />{pins[detailNode.id] ? 'Release position' : 'Pin position'}</button>{detailNode.file && <button onClick={() => openConversation(detailNode)}>Open conversation <ArrowUpRight size={14} /></button>}</div>
      </> : context === 'help' ? <>
        <p>Click a conversation to read and reply in place. Its connections stay attached as you move closer.</p>
        <dl><dt>Move</dt><dd>Drag empty space · scroll</dd><dt>Zoom</dt><dd>Pinch · Ctrl + scroll · + / −</dd><dt>Return</dt><dd>Esc</dd><dt>Fit graph</dt><dd>Home</dd><dt>Pin</dt><dd>Drag a conversation header · P</dd><dt>Release</dt><dd>R</dd><dt>Move a node</dt><dd>Alt + arrow keys</dd></dl>
        <p className="fb-help-note">Native feeds scroll normally. Hold Space to pan across a conversation.</p>
      </> : <>
        <p>Invented tasks and conversations. All interactions stay in this page’s memory.</p>
        <button className="fb-option" onClick={() => { const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); document.documentElement.dataset.theme = next; document.documentElement.classList.toggle('dark', next === 'dark'); }}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />} {theme === 'light' ? 'Dark appearance' : 'Light appearance'}
        </button>
        <button className="fb-option" onClick={() => { appendMessage((readingNode ?? activeNodes.find(n => n.file))!.file!.path, 'assistant', 'The late-response case now passes. I am preparing the review handoff.'); setNotice('New message in Restore the connection'); }}>Add a message</button>
        <button className="fb-option" onClick={() => {
          if (extra.length) { setNotice('Sample worker is already on the board'); return; }
          const parent = activeNodes.find(n => n.id === (scenario === 'dense' ? 'dense-6-3' : 'integrate'))!;
          const sample = { ...parent, id: 'new-worker', title: scenario === 'dense' ? 'Check keyboard focus after navigation' : 'Check newly arrived search results', role: 'New worker', x: parent.x + (scenario === 'dense' ? -1150 : 1250), y: parent.y, detail: 'A newly arrived worker joins the same workstream. Existing anchors and camera remain in place.', file: { ...parent.file!, path: '/fixture/conversations/new-worker.jsonl', title: scenario === 'dense' ? 'Check keyboard focus after navigation' : 'Check newly arrived search results', conversationId: 'conversation_sample_new_worker' } };
          files.push(sample.file); setExtra([sample]); appendMessage(sample.file.path, 'assistant', 'I am checking links from search results to their original messages.'); window.dispatchEvent(new Event('llv:files-changed')); setNotice('A related worker joined the graph');
        }}>Add a related worker</button>
        {(['workspace', 'small', 'dense'] as const).filter(mode => mode !== scenario).map(mode => <button key={mode} className="fb-option" onClick={() => { setScenario(mode); selectFixtureScene(mode); setExtra([]); setSelected(null); setReader(null); setNotice('Sample changed · Fit graph to frame it'); }}>{mode === 'dense' ? 'Show 24 conversations' : mode === 'small' ? 'Show one pipeline' : 'Show original workspace'}</button>)}
      </>}
    </aside>}

  </div>;
}

// Geometry stops at this shell; one stable native subtree owns both surfaces.
const NativeContent = memo(function NativeContent({node,pinned,full,actions}:any){
  return <BranchPane file={node.file} tasks={EMPTY_TASKS} isRoot={node.id==='coordinator'} expanded={full}
    dragHandle={full?undefined:{onPointerDown:(e:any)=>actions.current.start(e,node)}}
    onToggleExpand={()=>full?actions.current.close():actions.current.openConversation(node)}
    headerActions={<><button aria-label={pinned?'Release automatic position':'Pin position'} onClick={()=>actions.current.pinNode(node)} className="fb-native-action"><Pin size={13} fill={pinned?'currentColor':'none'}/></button><button aria-label="Conversation relationships" onClick={()=>actions.current.details(node)} className="fb-native-action"><Info size={13}/></button></>}/>;
});
const EMPTY_TASKS:any[]=[];
const NativeSlot = memo(function NativeSlot({node,eligible,full,pinned,box,bounds,scale,actions}:any){
  const visited=useRef(false);if(eligible)visited.current=true;
  const geometry=useRef({box,bounds,scale});
  if(eligible)geometry.current={box,bounds,scale};
  else ({box,bounds,scale}=geometry.current);
  const content=useMemo(()=><NativeContent node={node} pinned={pinned} full={full} actions={actions}/>,[node,pinned,full,actions]);
  if(!visited.current||!bounds)return null;
  return createPortal(<div className="fb-native-clip" style={full?{inset:0,zIndex:40}:{left:bounds.x,top:bounds.y+64,width:bounds.width,height:bounds.height-138}}>
    <div className={full?'fb-expanded':'fb-native-pane'} data-native-pane={node.id} data-eligible={eligible} style={full?{position:'absolute',inset:0}:{left:box?.x??0,top:(box?.y??0)-64,width:W,height:H,transform:'scale('+scale+')',transformOrigin:'top left',display:eligible?'flex':'none'}}>
      <RetainedView id={node.id} eligible={eligible} full={full}><Activity mode={eligible?'visible':'hidden'}>{content}</Activity></RetainedView>
    </div>
  </div>,document.body);
}, (previous, next) => !previous.eligible && !next.eligible);

// Capture before React hides DOM; effect cleanup is already too late. The
// same message-key/offset technique is used by the native feed prepend guard.
class RetainedView extends Component<any> {
  saved:any=null;
  frame=0;
  stopRestore=()=>{};
  getSnapshotBeforeUpdate(previous:any){
    this.stopRestore();
    if(!previous.eligible || (this.props.eligible && previous.full===this.props.full))return null;
    const pane=document.querySelector<HTMLElement>('[data-native-pane="'+this.props.id+'"]');
    const feed=pane?.querySelector<HTMLElement>('[data-log-feed-scroller]');
    const input=pane?.querySelector<HTMLTextAreaElement>('textarea');
    if(!feed)return null;
    const r=feed.getBoundingClientRect(),scale=r.height/feed.offsetHeight;
    const row=[...feed.querySelectorAll<HTMLElement>('[data-feed-key]')].find(e=>e.getBoundingClientRect().bottom>r.top);
    this.saved={key:row?.dataset.feedKey,offset:row?(row.getBoundingClientRect().top-r.top)/scale:0,top:feed.scrollTop,
      tail:feed.scrollHeight-feed.clientHeight-feed.scrollTop<4,selection:input?[input.selectionStart,input.selectionEnd]:null};
    return null;
  }
  componentDidUpdate(previous:any){
    if(!this.props.eligible || (previous.eligible&&previous.full===this.props.full)||!this.saved)return;
    const pane=document.querySelector<HTMLElement>('[data-native-pane="'+this.props.id+'"]');
    const feed=pane?.querySelector<HTMLElement>('[data-log-feed-scroller]'),input=pane?.querySelector<HTMLTextAreaElement>('textarea');
    if(!feed)return;
    const restore=()=>{
      if(!this.props.eligible)return;
      const row=[...feed.querySelectorAll<HTMLElement>('[data-feed-key]')].find(e=>e.dataset.feedKey===this.saved.key);
      if(this.saved.tail)feed.scrollTop=feed.scrollHeight;
      else if(row){const r=feed.getBoundingClientRect(),scale=r.height/feed.offsetHeight;
        const delta=(row.getBoundingClientRect().top-r.top)/scale-this.saved.offset;
        if(Math.abs(delta)>.5)feed.scrollTop+=delta;
      } else feed.scrollTop=this.saved.top;
      if(input&&this.saved.selection)input.setSelectionRange(...this.saved.selection as [number,number]);
    };
    const schedule=()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(restore);};
    const mutations=new MutationObserver(schedule),resize=new ResizeObserver(schedule);
    mutations.observe(feed,{childList:true,subtree:true});resize.observe(feed);feed.addEventListener('scroll',schedule);
    const stop=()=>{cancelAnimationFrame(this.frame);mutations.disconnect();resize.disconnect();feed.removeEventListener('scroll',schedule);clearTimeout(timer);for(const event of ['wheel','pointerdown','keydown'])pane?.removeEventListener(event,stop);};
    const timer=setTimeout(stop,750);
    this.stopRestore=stop;
    for(const event of ['wheel','pointerdown','keydown'])pane?.addEventListener(event,stop,{once:true});
    schedule();
  }
  componentWillUnmount(){this.stopRestore();}
  render(){return this.props.children;}
}
