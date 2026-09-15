import { AsyncLocalStorage } from "node:async_hooks";

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
 * The section is per process. The Viewer's senders, its migration drain and
 * its retry route all run in the Viewer process; the state lives on `process`
 * because Next evaluates instrumentation and route handlers in separate
 * bundle realms. A section entered again from inside itself runs at once.
 * Work that throws releases the section, and nothing is retried here.
 */
interface ActuationState {
  tails: Map<string, Promise<unknown>>;
  held: AsyncLocalStorage<ReadonlySet<string>>;
}

const processState = process as typeof process & { __llvDeliveryActuation?: ActuationState };

function state(): ActuationState {
  processState.__llvDeliveryActuation ??= { tails: new Map(), held: new AsyncLocalStorage() };
  return processState.__llvDeliveryActuation;
}

export async function withConversationActuation<T>(conversationId: string, work: () => T | Promise<T>): Promise<T> {
  const { tails, held } = state();
  const current = held.getStore();
  if (current?.has(conversationId)) return work();
  const inside = new Set(current ?? []).add(conversationId);
  const previous = tails.get(conversationId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => held.run(inside, work));
  tails.set(conversationId, run);
  try {
    return await run;
  } finally {
    if (tails.get(conversationId) === run) tails.delete(conversationId);
  }
}
