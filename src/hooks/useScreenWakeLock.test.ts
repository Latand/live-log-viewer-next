import { expect, test } from "bun:test";

import {
  createWakeLockController,
  type WakeLockEnvironment,
  type WakeLockSentinelLike,
} from "./useScreenWakeLock";

/*
 * Issue #712 — the screen wake-lock controller is the real ownership seam: it
 * decides when a sentinel exists, and it is the only thing that may hold one.
 * These tests inject the whole Wake Lock API, visibility and storage, so the
 * lifecycle is deterministic with no browser involved, and they fail if
 * acquire, release, or the visibility re-acquire is removed.
 */

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface FakeSentinel extends WakeLockSentinelLike {
  released: boolean;
  /** Simulate the platform dropping the lock on its own (Safari does). */
  systemRelease(): void;
}

function fakeSentinel(options: { bornReleased?: boolean } = {}): FakeSentinel {
  const listeners = new Set<() => void>();
  const sentinel: FakeSentinel = {
    released: options.bornReleased === true,
    async release() {
      if (sentinel.released) return;
      sentinel.released = true;
      for (const listener of [...listeners]) listener();
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    systemRelease() {
      sentinel.released = true;
      for (const listener of [...listeners]) listener();
    },
  };
  return sentinel;
}

interface Harness {
  environment: WakeLockEnvironment;
  /** Every sentinel ever handed out, in request order. */
  granted: FakeSentinel[];
  requests: number;
  visible: boolean;
  store: Map<string, string>;
  /** Sentinels handed out that nobody has released — must never exceed one. */
  held(): FakeSentinel[];
}

function harness(
  options: {
    supported?: boolean;
    secureContext?: boolean;
    visible?: boolean;
    persisted?: boolean;
    /** Reject the request instead of granting a sentinel. */
    reject?: unknown;
    /** Hand back a sentinel that is already released (a Safari quirk). */
    bornReleased?: boolean;
    /** Never settle the request promise — proves stale-resolution handling. */
    defer?: boolean;
  } = {},
): Harness & { settleDeferred(): void } {
  const store = new Map<string, string>();
  if (options.persisted) store.set("llvKeepAwake", "1");
  const deferred: Array<(sentinel: FakeSentinel) => void> = [];
  const self: Harness & { settleDeferred(): void } = {
    granted: [],
    requests: 0,
    visible: options.visible !== false,
    store,
    held: () => self.granted.filter((sentinel) => !sentinel.released),
    settleDeferred() {
      for (const resolve of deferred.splice(0)) {
        const sentinel = fakeSentinel();
        self.granted.push(sentinel);
        resolve(sentinel);
      }
    },
    environment: {
      request:
        options.supported === false
          ? null
          : () => {
              self.requests += 1;
              if (options.reject !== undefined) return Promise.reject(options.reject);
              if (options.defer) return new Promise<WakeLockSentinelLike>((resolve) => deferred.push(resolve));
              const sentinel = fakeSentinel({ bornReleased: options.bornReleased });
              self.granted.push(sentinel);
              return Promise.resolve(sentinel);
            },
      secureContext: options.secureContext !== false,
      isVisible: () => self.visible,
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
      },
    },
  };
  return self;
}

test("one explicit enable acquires exactly one sentinel and persists the intent", async () => {
  const world = harness();
  const controller = createWakeLockController(world.environment);
  controller.start();
  expect(controller.getState()).toEqual({ enabled: false, status: "off" });

  controller.setEnabled(true);
  expect(controller.getState().status).toBe("requesting");
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "active" });
  expect(world.requests).toBe(1);
  expect(world.held()).toHaveLength(1);
  /* Device-local intent, written the moment the operator asks. */
  expect(world.store.get("llvKeepAwake")).toBe("1");
});

test("disabling releases the sentinel and records that the operator said no", async () => {
  const world = harness();
  const controller = createWakeLockController(world.environment);
  controller.start();
  controller.setEnabled(true);
  await settle();

  controller.setEnabled(false);
  await settle();

  expect(controller.getState()).toEqual({ enabled: false, status: "off" });
  expect(world.granted[0]!.released).toBe(true);
  expect(world.held()).toHaveLength(0);
  expect(world.store.get("llvKeepAwake")).toBe("0");
});

test("a persisted enable is restored on the next visit and acquires without being asked again", async () => {
  const world = harness({ persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "active" });
  expect(world.requests).toBe(1);
});

test("backgrounding releases the lock and returning re-acquires a fresh one", async () => {
  const world = harness({ persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();
  const first = world.granted[0]!;

  world.visible = false;
  controller.syncVisibility();
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "waiting" });
  expect(first.released).toBe(true);
  expect(world.held()).toHaveLength(0);

  world.visible = true;
  controller.syncVisibility();
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "active" });
  expect(world.requests).toBe(2);
  /* A fresh sentinel, and still only ever one held. */
  expect(world.held()).toHaveLength(1);
  expect(world.held()[0]).not.toBe(first);
});

test("a visibility bounce while disabled asks for nothing", async () => {
  const world = harness();
  const controller = createWakeLockController(world.environment);
  controller.start();
  world.visible = false;
  controller.syncVisibility();
  world.visible = true;
  controller.syncVisibility();
  await settle();

  expect(world.requests).toBe(0);
  expect(controller.getState()).toEqual({ enabled: false, status: "off" });
});

test("enabling while hidden waits instead of claiming the screen is held", async () => {
  const world = harness({ visible: false });
  const controller = createWakeLockController(world.environment);
  controller.start();
  controller.setEnabled(true);
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "waiting" });
  expect(world.requests).toBe(0);
});

test("a system release while visible is recovered once, then reported instead of looped", async () => {
  const world = harness({ persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();

  /* Safari drops the sentinel by itself (webkit bug 254545). */
  world.granted[0]!.systemRelease();
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "active" });
  expect(world.requests).toBe(2);

  /* A platform that drops every lock must not become a request loop: the second
     release inside the same visible stretch is reported, not retried. */
  world.granted[1]!.systemRelease();
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "interrupted" });
  expect(world.requests).toBe(2);
  expect(world.held()).toHaveLength(0);

  /* Coming back to the page clears the bound and tries again. */
  world.visible = false;
  controller.syncVisibility();
  world.visible = true;
  controller.syncVisibility();
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "active" });
  expect(world.requests).toBe(3);
});

test("a sentinel handed back already released is never reported as active", async () => {
  const world = harness({ persisted: true, bornReleased: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();

  /* One bounded retry, and both grants are dead on arrival. */
  expect(world.requests).toBe(2);
  expect(controller.getState()).toEqual({ enabled: true, status: "interrupted" });
});

test("an unsupported browser says so and never pretends the screen is protected", async () => {
  const world = harness({ supported: false, persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "unsupported" });

  controller.setEnabled(false);
  controller.setEnabled(true);
  await settle();
  expect(controller.getState()).toEqual({ enabled: true, status: "unsupported" });
});

test("an insecure context is named as such, not silently dead", async () => {
  const world = harness({ secureContext: false });
  const controller = createWakeLockController(world.environment);
  controller.start();
  controller.setEnabled(true);
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "insecure" });
  expect(world.requests).toBe(0);
});

test("a refused request reads as blocked and any other failure as failed", async () => {
  const denied = harness({ reject: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
  const blocked = createWakeLockController(denied.environment);
  blocked.start();
  blocked.setEnabled(true);
  await settle();
  expect(blocked.getState()).toEqual({ enabled: true, status: "blocked" });

  const broken = harness({ reject: new Error("boom") });
  const failed = createWakeLockController(broken.environment);
  failed.start();
  failed.setEnabled(true);
  await settle();
  expect(failed.getState()).toEqual({ enabled: true, status: "failed" });
});

test("stop() releases the sentinel and stops honouring the intent", async () => {
  const world = harness({ persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  await settle();

  controller.stop();
  await settle();
  expect(world.granted[0]!.released).toBe(true);
  expect(world.held()).toHaveLength(0);

  /* Nothing wakes it back up after stop: the surface is gone. */
  controller.syncVisibility();
  controller.setEnabled(true);
  await settle();
  expect(world.requests).toBe(1);
});

test("repeated enables and starts can never hold two sentinels", async () => {
  const world = harness();
  const controller = createWakeLockController(world.environment);
  controller.start();
  controller.start();
  controller.setEnabled(true);
  controller.setEnabled(true);
  controller.syncVisibility();
  await settle();

  expect(world.requests).toBe(1);
  expect(world.held()).toHaveLength(1);
});

test("a request that resolves after the operator disabled it is released, not adopted", async () => {
  const world = harness({ defer: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  controller.setEnabled(true);
  expect(world.requests).toBe(1);

  controller.setEnabled(false);
  world.settleDeferred();
  await settle();

  expect(controller.getState()).toEqual({ enabled: false, status: "off" });
  /* The late sentinel would otherwise be a lock with no owner and no off switch. */
  expect(world.granted).toHaveLength(1);
  expect(world.granted[0]!.released).toBe(true);
  expect(world.held()).toHaveLength(0);
});

test("a request that resolves after the page went hidden is released, not adopted", async () => {
  const world = harness({ defer: true, persisted: true });
  const controller = createWakeLockController(world.environment);
  controller.start();
  expect(world.requests).toBe(1);

  world.visible = false;
  controller.syncVisibility();
  world.settleDeferred();
  await settle();

  expect(controller.getState()).toEqual({ enabled: true, status: "waiting" });
  expect(world.held()).toHaveLength(0);
});

test("subscribers see every state change and stop hearing after unsubscribe", async () => {
  const world = harness();
  const controller = createWakeLockController(world.environment);
  const seen: string[] = [];
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getState();
    seen.push(`${state.enabled ? "on" : "off"}:${state.status}`);
  });
  controller.start();
  controller.setEnabled(true);
  await settle();
  /* The intent flip is its own notification: the UI has to show the switch on
     before the platform has answered. */
  expect(seen).toEqual(["on:off", "on:requesting", "on:active"]);

  unsubscribe();
  controller.setEnabled(false);
  await settle();
  expect(seen).toEqual(["on:off", "on:requesting", "on:active"]);
});
