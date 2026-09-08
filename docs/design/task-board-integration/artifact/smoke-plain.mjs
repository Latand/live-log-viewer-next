
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {browser,pageFor,focus,out} from './revision3-browser.mjs';
try{
 const p=await pageFor();await focus(p,'index');await p.waitForTimeout(250);
 assert.equal(await p.locator('[data-eligible="true"]').count(),1);
 await p.locator('[data-eligible="true"] textarea').first().fill('Plain artifact draft');
 await p.screenshot({path:path.join(out,'plain-native.png')});
 assert.deepEqual(p.errors,[]);
 fs.writeFileSync(path.join(out,'plain-smoke.json'),JSON.stringify({instrumentation:false,eligible:1,draft:true,errors:p.errors}));
}finally{await browser.close();}
