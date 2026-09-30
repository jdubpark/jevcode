import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./Shell.module.css";

export interface AnnounceOptions {
  /**
   * Throttle key: at most one announcement per key per minIntervalMs. The throttle is trailing: the latest
   * text that arrives inside the window replaces older pending text and is spoken when the window ends.
   */
  key?: string;
  minIntervalMs?: number;
}

export type Announce = (message: string, options?: AnnounceOptions) => void;

export const LiveRegionContext = createContext<Announce>(() => undefined);

export function useAnnounce(): Announce {
  return useContext(LiveRegionContext);
}

/** The one polite aria-live region (spec §7.13): view switches, live follow, new steps, findings, copies. */
export function LiveRegion({ children, onAnnounce }: { children: ReactNode; onAnnounce?(message: string): void }) {
  const [message, setMessage] = useState("");
  const lastByKey = useRef(new Map<string, number>());
  const pendingByKey = useRef(new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>());
  const onAnnounceRef = useRef(onAnnounce);
  onAnnounceRef.current = onAnnounce;
  const speak = useCallback((text: string) => {
    onAnnounceRef.current?.(text);
    // A trailing no-break space makes a repeated message a new text node, so it is read again.
    setMessage((previous) => (previous === text ? `${text}\u00a0` : text));
  }, []);
  useEffect(() => {
    const pending = pendingByKey.current;
    return () => {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
  }, []);
  const announce = useCallback<Announce>(
    (text, options) => {
      const key = options?.key;
      if (key !== undefined) {
        const interval = options?.minIntervalMs ?? 0;
        const now = Date.now();
        const last = lastByKey.current.get(key);
        if (last !== undefined && now - last < interval) {
          const held = pendingByKey.current.get(key);
          if (held) {
            held.text = text;
            return;
          }
          const entry = {
            text,
            timer: setTimeout(() => {
              pendingByKey.current.delete(key);
              lastByKey.current.set(key, Date.now());
              speak(entry.text);
            }, last + interval - now),
          };
          pendingByKey.current.set(key, entry);
          return;
        }
        lastByKey.current.set(key, now);
        const held = pendingByKey.current.get(key);
        if (held) {
          clearTimeout(held.timer);
          pendingByKey.current.delete(key);
        }
      }
      speak(text);
    },
    [speak],
  );
  return (
    <LiveRegionContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {message}
      </div>
    </LiveRegionContext.Provider>
  );
}
