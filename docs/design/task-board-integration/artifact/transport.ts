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
  const storage = new MemoryStorage();
  storage.setItem('llvProject', PROJECT); storage.setItem('llv_lang', 'en');
  Object.defineProperty(window, 'localStorage', { value: storage });
  Object.defineProperty(window, 'sessionStorage', { value: new MemoryStorage() });
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
    readyState = 1; onopen: any; onmessage: any; onerror: any; url: string;
    constructor(url: string) { super(); this.url = String(url); queueMicrotask(() => { const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); }); }
    close() { this.readyState = 2; }
  }
  Object.defineProperty(window, 'EventSource', { value: new URLSearchParams(location.search).has('production') ? undefined : InertEventSource });
  Object.defineProperty(window, 'WebSocket', { value: class { constructor() { throw new Error('Sockets disabled in preview'); } } });
  Object.defineProperty(window, 'XMLHttpRequest', { value: class { open() { throw new Error('XHR disabled in preview'); } } });
  Object.defineProperty(navigator, 'sendBeacon', { value: () => false });
  if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => { throw new Error('Service workers disabled in preview'); } });
  (window as any).__sampleTransport = { calls, storage,
    manualDelivery:(value:boolean)=>{manualDelivery=value;},settle:settleOperation,
    operations:()=>[...operations.values()].map(({resolve,completion,...row})=>row)
  };
}
