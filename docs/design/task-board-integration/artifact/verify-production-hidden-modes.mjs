import assert from 'node:assert/strict';
const {browser,pageFor}=await import('./revision3-browser.mjs');
try {
 const p=await pageFor('multi-24');await p.waitForFunction(()=>window.__productionBoard);
 const paths=await p.evaluate(()=>window.__productionBoard.snapshot().nodes.slice(0,3).map(n=>n.path));
 for(const path of paths){await p.evaluate(path=>window.__productionBoard.expand(path),path);await p.waitForTimeout(700);}
 const hidden=paths.slice(0,2);const read=()=>p.evaluate(paths=>Object.fromEntries(paths.map(path=>[path,{native:window.__nativeCounters?.[path],shell:window.__shellCounters?.[path],chrome:window.__chromeCounters?.[path],owner:window.__ownerCounters?.[path],parse:window.__sourceParses?.[path],log:window.__logCallbacks?.[path],timer:window.__viewTimers?.[path]}])),hidden);
 for(const mode of ['full-window-siblings','aggregate']){
  if(mode==='aggregate'){await p.evaluate(()=>{window.__productionBoard.collapse();window.__productionBoard.zoom(.07);});await p.waitForTimeout(700);}
  const before=await read();
  await p.evaluate(paths=>{for(let i=0;i<100;i++)window.__fixtureSource.append(paths[i%paths.length],'assistant','Hidden mode update '+i);},hidden);
  await p.waitForTimeout(21000);assert.deepEqual(await read(),before,mode);console.log(JSON.stringify({mode,hiddenReaders:hidden.length,hiddenUiChanges:0}));
 }
 assert.deepEqual(p.errors,[]);
}finally{await browser.close();}
