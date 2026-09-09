
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const here=path.dirname(new URL(import.meta.url).pathname);
const require=createRequire(path.resolve('../live-log-viewer-next/node_modules/_preview.cjs'));
const {chromium}=require('playwright-core');
export const out=process.env.BOARD_REPORT_OUT ?? path.join(here,'out/revision3');
fs.mkdirSync(out,{recursive:true});
export const browser=await chromium.launch({headless:true,executablePath:process.env.BOARD_CHROME,args:['--no-sandbox']});
export async function pageFor(scene='workspace',width=1440,height=900,theme='light'){
  const page=await browser.newPage({viewport:{width,height},colorScheme:theme});
  await page.addInitScript(()=>{
    const positions={};window.__feedInputs={};window.__sourceParses={};let currentPath=null;
    window.__countSourceParse=line=>{if(!currentPath)return;const c=window.__sourceParses[currentPath]??={lines:0,bytes:0};c.lines++;c.bytes+=new TextEncoder().encode(line).length;};
    window.__withFeedInput=(path,lines,run)=>{window.__recordFeedInput(path,lines);const previous=currentPath;currentPath=path;try{return run();}finally{currentPath=previous;}};

    window.__recordFeedInput=(path,lines)=>{
      const c=window.__feedInputs[path]??={calls:0,newLines:0,newBytes:0};
      c.calls++; const start=positions[path]??0;
      for(const line of lines.slice(start)){c.newLines++;c.newBytes+=line.length;}
      positions[path]=lines.length;
    };
    window.__longTasks=[];
    new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
  });
  page.setDefaultTimeout(30000);
  page.errors=[];page.on('pageerror',e=>{page.errors.push(e.message);console.error(e.message);});
  await page.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!=='http://artifact.invalid')throw Error('Unexpected network '+u.origin);
    const f=u.pathname==='/'?'index.html':u.pathname==='/assets/viewer.js'?(process.env.BOARD_PLAIN==='1'?'out/revision3/preview/assets/viewer.js':'out/revision3/viewer.js'):u.pathname.slice(1);
    const p=u.pathname==='/assets/viewer.css'&&process.env.BOARD_PRODUCTION==='1' ? path.join(here,'assets/production.css') : u.pathname==='/assets/viewer.js'&&process.env.BOARD_BUNDLE ? process.env.BOARD_BUNDLE : path.join(here,f);
    assert(p===process.env.BOARD_BUNDLE||p.startsWith(here+'/'));
    await route.fulfill({status:200,contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.woff2')?'font/woff2':'text/html',body:fs.readFileSync(p)});
  });
  await page.goto('http://artifact.invalid/?scene='+scene+'&theme='+theme+(process.env.BOARD_PRODUCTION==='1'?'&production=1':'')+(process.env.BOARD_RUNTIME==='1'?'&runtime=1':''),{waitUntil:'networkidle'});
  if(process.env.BOARD_PRODUCTION==='1') await page.waitForSelector('[aria-label^="Agent board"]');
  else await page.waitForFunction(()=>window.__boardPreview?.snapshot().size.w>0);
  return page;
}
export const snapshot=page=>page.evaluate(()=>window.__boardPreview.snapshot());
export const zoom=(page,z)=>page.evaluate(z=>window.__boardPreview.zoom(z),z);
export const focus=(page,id)=>page.evaluate(id=>window.__boardPreview.focus(id),id);
if(process.argv.includes('--probe')){
  try{
    const p=await pageFor();await focus(p,'index');await p.waitForTimeout(400);await zoom(p,.58);await p.waitForTimeout(200);
    await p.screenshot({path:path.join(out,'probe-58.png')});
    console.log(JSON.stringify({errors:p.errors,state:await snapshot(p),counters:await p.evaluate(()=>window.__nativeCounters)}));
    await p.evaluate(()=>window.__boardPreview.camera({...window.__boardPreview.snapshot().camera,x:-10000}));
    await p.waitForTimeout(400);
    const before=await p.evaluate(()=>({native:window.__nativeCounters,view:window.__viewCounters}));
    for(let i=0;i<20;i++) {await p.evaluate(i=>window.__boardPreview.camera({...window.__boardPreview.snapshot().camera,x:-10000+i}),i);await p.waitForTimeout(20);}
    await p.waitForTimeout(11000);
    const after=await p.evaluate(()=>({native:window.__nativeCounters,view:window.__viewCounters}));
    console.log(JSON.stringify({before,after}));
  } finally{await browser.close();}
}
