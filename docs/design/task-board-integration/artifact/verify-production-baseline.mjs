import assert from 'node:assert/strict';
const {browser,pageFor}=await import('./revision3-browser.mjs');
try {
 const p=await pageFor('multi-24');await p.waitForFunction(()=>window.__productionBoard);
 await p.evaluate(()=>window.__productionBoard.camera({x:-100000,y:-100000,z:1}));await p.waitForTimeout(1200);
 const read=()=>p.evaluate(()=>structuredClone(window.__nativeCounters??{}));const before=await read();
 for(let i=0;i<20;i++){await p.evaluate(i=>window.__productionBoard.camera({x:-100000-i*20,y:-100000,z:1}),i);await p.waitForTimeout(25);}
 await p.waitForTimeout(21000);const after=await read();let changed=0;for(const key of Object.keys(after))for(const bucket of Object.keys(after[key]))changed+=(after[key][bucket]??0)-(before[key]?.[bucket]??0);
 console.log(JSON.stringify({conversations:24,hiddenNativeUpdates:changed,errors:p.errors}));assert(changed>0);assert.deepEqual(p.errors,[]);
}finally{await browser.close();}
