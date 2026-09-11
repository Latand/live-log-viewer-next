/** Real pane/composer/tray/outbox against a synthetic runtime. No provider calls.
 * `?runtime=journal` keeps the production send/retry client and reads receipts
 * from the verifier, which serves both routes from the real handlers/journal. */
import { createRoot } from 'react-dom/client';
import { createElement, useSyncExternalStore } from 'react';
import { NativeConversationPane } from '@/components/scheme/NativeConversationPane';
import { installSnapshot, type RuntimeReceipt } from '@/components/runtime/runtimeModel';
import { setRuntimeBusForTests } from '@/hooks/runtimeBus';
import { setTmuxComposerRuntimeDependenciesForTests } from '@/components/tmuxComposerRuntime';
import { setLogFeedDependenciesForTests } from '@/components/logFeedDependencies';
import { composerSubmissionPayloads } from '@/lib/composerSubmissionPayloads';
import { readPendingDeliveries } from '@/components/TmuxComposer';
import { readOutbox, enqueueOutbox, updateOutbox } from '@/components/conversation/outbox';
import { viewBus } from '@/hooks/viewPresenceBus';
import { setLocale } from '@/lib/i18n';
import type { FileEntry } from '@/lib/types';
import type { RuntimeSnapshot } from '@/lib/runtime/contracts';

const params = new URLSearchParams(location.search);
const journal = params.get('runtime') === 'journal';
const CARD = params.get('card') ?? 'conversation_payload_fixture';
const PATH = params.get('path') ?? '/fixture/payload.jsonl';
const listeners = new Set<() => void>();
let receipts: RuntimeReceipt[] = [];
const requests: Record<string, unknown>[] = [];
// `?queue=<thread>` hosts the card on a native-queue Codex thread with a running turn.
const queueThread = params.get('queue');
const session = {
  conversationId: CARD, sessionKey: { engine:'codex',sessionId:queueThread ?? 'fixture-thread' },
  hostKind:'codex-app-server',host:'hosted',turn:queueThread ? 'running' : 'idle',provenance:'structured',
  accountId:'fixture-account',parentConversationId:null,cwd:null,artifactPath:PATH,
  capabilities:{steer:true,structuredAttention:true,nativeQueue:Boolean(queueThread),imageInput:{supported:true,mimes:['image/png']}},
  activeTurnId:null,nativeQueueRevision:0,attentionIds:[],recentReceipts:[],revision:1,
};
const state = {
  store:installSnapshot({schemaVersion:1,snapshotSeq:1,retentionFloorSeq:0,runtime:{hostEpoch:1,health:'healthy'},filesRevision:0,sessions:[session],attentions:[],recentOperations:[],edges:[],flows:[],workflows:[],tasks:[]} as unknown as RuntimeSnapshot),
  connection:'live',resyncedAt:null,lastEventAt:null,enabled:true,structuredHostsEnabled:true,
};
setRuntimeBusForTests({getState:()=>state,subscribe:()=>()=>{},subscribeFilesRevision:()=>()=>{},start(){},stop(){},refresh:async()=>true} as never);
let refreshes = 0;
let mode = params.get('mode') ?? 'safe';
const nativeFetch = window.fetch.bind(window);
// Synthetic journal revisions only rise, across reloads too, like presentation revisions.
const revisionFloor = () => Number(localStorage.getItem('fixture-max-revision') ?? '0');
const bumpRevision = (revision: number) => localStorage.setItem('fixture-max-revision', String(Math.max(revision, revisionFloor())));
const publishReceipts = (next: RuntimeReceipt[]) => {
  receipts = next;
  if (!journal) bumpRevision(Math.max(0, ...next.map(receipt => receipt.revision)));
  for (const listener of listeners) listener();
};
const pollReceipts = async () => {
  const response = await nativeFetch('/fixture/receipts');
  const next = await response.json() as RuntimeReceipt[];
  if (JSON.stringify(next) !== JSON.stringify(receipts)) publishReceipts(next);
};
if (journal) setInterval(() => { void pollReceipts().catch(() => {}); }, 100);
setTmuxComposerRuntimeDependenciesForTests({
  refreshRuntime: async () => { refreshes++; if (journal) await pollReceipts(); return true; },
  useRuntimeReceiptsForArtifact: () => useSyncExternalStore(listener => {listeners.add(listener);return()=>{listeners.delete(listener);};},()=>receipts,()=>receipts),
  ...(journal ? {} : { sendRuntimeMessage: async (body: Parameters<typeof import('@/hooks/useRuntime').sendRuntimeMessage>[0]) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    if(mode === 'unknown') return {ok:false,error:'Synthetic lost response',status:503};
    const revision = Number(localStorage.getItem('fixture-server-revision') ?? '0') + 1;
    localStorage.setItem('fixture-server-revision', String(revision));
    bumpRevision(revision);
    const receipt = {conversationId:CARD,idempotencyKey:body.idempotencyKey,operationId:'fixture-operation',kind:'send',status:mode === 'delivered'?'delivered':'failed',resend:mode === 'delivered'?'unsafe':'safe',text:body.text,reason:'Synthetic pre-dispatch refusal',at:new Date().toISOString(),revision} as RuntimeReceipt;
    return {ok:mode === 'delivered',status:mode === 'delivered'?200:409,receipt,error:mode === 'delivered'?undefined:receipt.reason ?? undefined};
  } }),
});
setLogFeedDependenciesForTests({useLogTail:()=>({lines:[],linesStart:0,size:0,loading:false,error:null,tickTime:null,paused:false,setPaused(){},clear(){},hasMore:false,loadingOlder:false,loadOlder:async()=>0,prependGen:0})} as never);
// Synthetic mode answers the operation retry contract the way the journal does:
// a leaf that names the attempt it replaces, under a key the server derives.
const retries: string[] = [];
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const pathname = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  if (journal && (pathname.startsWith('/api/runtime/') || pathname.startsWith('/fixture/'))) return nativeFetch(input, init);
  const operation = /^\/api\/runtime\/operations\/([^/]+)$/.exec(pathname);
  if (operation && init?.method === 'POST') {
    const parent = decodeURIComponent(operation[1]!);
    retries.push(parent);
    const revision = revisionFloor() + 1;
    bumpRevision(revision);
    const receipt = {conversationId:CARD,idempotencyKey:'retry_'+parent,operationId:parent,retryOfOperationId:parent,kind:'send',status:'queued',at:new Date().toISOString(),revision};
    return new Response(JSON.stringify({operationId:'fixture-leaf-'+retries.length,receipt}),{status:202,headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify(pathname.includes('/targets')?{targets:{}}:{voices:[],accounts:[],models:[],engines:[],options:[]}),{status:200,headers:{'content-type':'application/json'}});
}) as typeof fetch;
setLocale('en');
const file = {path:PATH,root:'codex-sessions',name:'payload.jsonl',project:'viewer',title:'Attachment recovery',engine:'codex',kind:'session',fmt:'codex',parent:null,mtime:1,size:1,activity:'idle',proc:'running',pid:null,conversationId:CARD,pendingQuestion:null,waitingInput:null,model:'gpt-6-astra',effort:'high'} as FileEntry;
const host = document.getElementById('app')!;
const root = createRoot(host);
let mount = 0;
const render = (other = false) => root.render(createElement(NativeConversationPane,{key:++mount,file:other?{...file,path:'/fixture/other.jsonl',conversationId:'conversation_other'}:file,tasks:[],isRoot:false,active:true,place:host,fullWindowPlace:null}));
render();
Object.assign(window,{payloadFixture:{
  requests, retries, cardId:CARD,
  seedLegacyOutbox:(pending:{key:string;text:string}[])=>{
    for (const p of pending) {
      enqueueOutbox(CARD,{id:p.key,text:p.text,images:0,at:Date.now()});
      updateOutbox(CARD,p.key,{state:"delivering",originalOperationOnly:true,operationId:"report-op-"+p.key.split("-").at(-1)});
    }
  },
  select:(name:string)=>{
    const path='/fixture/selected-'+name+'.jsonl';
    viewBus.reportIdentity({viewSessionId:'fixture-view',deviceId:'fixture-device'});
    viewBus.reportContext({project:'viewer',board:{renderedRevision:null,durableRevision:null,sync:'unavailable'}});
    viewBus.reportCards([{path,conversationId:'conversation_selected_'+name,project:'viewer',label:'Selected '+name}]);
    viewBus.reportSlice({mode:'list',focusedPath:path,selectedPaths:[path],visiblePaths:[path],camera:null});
  },
  refreshes:()=>refreshes,
  saved:async()=>Promise.all((await composerSubmissionPayloads.list(CARD)).map(ref=>composerSubmissionPayloads.restore(ref))),
  holdStorage:()=>{
    const original=crypto.subtle.digest.bind(crypto.subtle);
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    crypto.subtle.digest=(async (...args:Parameters<SubtleCrypto['digest']>)=>{await wait;return original(...args);}) as SubtleCrypto['digest'];
    return Object.assign(window,{releasePayloadStorage:()=>{crypto.subtle.digest=original;release();}}),true;
  },
  state:()=>({outbox:readOutbox(CARD),pending:readPendingDeliveries(CARD)}),
  remount:()=>render(),switchCard:(other:boolean)=>render(other),
  mode:(next:string)=>{mode=next;},
  profile:()=>{file.model="fixture-later-model";file.effort="low";render();},
  receipts:(next:RuntimeReceipt[])=>publishReceipts(next),
  nextRevision:()=>revisionFloor()+1,
}});
