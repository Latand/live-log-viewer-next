/**
 * One shape for a fact that could not be established.
 *
 * Automatic host retirement (#747) is a conjunction over a dozen inputs, and
 * three review rounds each found a different clause that resolved an
 * undeterminable input in favour of killing: a `catch` that returned an empty
 * list, a reader whose `null` meant both "absent" and "unreadable", a probe
 * that gave up on a window it had sized itself. Every one of those was a clause
 * inventing its own fallback, and every fallback happened to mean "nothing is
 * pending here, go ahead".
 *
 * So a source that can fail to answer returns `Determinable<T>` and says why,
 * and the caller cannot spend it without handling both cases. `null` inside a
 * determined value keeps meaning what it always meant — a real, established
 * absence — which is the distinction the overloaded `| null` returns had lost.
 *
 * There is deliberately no `valueOr(fallback)` helper here. A default is
 * exactly the move this type exists to prevent: what an unknown means is a
 * policy decision that belongs to one place per consumer, not to the twelve
 * call sites that read one.
 */

export interface Determined<T> {
  readonly determined: true;
  readonly value: T;
}

export interface Undetermined {
  readonly determined: false;
  /** Why the fact could not be established, in a form an audit line can carry. */
  readonly why: string;
}

export type Determinable<T> = Determined<T> | Undetermined;

export function determined<T>(value: T): Determined<T> {
  return { determined: true, value };
}

export function undetermined(why: string): Undetermined {
  return { determined: false, why };
}

/**
 * Projects a determined value and passes an undetermined one straight through,
 * reason intact. This is how a reading is turned into a judgement without any
 * step in between getting the chance to substitute a default for the unknown.
 */
export function mapDeterminable<T, U>(
  input: Determinable<T>,
  project: (value: T) => U,
): Determinable<U> {
  return input.determined ? determined(project(input.value)) : input;
}
