import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import styles from "./Shell.module.css";

export interface AnnounceOptions {
  /** Throttle key: one announcement per key per minIntervalMs. */
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
  const announce = useCallback<Announce>(
    (text, options) => {
      if (options?.key !== undefined) {
        const now = Date.now();
        const last = lastByKey.current.get(options.key);
        if (last !== undefined && now - last < (options.minIntervalMs ?? 0)) return;
        lastByKey.current.set(options.key, now);
      }
      onAnnounce?.(text);
      // A trailing no-break space makes a repeated message a new text node, so it is read again.
      setMessage((previous) => (previous === text ? `${text}\u00a0` : text));
    },
    [onAnnounce],
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
