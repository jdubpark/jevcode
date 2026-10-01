import { useCallback, useEffect, useRef, type RefObject } from "react";

export interface PopoverDismissal {
  /** Attach to the element that wraps the trigger and the popover. */
  anchorRef: RefObject<HTMLSpanElement | null>;
  /** Attach to the trigger button. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Closes the popover and returns focus to the trigger. */
  close(): void;
}

/**
 * Shared popover dismissal: Escape closes and returns focus to the trigger; a pointerdown outside
 * the anchor closes without moving focus (the pointer already chose a new target).
 */
export function usePopoverDismissal(open: boolean, setOpen: (open: boolean) => void): PopoverDismissal {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  const close = useCallback(() => {
    setOpenRef.current(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    const doc = anchorRef.current?.ownerDocument;
    if (!open || doc === undefined) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      // Not `instanceof Node`: a popout window's nodes belong to another realm.
      const target = event.target as Node | null;
      if (target !== null && anchorRef.current?.contains(target)) return;
      setOpenRef.current(false);
    };
    doc.addEventListener("keydown", onKeyDown);
    doc.addEventListener("pointerdown", onPointerDown);
    return () => {
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  return { anchorRef, triggerRef, close };
}
