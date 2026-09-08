import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extract} from './extract.mjs';
const window={label:'sample',conversationId:'conversation_sample',since:'2026-01-01T00:00:00Z',until:'2026-01-01T00:02:00Z'};
test('opaque cursor, new request keys, chronological dedup, truncation and explicit coverage',async()=>{
  const requests=[];
  const result=await extract(async(name,args)=>{
    requests.push({name,args});
    return {ok:true,records:[{seq:2,kind:'tool_result',ts:'2026-01-01T00:01:00Z',text:'returned evidence'},
      {seq:requests.length===1?3:1,kind:'message',ts:requests.length===1?'2026-01-01T00:03:00Z':'2026-01-01T00:00:01Z',text:'outside or older'}],
      hasMore:requests.length===1,cursor:'opaque+/=='};
  },{runId:'sample',windows:[window],maxChars:8});
  assert.equal(requests[1].args.cursor,'opaque+/==');
  assert.notEqual(requests[0].args.clientRequestId,requests[1].args.clientRequestId);
  assert.deepEqual(result.windows[0].records.map(r=>r.seq),[1,2]);
  assert.equal(result.windows[0].exhausted,true);
  assert.ok(result.windows[0].records.every(r=>r.truncated));
  assert.equal(result.publicationReady,false);
});
test('page cap cannot silently report complete; tool refusal cannot become empty history',async()=>{
  const r=await extract(async()=>({ok:true,records:[],hasMore:true,cursor:'next'}),{runId:'cap',windows:[window],maxPages:1});
  assert.equal(r.windows[0].exhausted,false);assert.ok(r.warnings.length);
  await assert.rejects(()=>extract(async()=>({ok:false,code:'unavailable'}),{runId:'refusal',windows:[window]}),/Viewer refused/);
});
test('redacts private fields and does not permit mutation readbacks',async()=>{
  const r=await extract(async()=>({ok:true,records:[{seq:1,kind:'message',ts:window.since,text:'Bearer sample-secret identity-sample',accountId:'sample-account'}],hasMore:false}),
    {runId:'redact',windows:[window],redactLiterals:['identity-sample']});
  const s=JSON.stringify(r);assert.ok(!s.includes('sample-secret'));assert.ok(!s.includes('identity-sample'));assert.ok(!s.includes('sample-account'));
  await assert.rejects(()=>extract(async()=>{}, {runId:'reject',windows:[],readbacks:[{tool:'spawn_agent',args:{}}]}),/Invalid readback/);
});
