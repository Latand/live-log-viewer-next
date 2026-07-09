import { expect, test } from "bun:test";

import { codexEntryPointVisible, createCodexAccountsStore } from "./useCodexAccounts";
import type { CodexAccountOption } from "./useCodexAccounts";

const account = (id: string, label = id): CodexAccountOption => ({ id, label, authPresent: true, loginPending: false, loginState: "authenticated", deviceAuth: null });
const accountsResponse = (active: string, accounts = [account(active)]) => new Response(JSON.stringify({ codex: { active, accounts } }), { headers: { "content-type": "application/json" } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const advance = async () => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

test("two mounted consumers observe one serialized mutation and duplicate Add is disabled", async () => {
  const requests: { input: string; body?: string; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const store = createCodexAccountsStore({ fetcher: async (input, init) => {
    const reply = deferred<Response>();
    requests.push({ input: String(input), body: typeof init?.body === "string" ? init.body : undefined, reply });
    return reply.promise;
  } });
  const a = store.subscribe(() => {});
  const b = store.subscribe(() => {});
  requests.shift()!.reply.resolve(accountsResponse("A", [account("A"), account("B")]));
  await advance();

  const select = store.select("B");
  const concurrentAdd = store.add("Work");
  await Promise.resolve();
  expect(requests).toHaveLength(1);
  expect(requests[0].input).toBe("/api/accounts/codex/active");
  expect(await concurrentAdd).toBeFalse();
  requests.shift()!.reply.resolve(new Response(null, { status: 204 }));
  await advance();
  requests.shift()!.reply.resolve(accountsResponse("B", [account("A"), account("B")]));
  expect(await select).toBeTrue();
  expect(store.active).toBe("B");

  const add = store.add("Work");
  const duplicate = store.add("Work");
  await Promise.resolve();
  expect(await duplicate).toBeFalse();
  expect(requests).toHaveLength(1);
  expect(requests[0].input).toBe("/api/accounts/codex");
  requests.shift()!.reply.resolve(new Response(JSON.stringify({ account: { id: "work", label: "Work", authPresent: false, loginPending: true }, target: "codex-login" }), { headers: { "content-type": "application/json" } }));
  await advance();
  requests.shift()!.reply.resolve(accountsResponse("B", [account("A"), account("B"), account("work", "Work")]));
  expect(await add).toBeTrue();
  expect(store.notice).toMatchObject({ kind: "success", operation: "add", action: null });
  a();
  b();
});

test("A to B to A keeps the latest account response when the oldest A arrives last", async () => {
  const replies: ReturnType<typeof deferred<Response>>[] = [];
  const store = createCodexAccountsStore({ fetcher: async () => {
    const reply = deferred<Response>();
    replies.push(reply);
    return reply.promise;
  } });
  const first = store.refresh();
  const second = store.refresh();
  const third = store.refresh();
  replies[1].resolve(accountsResponse("B", [account("B", "B current")]));
  replies[2].resolve(accountsResponse("A", [account("A", "A newest")]));
  await third;
  replies[0].resolve(accountsResponse("A", [account("A", "A stale")]));
  await Promise.all([first, second]);
  expect(store.active).toBe("A");
  expect(store.accounts[0]?.label).toBe("A newest");
});

test("a successful Add remains reconciled when its follow-up refresh fails and exposes refresh recovery", async () => {
  let call = 0;
  const store = createCodexAccountsStore({ fetcher: async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ account: { id: "work", label: "Work", authPresent: false, loginPending: true }, target: "codex-login" }), { headers: { "content-type": "application/json" } });
    throw new Error("refresh unavailable");
  } });
  expect(await store.add("Work")).toBeTrue();
  expect(store.accounts).toEqual([expect.objectContaining({ id: "work", label: "Work" })]);
  expect(store.status).toBe("error");
  expect(store.notice).toMatchObject({ kind: "error", operation: "refresh", action: { operation: "refresh" } });
});

test("typed retry repeats the failed Add and a successful refresh clears refresh errors", async () => {
  let addAttempts = 0;
  const store = createCodexAccountsStore({ fetcher: async (input) => {
    if (String(input) === "/api/accounts/codex") {
      addAttempts += 1;
      if (addAttempts === 1) return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ account: { id: "work", label: "Work", authPresent: false, loginPending: true }, target: "codex-login" }), { headers: { "content-type": "application/json" } });
    }
    return accountsResponse("A", [account("A"), account("work", "Work")]);
  } });
  expect(await store.add("Work")).toBeFalse();
  expect(store.notice).toMatchObject({ operation: "add", action: { operation: "add", label: "Work" } });
  expect(await store.retryNotice()).toBeTrue();
  expect(addAttempts).toBe(2);

  let online = false;
  const recovered = createCodexAccountsStore({ fetcher: async () => {
    if (!online) throw new Error("offline");
    return accountsResponse("A");
  } });
  await recovered.refresh();
  expect(recovered.notice?.operation).toBe("refresh");
  online = true;
  expect(await recovered.retryNotice()).toBeTrue();
  expect(recovered.notice).toBeNull();
});

test("unmount cleanup aborts a pending request and a bounded timeout leaves an error state", async () => {
  const pending = deferred<Response>();
  const store = createCodexAccountsStore({ fetcher: async () => pending.promise, timeoutMs: 5 });
  const unsubscribe = store.subscribe(() => {});
  unsubscribe();
  pending.resolve(accountsResponse("A"));
  await Promise.resolve();
  expect(store.status).toBe("loading");

  const hung = createCodexAccountsStore({ fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), timeoutMs: 5 });
  const result = hung.refresh();
  await Bun.sleep(15);
  expect(await result).toBeFalse();
  expect(hung.status).toBe("error");
  expect(hung.notice?.action?.operation).toBe("refresh");
});

test("the account entry point stays visible during loading, errors, and empty limits", () => {
  expect(codexEntryPointVisible(false, "loading")).toBeTrue();
  expect(codexEntryPointVisible(false, "error")).toBeTrue();
  expect(codexEntryPointVisible(false, "ready")).toBeTrue();
  expect(codexEntryPointVisible(true, "ready")).toBeTrue();
});
