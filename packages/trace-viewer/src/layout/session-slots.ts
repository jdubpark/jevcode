// The layout builders' last-input caches (module-level slots: the Brief's changes, architecture and decision cards, the
// component Inspector, the step digest and diff) hold the lists of the session they last saw. They belong to one
// session: the first build for another session id clears every slot, so a session switch (a TraceViewer remount is
// keyed by session id) keeps none of the old session's lists. Pure and React-free.

interface Slot {
  clear(): void;
  /** The lists and models the slot holds now; for the test probe. */
  held(): readonly unknown[];
}

const slots: Slot[] = [];
let sessionId: string | null = null;

/** Registers a module-level slot (once, at module load). */
export function sessionSlot(slot: Slot): void {
  slots.push(slot);
}

/** Called first by every build that fills a slot: a build for another session clears every slot. */
export function enterSession(id: string): void {
  if (id === sessionId) return;
  sessionId = id;
  for (const slot of slots) slot.clear();
}

/** Test-only probe: everything the slots hold now. */
export function heldBySessionSlots(): readonly unknown[] {
  return slots.flatMap((slot) => slot.held());
}
