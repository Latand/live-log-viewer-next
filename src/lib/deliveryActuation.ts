/**
 * One conversation's delivery actuation at a time (#1709).
 *
 * `beginDeliveryAttempt` refuses a claim while an earlier admission of the
 * same conversation is still waiting, but a claim is not yet a delivery: the
 * command reaches the runtime journal only afterwards, and the journal keeps
 * the order in which commands arrive. Every actuator therefore claims and
 * hands its command over inside this section, so a later claim cannot reach
 * the journal ahead of an earlier one.
 *
 * The section is a plain chain per conversation and spans only a claim and
 * its actuation. Ownership is never inherited from async context: work
 * receives a lease, and only code handed that lease as an argument continues
 * inside the section (the migration drain passes it to the delivery it calls).
 * Anything else, a tick queued from inside a section included, waits its turn.
 *
 * The state lives on `process` because Next evaluates instrumentation and
 * route handlers in separate bundle realms; the Viewer's senders, its
 * migration drain and its retry route all run in the Viewer process. Work that
 * throws releases the section, and nothing is retried here.
 */

declare const leaseBrand: unique symbol;

/** The right to act inside one conversation's section, valid while that section runs. */
export interface ActuationLease {
  readonly conversationId: string;
  readonly [leaseBrand]: true;
}

interface ActuationState {
  tails: Map<string, Promise<void>>;
  holders: Map<string, ActuationLease>;
}

const processState = process as typeof process & { __llvDeliveryActuation?: ActuationState };

function state(): ActuationState {
  const current = processState.__llvDeliveryActuation;
  /* A state an earlier build left on this process (its `held` store) is replaced, never read. */
  if (!current || !(current.holders instanceof Map)) {
    processState.__llvDeliveryActuation = { tails: new Map(), holders: new Map() };
  }
  return processState.__llvDeliveryActuation!;
}

function holds(conversationId: string, lease: ActuationLease | null | undefined): lease is ActuationLease {
  return Boolean(lease && lease.conversationId === conversationId && state().holders.get(conversationId) === lease);
}

function enter<T>(conversationId: string, work: (lease: ActuationLease) => T | Promise<T>): Promise<T> {
  const { tails, holders } = state();
  const lease = { conversationId } as ActuationLease;
  const previous = tails.get(conversationId) ?? Promise.resolve();
  const run = previous.then(async () => {
    holders.set(conversationId, lease);
    try {
      return await work(lease);
    } finally {
      if (holders.get(conversationId) === lease) holders.delete(conversationId);
    }
  });
  const tail = run.then(() => undefined, () => undefined);
  tails.set(conversationId, tail);
  void tail.then(() => {
    if (tails.get(conversationId) === tail) tails.delete(conversationId);
  });
  return run;
}

/** Runs `work` in the conversation's section once every earlier entry has ended. With the lease of the section
    now running, it runs at once, inside that section. */
export async function withConversationActuation<T>(
  conversationId: string,
  work: (lease: ActuationLease) => T | Promise<T>,
  lease: ActuationLease | null = null,
): Promise<T> {
  if (holds(conversationId, lease)) return work(lease);
  return enter(conversationId, work);
}

export type ActuationAttempt<T> = { acquired: true; value: T } | { acquired: false; released: Promise<void> };

/** Runs `work` in the section only if nobody holds or waits for it; otherwise answers when it is free, so a caller
    that serves many conversations can move on and come back. */
export async function tryConversationActuation<T>(
  conversationId: string,
  work: (lease: ActuationLease) => T | Promise<T>,
  lease: ActuationLease | null = null,
): Promise<ActuationAttempt<T>> {
  if (holds(conversationId, lease)) return { acquired: true, value: await work(lease) };
  const busy = state().tails.get(conversationId);
  if (busy) return { acquired: false, released: busy };
  return { acquired: true, value: await enter(conversationId, work) };
}
