import assert from 'node:assert/strict';
const {browser,pageFor}=await import('./revision3-browser.mjs');
try {
 const p=await pageFor('multi-24');await p.waitForFunction(()=>window.__productionBoard);
 await p.evaluate(()=>window.__productionBoard.zoom(.07));await p.waitForTimeout(200);
 const id=await p.evaluate(()=>window.__productionBoard.snapshot().tasks[0].id);
 await p.evaluate(id=>{const {tasks,cam,vp}=window.__productionBoard.snapshot(),t=tasks.find(t=>t.id===id);window.__productionBoard.camera({x:vp.w/2-t.pos.x*cam.z-130,y:vp.h/2-t.pos.y*cam.z-80,z:cam.z});
 const fetch=window.fetch;window.fetch=async(input,init)=>String(input).includes('/api/tasks/')&&init?.method==='PATCH'?new Response(JSON.stringify({error:'Fixture persistence refused'}),{status:409}):fetch(input,init);
 },id);await p.waitForTimeout(200);
 const card=p.locator('[data-scheme-task='+JSON.stringify(id)+']');const before=await card.boundingBox();
 await p.mouse.move(before.x+12,before.y+12);await p.mouse.down();await p.mouse.move(before.x+82,before.y+47,{steps:5});await p.mouse.up();await p.waitForTimeout(600);
 const after=await card.boundingBox();assert(Math.abs(before.x-after.x)<1);assert(Math.abs(before.y-after.y)<1);
 assert.equal(await p.getByText('Fixture persistence refused',{exact:true}).count(),1);
 assert.deepEqual(p.errors,[]);console.log(JSON.stringify({failedPinRestoresDisplayedPosition:true,errorVisible:true}));
}finally{await browser.close();}
