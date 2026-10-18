import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { generateBrief, unstableSections, type Writer } from "./brief.js";
import { collectRepository, repositoryRoot, type RepoContext } from "./collect.js";
import { repoEnabled, type AutoConfig } from "./config.js";
import { isTestPath } from "@jevcode/codebase-map";
import { clean, git, hash, NESTED_ENV, readSource } from "./io.js";
import { heuristicGate, jevGate, type GateJudgment, type GateSignals, type JevTransport } from "./jev.js";
import { appendLedger, calibrate, churn, newId, readLedger, readTuning, saveTuning, type Decision, type Run } from "./learning.js";
import { buildPrompt, SECTIONS } from "./prompt.js";
import { renderBrief } from "./report.js";
import { previousContext, readCheckpoint, readSnapshot, renderedPath, resolveStateDirectory, saveCheckpoint, saveSnapshot, type Checkpoint, type Snapshot } from "./state.js";

const MIN_ACTIVITY_BYTES = 2048;

export interface AutoOptions {
  repo: string;
  logs: string[];
  session: string | null;
  trigger: "hook" | "manual";
  dryRun: boolean;
  stateDir: string;
  config: AutoConfig;
  judge: JevTransport | null;
  writers: Writer[];
  log: (message: string) => void;
  now?: () => Date;
  /** How often the checkout is polled for changes while the writer runs (default 15 s). */
  watchMs?: number;
}
export interface AutoOutcome { action: "skip" | "run" | "coalesced" | "disabled" | "failed"; reason: string; judgment?: GateJudgment; briefPath?: string }

/** activity: transcript sizes at the last check; briefActivity: sizes when the last brief was written. */
const AutoStateSchema = z.object({ quickKey: z.string().nullable(), activity: z.record(z.number()), briefActivity: z.record(z.number()).default({}) });
type AutoState = z.infer<typeof AutoStateSchema>;
const autoBase = (directory: string, repo: string): string => path.join(directory, hash(repo));

async function readAutoState(directory: string, repo: string): Promise<AutoState> {
  try { return AutoStateSchema.parse(JSON.parse(await readFile(`${autoBase(directory, repo)}.auto.json`, "utf8"))); }
  catch { return { quickKey: null, activity: {}, briefActivity: {} }; }
}
async function saveAutoState(directory: string, repo: string, state: AutoState): Promise<void> {
  const target = `${autoBase(directory, repo)}.auto.json`;
  await writeFile(`${target}.${process.pid}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${target}.${process.pid}.tmp`, target);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const LockSchema = z.object({ pid: z.number(), token: z.string(), expiresAt: z.number() });
const readText = (file: string): Promise<string | null> => readFile(file, "utf8").catch(() => null);
const parseLock = (text: string | null): z.infer<typeof LockSchema> | null => { try { return LockSchema.parse(JSON.parse(text ?? "")); } catch { return null; } };

interface CheckoutLock {
  /** Extends the owner's expiry by one pass budget; called at the start of each pass. */
  refresh(): Promise<void>;
  /** True when a trigger arrived meanwhile: the lock is kept (or re-taken) for one more pass. */
  release(): Promise<boolean>;
  unlock(): Promise<void>;
}

/**
 * One automatic run per checkout. The lock file is linked into place fully written and carries its
 * owner's own expiry, refreshed each pass, so a reader with a different timeout judges it correctly.
 * It is stale when its owner is gone, it expired (PIDs are reused after a crash or reboot), or it is
 * unreadable. A trigger that finds a live lock leaves a marker for one re-check.
 */
async function acquire(directory: string, repo: string, passBudgetMs: number): Promise<CheckoutLock | null> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = `${autoBase(directory, repo)}.auto.lock`;
  const pending = `${autoBase(directory, repo)}.pending`;
  const token = randomUUID();
  const content = () => JSON.stringify({ pid: process.pid, token, expiresAt: Date.now() + passBudgetMs });
  const owned = async () => parseLock(await readText(lock))?.token === token;
  const temporaryFile = async () => {
    const temporary = `${lock}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content(), { mode: 0o600, flag: "wx" });
    return temporary;
  };
  const take = async (): Promise<boolean> => {
    const temporary = await temporaryFile();
    try { await link(temporary, lock); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    finally { await rm(temporary, { force: true }); }
  };
  let held = false;
  const handle: CheckoutLock = {
    async refresh() {
      if (!held || !(await owned())) return;
      const temporary = await temporaryFile();
      await rename(temporary, lock).catch(async (error: unknown) => { await rm(temporary, { force: true }); throw error; });
    },
    async unlock() {
      if (!held) return;
      held = false;
      // Remove only our own lock, never a successor's.
      if (await owned()) await rm(lock, { force: true });
    },
    async release() {
      if (await rm(pending).then(() => true, () => false)) return true;
      await handle.unlock();
      // A marker left between the check and the unlock would otherwise be lost.
      if (await readText(pending) !== null && await take()) { held = true; await rm(pending, { force: true }); return true; }
      return false;
    },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await take()) { held = true; return handle; }
    const current = await readText(lock);
    if (current === null) continue;
    const owner = parseLock(current);
    if (owner && alive(owner.pid) && Date.now() < owner.expiresAt) break;
    if (await readText(lock) === current) await rm(lock, { force: true });
  }
  await writeFile(pending, "", { mode: 0o600 });
  return null;
}

/** HEAD, status and the size/mtime of dirty paths: detects "nothing changed" without scanning the repository. */
async function quickKey(repo: string): Promise<string> {
  const head = await git(repo, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const stats = await Promise.all(status.split("\0").filter((entry) => entry.length > 3).map(async (entry) => {
    const info = await lstat(path.join(repo, entry.slice(3))).catch(() => null);
    return info ? `${entry}:${info.size}:${info.mtimeMs}` : entry;
  }));
  return hash(head + "\0" + stats.join("\0"));
}

async function resolveBase(repo: string, setting: string): Promise<string | undefined> {
  if (setting === "head") return undefined;
  if (setting !== "merge-base") return setting;
  const upstream = await git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).then((ref) => ref.trim(), () => "");
  const head = await git(repo, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  if (head === null) return undefined;
  for (const candidate of [upstream, "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"].filter(Boolean)) {
    const base = await git(repo, ["merge-base", head, candidate]).then((value) => value.trim(), () => "");
    if (base) return base === head ? undefined : base;
  }
  return undefined;
}

/** Added and removed non-blank lines, compared as multisets: enough to tell a comment from a logic change. */
export function lineChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const minus = (from: string[], other: string[]) => {
    const counts = new Map<string, number>();
    for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1);
    return from.filter((line) => { const left = counts.get(line) ?? 0; if (left > 0) { counts.set(line, left - 1); return false; } return true; });
  };
  const b = lines(before), a = lines(after);
  return { added: minus(a, b), removed: minus(b, a) };
}

/** Before: the brief's snapshot of dirty files, else the file at the brief's commit; after: the checkout. */
async function changesSinceBrief(repo: string, checkpoint: Checkpoint, snapshot: Snapshot | null, changed: string[], removed: string[]): Promise<GateSignals["changes"]> {
  const out: GateSignals["changes"] = [];
  const ordered = [...changed.filter((file) => !isTestPath(file)), ...changed.filter((file) => isTestPath(file))];
  for (const file of ordered.slice(0, 8)) {
    const before = snapshot?.files[file] ?? (checkpoint.head ? await git(repo, ["show", `${checkpoint.head}:${file}`]).catch(() => "") : "");
    const after = (await readSource(repo, file)) ?? "";
    if (before.includes("\0")) continue;
    const delta = lineChanges(clean(before), clean(after));
    out.push({ path: file, added: delta.added.length, removed: delta.removed.length, lines: [...delta.added.slice(0, 4).map((line) => `+ ${line.trim()}`), ...delta.removed.slice(0, 4).map((line) => `- ${line.trim()}`)] });
  }
  for (const file of removed.slice(0, Math.max(0, 8 - out.length))) out.push({ path: file, added: 0, removed: (snapshot?.files[file] ?? "").split("\n").length, lines: [] });
  return out;
}

export function gateSignals(context: RepoContext, checkpoint: Checkpoint | null, newActivityBytes: number, now: Date, changes: GateSignals["changes"] = []): GateSignals {
  const changed = checkpoint ? Object.entries(context.files).filter(([file, info]) => checkpoint.fileHashes[file] !== info.hash).map(([file]) => file) : context.changed;
  const removed = checkpoint ? Object.keys(checkpoint.fileHashes).filter((file) => context.files[file] === undefined) : [];
  const owner = (file: string) => context.components.filter((component) => component.path === "" || component.path === "." || file === component.path || file.startsWith(component.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const touched = new Map<string, { path: string; changed: number; incoming: number }>();
  for (const file of [...changed, ...removed]) {
    const component = owner(file);
    if (!component) continue;
    const entry = touched.get(component.id) ?? { path: component.path, changed: 0, incoming: component.incoming };
    entry.changed += 1;
    touched.set(component.id, entry);
  }
  return {
    hasCheckpoint: checkpoint !== null, changedSinceBrief: changed, removedSinceBrief: removed,
    touchedComponents: [...touched.values()].sort((a, b) => b.changed - a.changed), componentCount: context.components.length,
    newActivityBytes, recentActivity: context.activity.flatMap((log) => log.records.slice(-8).map((entry) => entry.text)),
    minutesSinceBrief: checkpoint ? (now.getTime() - Date.parse(checkpoint.generatedAt)) / 60_000 : null,
    previous: checkpoint?.brief ?? null, changes,
  };
}

export async function runAuto(input: AutoOptions): Promise<AutoOutcome> {
  if (process.env[NESTED_ENV]) return { action: "skip", reason: "inside a briefing run" };
  // A session may stop before its transcript exists; a missing log is no activity, not a failure.
  const logs = (await Promise.all(input.logs.map(async (file) => (await stat(file).catch(() => null))?.isFile() ? [file] : []))).flat();
  const options = { ...input, logs };
  const now = options.now ?? (() => new Date());
  let repo: string;
  try { repo = await repositoryRoot(options.repo); }
  catch { return { action: "disabled", reason: "not a Git checkout" }; }
  if (!(await repoEnabled(options.config, repo))) return { action: "disabled", reason: "this checkout is not opted in to automatic briefs (jevcode optin)" };
  const directory = await resolveStateDirectory(options.stateDir, repo);
  const record = async (entry: Decision | Run) => { if (!options.dryRun) await appendLedger(directory, repo, entry); };
  const decision = (action: Decision["action"], reason: string, judge: Decision["judge"], fields: Partial<Decision> = {}): Decision => ({
    kind: "decision", id: newId(), at: now().toISOString(), action, reason, judge, worthwhile: null, scope: null, stale: [],
    signals: { changedFiles: 0, newActivityBytes: 0, minutesSinceBrief: null }, jevUsage: null, quickKey: null, session: options.session, ...fields,
  });
  // A pass is bounded by the writer timeout plus collection, rechecks and up to three Jev requests.
  const lock = options.dryRun ? null : await acquire(directory, repo, options.config.timeoutSeconds * 1000 + 5 * 60_000);
  if (!options.dryRun && lock === null) {
    await record(decision("coalesced", "another automatic brief is running for this checkout; it will re-check", "deterministic"));
    return { action: "coalesced", reason: "another automatic brief is running for this checkout" };
  }
  let outcome: AutoOutcome = { action: "skip", reason: "not evaluated" };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      await lock?.refresh();
      const result = await evaluate(options, repo, directory, now, record, decision, pass > 0);
      // Report the pass that did something: a re-check that finds nothing new does not hide a written brief.
      if (pass === 0 || result.action !== "skip") outcome = result;
      // After the last pass, a marker from a later trigger stays for the next run to honor.
      if (lock === null || pass === 1 || !(await lock.release())) break;
      options.log("Changes arrived during the run; re-checking once…");
    }
  } finally {
    if (!options.dryRun) {
      await lock?.unlock();
      const tuning = await readTuning(directory, repo);
      const next = calibrate(tuning, await readLedger(directory, repo), now());
      if (next !== tuning) await saveTuning(directory, repo, next);
    }
  }
  return outcome;
}

/** recheck: a trigger arrived during the previous pass, so its change must not wait out the debounce. */
async function evaluate(options: AutoOptions, repo: string, directory: string, now: () => Date, record: (entry: Decision | Run) => Promise<void>, decision: (action: Decision["action"], reason: string, judge: Decision["judge"], fields?: Partial<Decision>) => Decision, recheck: boolean): Promise<AutoOutcome> {
  const state = await readAutoState(directory, repo);
  const key = await quickKey(repo);
  const sizes = Object.fromEntries(await Promise.all(options.logs.map(async (file) => [path.resolve(file), (await stat(file).catch(() => null))?.size ?? 0] as const)));
  const grown = (since: Record<string, number>) => Object.entries(sizes).reduce((total, [file, size]) => total + Math.max(0, size - (since[file] ?? 0)), 0);
  // The cheap skip asks "anything new since the last check?"; the gate weighs everything since the last brief,
  // so activity from skipped turns accumulates the way file changes do.
  const newActivityBytes = grown(state.activity);
  const remember = async (briefed = false) => {
    if (!options.dryRun) await saveAutoState(directory, repo, { quickKey: key, activity: { ...state.activity, ...sizes }, briefActivity: briefed ? { ...state.briefActivity, ...sizes } : state.briefActivity });
  };
  const checkpoint = await readCheckpoint(directory, repo);
  const tuning = await readTuning(directory, repo);
  // Timing skips leave the state unseen so the next trigger re-evaluates the same change.
  const skip = async (reason: string, judge: Decision["judge"], fields: Partial<Decision> = {}, seen = true): Promise<AutoOutcome> => {
    await record(decision("skip", reason, judge, { quickKey: key, ...fields }));
    if (seen) await remember();
    return { action: "skip", reason };
  };
  // Unseen, so small turns add up across checks instead of each resetting the baseline.
  if (checkpoint && state.quickKey === key && newActivityBytes < MIN_ACTIVITY_BYTES) return skip("no source or activity change since the last check", "deterministic", {}, false);
  // Back off after a failed run so an unavailable provider is not retried at every agent stop.
  // Provider failures back off. A checkout that moved mid-run is retried on the immediate re-check and
  // once more, then backs off too, so an agent that keeps editing does not pay for a doomed run per stop.
  const runs = (await readLedger(directory, repo, 50)).filter((entry): entry is Run => entry.kind === "run");
  const failed = runs.at(-1);
  const moved = (entry: Run | undefined) => entry !== undefined && !entry.ok && /changed during/.test(entry.error ?? "");
  const backOff = failed !== undefined && !failed.ok && (moved(failed) ? !recheck && moved(runs.at(-2)) : true);
  if (failed && backOff && now().getTime() - Date.parse(failed.at) < tuning.debounceMinutes * 60_000) {
    return skip(`the previous automatic brief failed under ${tuning.debounceMinutes} minutes ago`, "deterministic", {}, false);
  }

  const base = await resolveBase(repo, options.config.base);
  const context = await collectRepository({ repo, base, logs: options.logs, activityTail: true });
  const activitySinceBrief = grown(state.briefActivity);
  const signals = gateSignals(context, checkpoint, activitySinceBrief, now());
  const counts = { changedFiles: signals.changedSinceBrief.length + signals.removedSinceBrief.length, newActivityBytes: activitySinceBrief, minutesSinceBrief: signals.minutesSinceBrief };
  if (!checkpoint && context.changed.length === 0 && activitySinceBrief < MIN_ACTIVITY_BYTES) return skip("no changes or agent activity to brief yet", "deterministic", { signals: counts });
  if (checkpoint && counts.changedFiles === 0 && activitySinceBrief < MIN_ACTIVITY_BYTES) return skip("source matches the last brief", "deterministic", { signals: counts });
  if (!recheck && checkpoint && (signals.minutesSinceBrief ?? Infinity) < tuning.debounceMinutes && counts.changedFiles < 5 * tuning.minFiles) {
    return skip(`last brief is under ${tuning.debounceMinutes} minutes old`, "deterministic", { signals: counts }, false);
  }

  if (options.judge && checkpoint) signals.changes = await changesSinceBrief(repo, checkpoint, await readSnapshot(directory, repo), signals.changedSinceBrief, signals.removedSinceBrief);
  let judgment: GateJudgment;
  try { judgment = options.judge ? await jevGate(options.judge, signals) : heuristicGate(signals, tuning.minFiles); }
  catch (error) { judgment = { ...heuristicGate(signals, tuning.minFiles), error: error instanceof Error ? clean(error.message) : "Jev was unavailable" }; }
  const judged = { worthwhile: judgment.worthwhile, scope: judgment.scope, stale: judgment.stale, jevUsage: judgment.usage, signals: counts };
  if (judgment.scope === "skip" || judgment.worthwhile < tuning.gateThreshold) {
    const outcome = await skip(`${judgment.judge} judged a refresh not worthwhile (${judgment.worthwhile.toFixed(2)} < ${tuning.gateThreshold})`, judgment.judge, judged);
    return { ...outcome, judgment };
  }
  if (options.dryRun) return { action: "run", reason: `would run a ${judgment.scope} brief for ${judgment.stale.join(", ")}`, judgment };

  const update = judgment.scope === "update" && checkpoint !== null && judgment.stale.length > 0;
  const stale = update ? SECTIONS.filter((section) => judgment.stale.includes(section) || unstableSections(checkpoint.brief, checkpoint.fileHashes, context).includes(section)) : [...SECTIONS];
  const chosen = decision("run", `${judgment.judge} judged ${judgment.scope === "update" ? "an" : "a"} ${judgment.scope} refresh worthwhile (${judgment.worthwhile.toFixed(2)})`, judgment.judge, { quickKey: key, ...judged, stale });
  await record(chosen);
  const prompt = buildPrompt(context, undefined, previousContext(checkpoint, context),
    update ? { previous: checkpoint.brief, stale, changedSinceBrief: signals.changedSinceBrief, evidence: checkpoint.evidence } : undefined);
  const started = Date.now();
  const abort = new AbortController();
  // Stop the writer as soon as the checkout moves; its brief would fail the freshness check anyway.
  let movedEarly = false;
  const watcher = setInterval(() => {
    void quickKey(repo).then((current) => { if (current !== key && !abort.signal.aborted) { movedEarly = true; abort.abort(); } }, () => {});
  }, options.watchMs ?? 15_000);
  const run = (fields: Partial<Run>): Run => ({
    kind: "run", id: newId(), at: now().toISOString(), trigger: "auto", decision: chosen.id, ok: false, error: null, writer: null, model: null,
    attempts: 0, writerUsage: null, jevUsage: judgment.usage, churn: null, weakClaims: 0, removedClaims: 0, unsupportedAtDefault: 0, removed: [], elapsedMs: Date.now() - started, ...fields,
  });
  try {
    const result = await generateBrief({
      context, prompt, writers: options.writers, deadline: started + options.config.timeoutSeconds * 1000, signal: abort.signal,
      judge: options.judge, verifyThreshold: tuning.verifyThreshold, carry: update ? { previous: checkpoint.brief, stale } : undefined, log: options.log,
    });
    await saveCheckpoint(directory, context, result.brief, renderBrief(result.brief, context));
    await saveSnapshot(directory, context);
    const total = judgment.usage && result.jevUsage ? { input: judgment.usage.input + result.jevUsage.input, output: judgment.usage.output + result.jevUsage.output } : judgment.usage ?? result.jevUsage;
    await record(run({ ok: true, writer: result.writer, model: result.model, attempts: result.attempts, writerUsage: result.writerUsage, jevUsage: total, churn: churn(checkpoint?.brief ?? null, result.brief, update ? stale : undefined), weakClaims: result.weakClaims, removedClaims: result.removedClaims, unsupportedAtDefault: result.unsupportedAtDefault, removed: result.removed }));
    await remember(true);
    return { action: "run", reason: `${judgment.scope} brief written by ${result.writer}`, judgment, briefPath: renderedPath(directory, repo) };
  } catch (error) {
    const message = movedEarly ? "Source changed during review; the writer was stopped early and no checkpoint was saved."
      : error instanceof Error && error.name !== "ZodError" ? clean(error.message) : "the generated brief did not satisfy the report contract";
    await record(run({ error: message.slice(0, 500) }));
    return { action: "failed", reason: message, judgment };
  } finally {
    clearInterval(watcher);
  }
}
