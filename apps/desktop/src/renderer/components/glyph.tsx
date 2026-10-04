/** Small 16px line icons for the main window chrome; paths follow the console-main mockup's symbols. */
const PATHS = {
  list: "M6.5 4.25h7M6.5 8h7M6.5 11.75h7",
  live: "M6.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0M4.75 4.75a4.6 4.6 0 0 0 0 6.5M11.25 4.75a4.6 4.6 0 0 1 0 6.5",
  check: "M3.5 8.25l3 3 6-6.5",
  clock: "M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0M8 4.75V8l2.25 1.5",
  trace: "M2.25 3.25h11.5M2.25 6h11.5M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5",
  term: "M4 2.75h8a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2zM5 6.25 7 8l-2 1.75M8.75 10h2.5",
  folder: "M2.5 4.5a1 1 0 0 1 1-1h2.75l1.25 1.5h5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  close: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  inspect: "M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0M8 7.25v3.5M8 5.25v.01",
  alert: "M8 2.5l6 10.5H2zM8 6.75v2.75M8 11.25v.01",
  stop: "M4.5 4.5h7v7h-7z",
  pause: "M6 4.5v7M10 4.5v7",
  fork: "M3 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M6.5 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M4.5 5v.75A2.25 2.25 0 0 0 6.75 8h2.5a2.25 2.25 0 0 0 2.25-2.25V5M8 8v3",
  chev: "M4.75 6.5 8 9.75l3.25-3.25",
  /** Two slider tracks with knobs: settings, distinct from the list rows above it. */
  settings: "M2.5 5h4.25M9.75 5h3.75M2.5 11h1.25M6.75 11h6.75M6.75 5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3.75 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
  /** A key: the Settings page's API key rows. */
  key: "M10.5 2.5a3 3 0 1 1 0 6a3 3 0 0 1 0-6M8.4 7.6L2.5 13.5M4.5 11.5l1.5 1.5M6 10l1.5 1.5",
  /** A left chevron: the Settings page's Back button. */
  back: "M10 3.5L5.5 8l4.5 4.5",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph(props: { name: GlyphName }) {
  return (
    <svg className="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[props.name]} />
    </svg>
  );
}
