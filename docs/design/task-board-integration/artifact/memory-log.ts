import { useEffect, useState } from 'react';
import { transcript } from './fixtures';
import type { FileEntry } from '@/lib/types';
const empty: string[] = [];
export const counters: Record<string, Record<string, number>> = {};
const waiting=new Map<string,Set<()=>void>>();
export function whenVisible(path:string):Promise<void>{
  if(counters[path]?.active>0)return Promise.resolve();
  return new Promise(resolve=>{const set=waiting.get(path)??new Set();set.add(resolve);waiting.set(path,set);});
}
export function count(path:string, key:string, n=1) {
  const c=counters[path]??={}; c[key]=(c[key]??0)+n;
}
if(typeof window!=='undefined') (window as any).__viewCounters=counters;
export function useLogTail(file: FileEntry | null, pausedInput = false) {
  const [, update] = useState(0);
  const [paused, setPaused] = useState(false);
  const path = file?.path;
  useEffect(() => {
    if(!path||paused||pausedInput)return;
    count(path,'attach');count(path,'active',1);
    for(const resolve of waiting.get(path)??[])resolve();waiting.delete(path);
    // Catch up once after effects resume, even if every event arrived hidden.
    update(n=>n+1);
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail === path) { count(path,'callbacks');update(n=>n+1); }
    };
    window.addEventListener('sample-transcript', listener);
    return () => {count(path,'detach');count(path,'active',-1);window.removeEventListener('sample-transcript', listener);};
  }, [path, paused, pausedInput]);
  const lines = path ? transcript.get(path) ?? empty : empty;
  if(path)count(path,'tailReads');
  return { lines, linesStart: 0, size: lines.reduce((n,line)=>n+line.length+1,0), loading: false, error: null,
    tickTime: null, paused, setPaused, clear: () => {}, hasMore: false, loadingOlder: false,
    loadOlder: async () => 0, prependGen: 0 };
}
