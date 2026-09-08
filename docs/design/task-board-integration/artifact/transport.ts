import { PROJECT, files, taskFixtures, appendMessage, selectFixtureScene, transcript } from './fixtures';
import { whenVisible } from './memory-log';
import { applyBoardMutations } from '@/lib/board/mutations';
export const calls: { path: string; method: string; result: string }[] = [];
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(i: number) { return [...this.values.keys()][i] ?? null; }
  getItem(k: string) { return this.values.get(k) ?? null; }
  setItem(k: string, v: string) { this.values.set(k, String(v)); }
  removeItem(k: string) { this.values.delete(k); }
  clear() { this.values.clear(); }
}
export function installMemoryTransport() {
  selectFixtureScene(new URLSearchParams(location.search).get('scene') ?? 'workspace');
  const production=new URLSearchParams(location.search).has('production');
  const storage = production ? window.localStorage : new MemoryStorage();
  const savedTasks=production ? JSON.parse(storage.getItem('fixture-task-positions')??'{}') : {};
  for(const task of taskFixtures)if(savedTasks[task.id])Object.assign(task,savedTasks[task.id]);
  const runtimeMode=new URLSearchParams(location.search).get('runtime')==='1';
  if(runtimeMode)storage.setItem('llv_runtime_ui','1');
  const runtimeSources=new Set<any>();let runtimeSeq=0;
  if(runtimeMode)setInterval(()=>{for(const source of runtimeSources)source.dispatchEvent(new Event("heartbeat"));},5000);
  const runtimeSessions=files.map(file=>({conversationId:file.conversationId,sessionKey:{engine:'codex',sessionId:file.conversationId},hostKind:'codex-app-server',host:'hosted',turn:'idle',provenance:'structured',revision:1,attentionIds:[],recentReceipts:[] as any[],accountId:null,parentConversationId:null,flowId:null,workflowId:null,cwd:'/fixture/workspace',artifactPath:file.path,capabilities:{steer:true,structuredAttention:true},activeTurnId:null}));
  const runtimeOperations=new Map<string,any>();
  const runtimeEvent=(kind:string,payload:any,occurredAt:string)=>{
    const session=runtimeSessions.find(s=>s.conversationId===payload.conversationId);
    if(!session)throw Error('Unknown fixture conversation');
    const envelope={schemaVersion:1,seq:++runtimeSeq,eventId:'fixture-'+runtimeSeq,scope:{type:'session',id:session.conversationId},revision:++session.revision,kind,payload,occurredAt,recordedAt:occurredAt};
    for(const source of runtimeSources)source.onmessage?.({data:JSON.stringify(envelope)});
  };
  const runtimeReceipt=(key:string,status:string)=>{const operation=runtimeOperations.get(key);if(!operation)throw Error('Unknown operation');const receipt={operationId:'operation_'+key,idempotencyKey:key,conversationId:operation.conversationId,kind:'send',status,text:operation.text,at:new Date().toISOString(),revision:++operation.revision,resend:'verify-first'};operation.receipt=receipt;const session=runtimeSessions.find(s=>s.conversationId===operation.conversationId)!;session.recentReceipts=[receipt];const envelope={schemaVersion:1,seq:++runtimeSeq,eventId:'fixture-'+runtimeSeq,scope:{type:'operation',id:receipt.operationId},revision:receipt.revision,kind:'receipt',payload:receipt};for(const source of runtimeSources)source.onmessage?.({data:JSON.stringify(envelope)});return receipt;};
  storage.setItem('llvProject', PROJECT); storage.setItem('llv_lang', 'en');
  if(!production){Object.defineProperty(window, 'localStorage', { value: storage });
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage() });}
  (window as any).process = { env: { NODE_ENV: 'production', NEXT_PUBLIC_RUNTIME_UI: '0' } };
  const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const sent = new Set<string>();
  const operations=new Map<string,any>();
  let manualDelivery=false;
  function settleOperation(key:string,state:string){
    const operation=operations.get(key);if(!operation)throw Error('Unknown sample operation');
    if(operation.state==='terminal')return;
    operation.state=state;
    if(state==='terminal'){
      if(!sent.has(key)){sent.add(key);appendMessage(operation.path,'user',operation.text);appendMessage(operation.path,'assistant','Sample reply: your message is here in the preview. No agent was contacted.');}
      operation.resolve();
    }
  }
  const prefs = { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], seenAt: {}, idleCollapseMinutes: 1440, viewMode: 'scheme', taskPanelOpen: false };
  let board: any = { schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(), pathAliases: {}, explicitManual: [], keyRevisions: {}, keyRevisionFloor: 0, prefs };
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const entry = { path: url.pathname, method, result: 'blocked' }; calls.push(entry);
    if (calls.length > 1000) calls.shift();
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return response({ error: 'Outside the sample transport' }, 403);
    entry.result = 'memory';
    if (url.pathname === '/api/logs' && method === 'POST') {
      const body=JSON.parse(String(init?.body??'{}'));
      return response({chunks:Object.fromEntries((body.reqs??[]).map((r:any)=>{
        const bytes=new TextEncoder().encode((transcript.get(r.path)??[]).join('\n')+'\n');
        const start=Math.max(0,r.offset??0);
        return [r.id,{start,offset:bytes.length,size:bytes.length,data:new TextDecoder().decode(bytes.slice(start))}];
      }))});
    }
    if(runtimeMode && url.pathname==='/api/runtime/snapshot')return response({schemaVersion:1,snapshotSeq:runtimeSeq,retentionFloorSeq:0,runtime:{hostEpoch:1,health:'ready'},structuredHostsEnabled:true,filesRevision:1,sessions:runtimeSessions,attentions:[],recentOperations:[...runtimeOperations.values()].flatMap(op=>op.receipt?[op.receipt]:[]),edges:[],flows:[],workflows:[],tasks:[]});
    if(runtimeMode && url.pathname==='/api/runtime/send'){
      const body=JSON.parse(String(init?.body));const key=body.idempotencyKey;
      const operation=runtimeOperations.get(key)??{...body,revision:0,attempts:0};operation.attempts++;runtimeOperations.set(key,operation);
      const receipt=runtimeReceipt(key,'queued');return response({ok:true,operationId:receipt.operationId,receipt});
    }
    if(url.pathname.startsWith('/api/tasks/') && method==='PATCH'){
      const id=url.pathname.split('/').at(-1),index=taskFixtures.findIndex(t=>t.id===id);
      if(index<0)return response({error:'Unknown fixture task'},404);
      const patch=JSON.parse(String(init?.body));taskFixtures[index]={...taskFixtures[index],...patch,...(patch.pos?{placement:'pinned'}:{}),updatedAt:new Date().toISOString()};
      storage.setItem('fixture-task-positions',JSON.stringify(Object.fromEntries(taskFixtures.filter(t=>t.placement==='pinned').map(t=>[t.id,{pos:t.pos,placement:t.placement}]))));
      return response({task:taskFixtures[index]});
    }
    if (url.pathname === '/api/files') return response({ files, tasks: taskFixtures, flows: [], pipelines: [], workflows: [], projectCatalog: [], projectAliases: {}, projectDisplayNames: { [PROJECT]: 'Workspace' }, projectCwds: { [PROJECT]: '/fixture/workspace' }, crownedProjects: [], conversationAliases: {}, launchRoutes: {}, systemHealth: { tmux: { status: 'healthy' } } });
    if (url.pathname === '/api/board') {
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.mutations) board = applyBoardMutations(board, body.mutations);
        if (body.patch) board = { ...board, prefs: { ...board.prefs, ...body.patch } };
        board = { ...board, revision: board.revision + 1 };
      }
      return response({ board, applied: true });
    }
    if (url.pathname === '/api/attention') return response({ live: [], history: [] });
    if (url.pathname === '/api/tts/backend') return response({ backend: null, options: [] });
    if (url.pathname === '/api/accounts') return response({ active: null, accounts: [], claude: { accounts: [], active: null } });
    if (url.pathname === '/api/limits') return response({ claude: null, codex: null, claudeAccountId: null, codexAccountId: null, provenance: { claude: { source: 'unavailable', reason: null, staleSince: null }, codex: { source: 'unavailable', reason: null, staleSince: null } } });
    if (url.pathname.includes('orchestrator')) return response({ seat: null, pending: null, exists: false, incumbent: null });
    if (url.pathname === '/api/tmux/targets' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return response({ targets: Object.fromEntries((body.reqs ?? []).map((r: any) => [r.id, files.some(f => f.path === r.path) ? 'synthetic-memory-host' : null])) });
    }
    if (url.pathname === '/api/tmux' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.text && files.some(f => f.path === body.path)) {
        const key = String(body.clientMessageId ?? body.idempotencyKey);
        let operation=operations.get(key);
        if(!operation){
          let resolve!:()=>void;const completion=new Promise<void>(r=>resolve=r);
          operation={key,path:body.path,text:body.text,state:'pending',attempts:1,resolve,completion};
          operations.set(key,operation);
          if(!manualDelivery)settleOperation(key,'terminal');
        }
        await operation.completion;
        return response({ ok: true, outcome: 'delivered-to-live' });
      }
    }
    // Native peripheral controls may open, but no lifecycle action is implemented.
    if (method !== 'GET') { entry.result = 'unavailable'; return response({ error: 'This action is unavailable in the synthetic board preview.' }, 409); }
    if (url.pathname.includes('archived')) return response({ projects: [], archived: [] });
    if (url.pathname === '/api/settings') return response({});
    if (url.pathname === '/api/agent') return response({ schemaVersion: 1, capabilities: [] });
    return response({ ok: true, items: [], sessions: [], agents: [], accounts: [], deployments: [], limits: null, enabled: false, connected: false, status: 'idle' });
  }) as typeof fetch;
  class InertEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    subscriptions: {id:string;path:string;offset:number}[]=[];
    publish = (event?: Event) => { if(this.readyState===2)return; const changed=(event as CustomEvent<string>|undefined)?.detail;for(const sub of this.subscriptions){if(changed && changed!==sub.path)continue;const bytes=new TextEncoder().encode((transcript.get(sub.path)??[]).join("\n")+"\n");const start=Math.max(0,sub.offset);sub.offset=bytes.length;this.dispatchEvent(new MessageEvent("chunk",{data:JSON.stringify({id:sub.id,chunk:{start,offset:bytes.length,size:bytes.length,data:new TextDecoder().decode(bytes.slice(start))}})}));}};
    readyState = 1; onopen: any; onmessage: any; onerror: any; url: string;
    constructor(url: string) { super(); this.url = String(url); if(this.url.startsWith('/api/runtime/stream'))runtimeSources.add(this); queueMicrotask(() => { const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); if(this.url.startsWith('/api/logs/stream')){this.subscriptions=JSON.parse(new URL(this.url,location.href).searchParams.get('subs')??'[]');window.addEventListener('sample-transcript',this.publish);this.publish();} }); }
    close() { this.readyState = 2; runtimeSources.delete(this);window.removeEventListener('sample-transcript',this.publish); }
  }
  Object.defineProperty(window, 'EventSource', { value: runtimeMode ? InertEventSource : new URLSearchParams(location.search).has('production') ? undefined : InertEventSource });
  Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('Sockets disabled in preview'); } } });
  Object.defineProperty(window, 'XMLHttpRequest', { value: class { open() { throw new Error('XHR disabled in preview'); } } });
  Object.defineProperty(navigator, 'sendBeacon', { value: () => false });
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => { throw new Error('Service workers disabled in preview'); } });
  (window as any).__sampleTransport = { calls, storage, runtimeReceipt, runtimeEvent, runtimeOperations:()=>[...runtimeOperations.entries()], tasks:()=>taskFixtures,
    manualDelivery:(value:boolean)=>{manualDelivery=value;},settle:settleOperation,
    operations:()=>[...operations.values()].map(({resolve,completion,...row})=>row)
  };
}
