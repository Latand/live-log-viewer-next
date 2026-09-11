import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
const {values}=parseArgs({options:{out:{type:'string'},assets:{type:'string'},chromium:{type:'string'},baseline:{type:'boolean',default:false}}});
if(!values.out||!values.assets)throw new Error('--out and --assets required');
const out=path.resolve(values.out),assets=path.resolve(values.assets);fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:values.chromium??chromium.executablePath(),args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({viewport:{width:1000,height:900}});
 await context.route('**/*',r=>{
  const name=new URL(r.request().url()).pathname;
  if(name==='/composer.js')return r.fulfill({contentType:'application/javascript',path:path.join(assets,'composer.js')});
  if(name==='/composer.css')return r.fulfill({contentType:'text/css',path:path.join(assets,'composer.css')});
  if(name==='/')return r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/composer.css"></head><body><div id="app" style="position:relative;width:650px;height:800px;margin:24px"></div><script src="/composer.js"></script></body></html>'});
  return r.abort();
 });
 const page=await context.newPage();await page.goto('https://legacy-case.invalid');await page.locator('textarea').waitFor();
 await page.evaluate(()=>{
  const old=Array.from({length:4},(_,i)=>({key:'old-report-'+i,text:'Original worker report '+i,images:[],payloadComplete:false}));
  sessionStorage.setItem('llvPendingSend:conversation_payload_fixture',JSON.stringify(old));
  sessionStorage.setItem('llvRecoveryReceipts:conversation_payload_fixture',JSON.stringify(old.map((p,i)=>({conversationId:'conversation_payload_fixture',idempotencyKey:p.key,operationId:'report-op-'+i,kind:'send',status:'uncertain',resend:'verify-first',reason:'Original report outcome is unknown',at:new Date().toISOString(),revision:1}))));
  window.payloadFixture.seedLegacyOutbox(old);window.payloadFixture.remount();
 });
 await page.waitForTimeout(150);await page.locator('textarea').fill('New separately authored message');await page.locator('textarea').press('Enter');
 if(!values.baseline)await page.waitForFunction(()=>window.payloadFixture.requests.length===1);
 await page.waitForTimeout(250);
 const result=await page.evaluate(async()=>({requests:window.payloadFixture.requests.map(r=>({key:r.idempotencyKey,text:r.text})),draft:document.querySelector('textarea').value,old:window.payloadFixture.state().pending.filter(p=>p.key.startsWith('old-report-')).map(p=>({key:p.key,text:p.text,incomplete:p.payloadComplete===false})),saved:(await window.payloadFixture.saved()).map(r=>({key:r.ref.key,text:r.submission.text}))}));
 await page.screenshot({path:path.join(out,'legacy-new-draft.png')});fs.writeFileSync(path.join(out,'legacy-new-draft.json'),JSON.stringify(result,null,2));
 if(values.baseline){if(result.requests.length!==0||result.draft!=='New separately authored message')throw new Error('Baseline did not reproduce blocked new draft');}
 else if(result.requests.length!==1||result.requests[0].key.startsWith('old-report-')||result.requests[0].text!=='New separately authored message'||result.old.length!==4||result.saved.length!==1)throw new Error('Legacy identity was replayed or new intent blocked/lost');
 console.log(JSON.stringify(result));
}finally{await browser.close();}
