/** "now", "5 m", "2 h", "3 d" for a session start time (the mockup's sidebar meta). */
export function relativeAge(iso: string, nowMs: number): string {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - started) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}
