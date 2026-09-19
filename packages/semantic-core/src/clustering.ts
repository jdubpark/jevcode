import type {
  ChangeUnit,
  Decision,
  DependencyChange,
  EvidenceFact,
  InterfaceChange,
  NormalizedAgentEvent,
  SemanticEvent,
  SemanticEventKind,
  SymbolInfo,
  SymbolRef,
  SymbolKind,
  ValidationResult,
} from "@jevcode/contracts";

import { symbolId } from "@jevcode/contracts";
import { deterministicCategory, isTestPath } from "./categories.js";
import { hashId } from "./ids.js";
import type { FailureRecord } from "./persistence.js";
import { extractTestResult } from "./validation.js";

export interface SequencedFact {
  fact: EvidenceFact;
  factId: string;
  seq: number;
  batchId: number;
}

export interface FileEdge {
  from: string;
  to: string;
  weight: number;
}

export interface SessionInput {
  sessionId: string;
  taskPrompt?: string;
  facts: readonly SequencedFact[];
  agentEvents: readonly NormalizedAgentEvent[];
  semanticEvents: readonly SemanticEvent[];
  decisions: readonly Decision[];
  revertMarkers?: readonly string[];
  supersedeMarkers?: readonly string[];
  idleGapMs?: number;
}

export interface SemanticProjection {
  sessionId: string;
  units: ChangeUnit[];
  validations: ValidationResult[];
  failures: FailureRecord[];
  unitEvidenceFacts: Map<string, SequencedFact[]>;
  eventChangeUnitIds: Map<string, string>;
  decisionChangeUnitIds: Map<string, string[]>;
  importEdges: FileEdge[];
  packageImports: { file: string; packageName: string }[];
  fileKinds: Map<string, "added" | "modified" | "deleted">;
}

interface UnitDraft {
  id: string;
  sessionId: string;
  files: string[];
  fileSet: Set<string>;
  fileKinds: Map<string, "added" | "modified" | "deleted">;
  symbols: Map<string, { ref: SymbolRef; state: "added" | "modified" }>;
  symbolOrder: string[];
  eventKinds: SemanticEventKind[];
  eventIds: string[];
  evidence: string[];
  evidenceSet: Set<string>;
  depChanges: DependencyChange[];
  firstTsMs: number | null;
  lastTsMs: number | null;
  formattingOnly: boolean;
  hasRealChange: boolean;
  createdByFailure: boolean;
}

const IMPORT_SOURCE_RE = /(?:from\s+|require\s*\()\s*["']([^"']+)["']/;
const RELATIVE_SPECIFIER_RE = /^\.{1,2}\//;
const RESOLVED_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js"];

function tsMs(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createDraft(sessionId: string, id: string, firstTsMs: number | null): UnitDraft {
  return {
    id,
    sessionId,
    files: [],
    fileSet: new Set(),
    fileKinds: new Map(),
    symbols: new Map(),
    symbolOrder: [],
    eventKinds: [],
    eventIds: [],
    evidence: [],
    evidenceSet: new Set(),
    depChanges: [],
    firstTsMs,
    lastTsMs: firstTsMs,
    formattingOnly: true,
    hasRealChange: false,
    createdByFailure: false,
  };
}

function addFile(draft: UnitDraft, file: string, kind?: "added" | "modified" | "deleted"): void {
  if (!draft.fileSet.has(file)) {
    draft.fileSet.add(file);
    draft.files.push(file);
  }
  if (kind !== undefined) draft.fileKinds.set(file, kind);
}

function addEvidence(draft: UnitDraft, id: string): void {
  if (!draft.evidenceSet.has(id)) {
    draft.evidenceSet.add(id);
    draft.evidence.push(id);
  }
}

function touch(draft: UnitDraft, ts: string): void {
  const ms = tsMs(ts);
  if (draft.firstTsMs === null || ms < draft.firstTsMs) draft.firstTsMs = ms;
  if (draft.lastTsMs === null || ms > draft.lastTsMs) draft.lastTsMs = ms;
}

function addSymbol(draft: UnitDraft, symbol: SymbolInfo, path: string, state: "added" | "modified"): void {
  if (draft.symbols.has(symbol.name)) return;
  draft.symbols.set(symbol.name, {
    ref: {
      id: symbolId(path, symbol.name, symbol.kind, symbol.signature),
      name: symbol.name,
      path,
      kind: symbol.kind,
    },
    state,
  });
  draft.symbolOrder.push(symbol.name);
}

function addEventSymbols(draft: UnitDraft, names: readonly string[], fallbackPath: string): void {
  for (const name of names) {
    if (draft.symbols.has(name)) continue;
    const path = fallbackPath !== "" ? fallbackPath : draft.files[0] ?? "";
    const kind: SymbolKind = "function";
    draft.symbols.set(name, {
      ref: { id: hashId("sym", draft.sessionId, name), name, path, kind },
      state: "added",
    });
    draft.symbolOrder.push(name);
  }
}

function extractImportSpecifier(signature: string): string | null {
  const match = IMPORT_SOURCE_RE.exec(signature);
  const specifier = match?.[1];
  if (specifier === undefined || specifier === "") return null;
  return specifier;
}

function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!RELATIVE_SPECIFIER_RE.test(specifier)) return null;
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const joined = dir === "" ? specifier : `${dir}/${specifier}`;
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function matchesFile(candidate: string, fileSet: ReadonlySet<string>): string | null {
  for (const extension of RESOLVED_EXTENSIONS) {
    const resolved = `${candidate}${extension}`;
    if (fileSet.has(resolved)) return resolved;
  }
  return null;
}

function factFiles(fact: EvidenceFact): string[] {
  switch (fact.type) {
    case "git_hunk":
      return [fact.file];
    case "file_changed":
      return [fact.path];
    case "symbol_delta":
      return [fact.path];
    case "dependency_change":
      return [fact.manifest];
    case "revert_detected":
      return [...fact.files];
    case "test_result":
    case "command_executed":
      return [];
  }
}

function collectImportEdges(
  fact: EvidenceFact,
  fileSet: ReadonlySet<string>,
  edges: FileEdge[],
  packageImports: { file: string; packageName: string }[],
): void {
  if (fact.type !== "symbol_delta") return;
  for (const symbol of [...fact.added, ...fact.modified]) {
    if (symbol.kind !== "import" && symbol.kind !== "export") continue;
    const specifier = extractImportSpecifier(symbol.signature);
    if (specifier === null) continue;
    const resolved = resolveRelativeSpecifier(fact.path, specifier);
    if (resolved !== null) {
      const target = matchesFile(resolved, fileSet);
      if (target !== null && target !== fact.path) {
        edges.push({ from: fact.path, to: target, weight: 0.8 });
      }
      continue;
    }
    packageImports.push({ file: fact.path, packageName: specifier });
  }
}

export function buildPlaceholderTitle(files: readonly string[]): string {
  if (files.length === 0) return "Changed 0 files";
  const top = files.slice(0, 3).join(", ");
  const noun = files.length === 1 ? "file" : "files";
  return `Changed ${files.length} ${noun}: ${top}`;
}

export function clusterSession(input: SessionInput): SemanticProjection {
  const { sessionId } = input;
  const idleGapMs = input.idleGapMs ?? 120_000;
  const revertMarkers = new Set(input.revertMarkers ?? []);
  const supersedeMarkers = new Set(input.supersedeMarkers ?? []);

  const facts = [...input.facts].sort(
    (a, b) => tsMs(a.fact.ts) - tsMs(b.fact.ts) || a.seq - b.seq,
  );
  const events = [...input.semanticEvents].sort(
    (a, b) => tsMs(a.createdAt) - tsMs(b.createdAt),
  );

  const fileSet = new Set<string>();
  for (const entry of facts) {
    for (const file of factFiles(entry.fact)) fileSet.add(file);
  }

  const formattingOnlyFiles = new Set<string>();
  {
    const hunkStates = new Map<string, boolean>();
    const hasSymbolDelta = new Set<string>();
    for (const entry of facts) {
      if (entry.fact.type === "git_hunk") {
        const current = hunkStates.get(entry.fact.file);
        if (current === undefined) {
          hunkStates.set(entry.fact.file, entry.fact.isFormattingOnly);
        } else {
          hunkStates.set(entry.fact.file, current && entry.fact.isFormattingOnly);
        }
      }
      if (entry.fact.type === "symbol_delta") hasSymbolDelta.add(entry.fact.path);
    }
    for (const [file, allFormatting] of hunkStates) {
      if (allFormatting && !hasSymbolDelta.has(file)) formattingOnlyFiles.add(file);
    }
  }

  const importEdges: FileEdge[] = [];
  const packageImports: { file: string; packageName: string }[] = [];
  for (const entry of facts) {
    collectImportEdges(entry.fact, fileSet, importEdges, packageImports);
  }

  const batchHunkFiles = new Map<number, Set<string>>();
  const batchChangedFiles = new Map<number, Set<string>>();
  for (const entry of facts) {
    for (const file of factFiles(entry.fact)) {
      let changed = batchChangedFiles.get(entry.batchId);
      if (changed === undefined) {
        changed = new Set();
        batchChangedFiles.set(entry.batchId, changed);
      }
      changed.add(file);
      if (entry.fact.type === "git_hunk") {
        let hunks = batchHunkFiles.get(entry.batchId);
        if (hunks === undefined) {
          hunks = new Set();
          batchHunkFiles.set(entry.batchId, hunks);
        }
        hunks.add(file);
      }
    }
  }

  const fileKinds = new Map<string, "added" | "modified" | "deleted">();
  for (const entry of facts) {
    if (entry.fact.type === "file_changed") fileKinds.set(entry.fact.path, entry.fact.kind);
  }

  const edgeWeight = (a: string, b: string): number => {
    let weight = 0;
    for (const edge of importEdges) {
      if ((edge.from === a && edge.to === b) || (edge.from === b && edge.to === a)) {
        weight = Math.max(weight, edge.weight);
      }
    }
    for (const batchId of batchChangedFiles.keys()) {
      const changed = batchChangedFiles.get(batchId);
      if (changed === undefined || !changed.has(a) || !changed.has(b)) continue;
      const hunks = batchHunkFiles.get(batchId);
      if (hunks !== undefined && hunks.has(a) && hunks.has(b)) {
        weight = Math.max(weight, 1);
      } else {
        weight = Math.max(weight, 0.5);
      }
    }
    return weight;
  };

  const bucketIndexByFact = new Map<number, number>();
  const buckets: { facts: SequencedFact[]; events: SemanticEvent[] }[] = [];
  let currentBucket = 0;
  for (const entry of facts) {
    if (buckets[currentBucket] === undefined) {
      buckets[currentBucket] = { facts: [], events: [] };
    }
    const bucket = buckets[currentBucket];
    if (bucket !== undefined && bucket.facts.length > 0) {
      const previous = bucket.facts[bucket.facts.length - 1];
      if (previous !== undefined && tsMs(entry.fact.ts) - tsMs(previous.fact.ts) > idleGapMs) {
        currentBucket += 1;
        if (buckets[currentBucket] === undefined) {
          buckets[currentBucket] = { facts: [], events: [] };
        }
      }
    }
    const target = buckets[currentBucket];
    if (target !== undefined) {
      target.facts.push(entry);
      bucketIndexByFact.set(entry.seq, currentBucket);
    }
  }

  const bucketForTs = (ts: string): number => {
    const ms = tsMs(ts);
    let best = 0;
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];
      const first = bucket?.facts[0];
      if (first !== undefined && tsMs(first.fact.ts) <= ms) best = i;
    }
    return best;
  };

  const seenEventIds = new Set<string>();
  for (const event of events) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    const index = bucketForTs(event.createdAt);
    const bucket = buckets[index] ?? { facts: [], events: [] };
    bucket.events.push(event);
    buckets[index] = bucket;
  }

  // SPEC §6.1.2-6.1.3: per-bucket connected components over files (edges >= 0.5).
  // Test paths and formatting-only files are carved out after this step.
  const componentIdByFile = new Map<string, string>();
  {
    const bucketFiles = new Map<number, string[]>();
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      if (bucket === undefined) continue;
      const files: string[] = [];
      const seen = new Set<string>();
      for (const entry of bucket.facts) {
        for (const file of factFiles(entry.fact)) {
          if (seen.has(file)) continue;
          seen.add(file);
          if (isTestPath(file) || formattingOnlyFiles.has(file)) continue;
          files.push(file);
        }
      }
      bucketFiles.set(index, files);
    }
    for (const [bucketIndex, files] of bucketFiles) {
      if (files.length === 0) continue;
      const parent = new Map<string, string>();
      for (const file of files) parent.set(file, file);
      const find = (x: string): string => {
        let root = x;
        while (parent.get(root) !== root) root = parent.get(root) ?? x;
        let current = x;
        while (parent.get(current) !== root) {
          const next = parent.get(current) ?? root;
          parent.set(current, root);
          current = next;
        }
        return root;
      };
      const union = (a: string, b: string): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(rb, ra);
      };
      const inBucket = new Set(files);
      for (const edge of importEdges) {
        if (edge.weight >= 0.5 && inBucket.has(edge.from) && inBucket.has(edge.to)) {
          union(edge.from, edge.to);
        }
      }
      for (const batchId of batchChangedFiles.keys()) {
        const changed = batchChangedFiles.get(batchId);
        if (changed === undefined) continue;
        let first: string | null = null;
        for (const file of files) {
          if (!changed.has(file)) continue;
          if (first === null) {
            first = file;
          } else {
            union(first, file);
          }
        }
      }
      const byRoot = new Map<string, string[]>();
      for (const file of files) {
        const root = find(file);
        const list = byRoot.get(root) ?? [];
        list.push(file);
        byRoot.set(root, list);
      }
      for (const list of byRoot.values()) {
        const sorted = [...list].sort();
        const componentId = hashId("cu", sessionId, "b", String(bucketIndex), "cc", sorted.join("\u0001"));
        for (const file of sorted) componentIdByFile.set(file, componentId);
      }
    }
  }

  const drafts = new Map<string, UnitDraft>();
  const unitsInOrder: string[] = [];
  const completedUnitIds = new Set<string>();
  const unitEvidenceFacts = new Map<string, SequencedFact[]>();
  const eventChangeUnitIds = new Map<string, string>();
  const decisionChangeUnitIds = new Map<string, string[]>();
  const validations: ValidationResult[] = [];
  const failures: FailureRecord[] = [];
  const validationHostUnits = new Map<string, string[]>();
  const validationBuckets = new Map<string, number>();

  const trackDraft = (draft: UnitDraft): void => {
    if (!drafts.has(draft.id)) {
      drafts.set(draft.id, draft);
      unitsInOrder.push(draft.id);
    }
  };

  const dropDraft = (id: string): void => {
    drafts.delete(id);
    const orderIndex = unitsInOrder.indexOf(id);
    if (orderIndex >= 0) unitsInOrder.splice(orderIndex, 1);
  };

  const mainDraftFor = (bucketIndex: number): UnitDraft => {
    const id = hashId("cu", sessionId, "b", String(bucketIndex), "main");
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = createDraft(sessionId, id, null);
      trackDraft(draft);
    }
    return draft;
  };

  const testDraftFor = (bucketIndex: number): UnitDraft => {
    const id = hashId("cu", sessionId, "b", String(bucketIndex), "test");
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = createDraft(sessionId, id, null);
      trackDraft(draft);
    }
    return draft;
  };

  const formattingDraftFor = (bucketIndex: number, file: string, create = true): UnitDraft | null => {
    const id = hashId("cu", sessionId, "b", String(bucketIndex), "fmt", file);
    const existing = drafts.get(id);
    if (existing !== undefined) return existing;
    if (!create) return null;
    const draft = createDraft(sessionId, id, null);
    trackDraft(draft);
    return draft;
  };

  const componentDrafts = new Map<string, UnitDraft>();
  const componentDraftFor = (componentId: string): UnitDraft => {
    let draft = componentDrafts.get(componentId);
    if (draft === undefined) {
      draft = createDraft(sessionId, componentId, null);
      componentDrafts.set(componentId, draft);
      trackDraft(draft);
    }
    return draft;
  };

  const commandDraftFor = (bucketIndex: number): UnitDraft => {
    const id = hashId("cu", sessionId, "b", String(bucketIndex), "cmd");
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = createDraft(sessionId, id, null);
      trackDraft(draft);
    }
    return draft;
  };

  const fileOwners = new Map<string, UnitDraft>();

  const mostConnectedUnit = (file: string): UnitDraft | null => {
    let best: UnitDraft | null = null;
    let bestCount = 0;
    let bestWeight = 0;
    for (const id of unitsInOrder) {
      const draft = drafts.get(id);
      if (draft === undefined || !completedUnitIds.has(id) || draft.createdByFailure) continue;
      let count = 0;
      let weight = 0;
      for (const unitFile of draft.fileSet) {
        const edge = edgeWeight(file, unitFile);
        if (edge > 0) {
          count += 1;
          weight += edge;
        }
      }
      if (count >= 1 && (count > bestCount || (count === bestCount && weight > bestWeight))) {
        best = draft;
        bestCount = count;
        bestWeight = weight;
      }
    }
    return best;
  };

  const factUnitDraft = (entry: SequencedFact): UnitDraft => {
    const file = factFiles(entry.fact)[0] ?? "";
    const index = bucketIndexByFact.get(entry.seq) ?? 0;
    const kindOf = fileKinds.get(file) ?? "modified";
    const owned = fileOwners.get(file);
    if (owned !== undefined) {
      touch(owned, entry.fact.ts);
      return owned;
    }
    if (formattingOnlyFiles.has(file)) {
      const test = testDraftFor(index);
      if (test.fileSet.has(file)) {
        fileOwners.set(file, test);
        touch(test, entry.fact.ts);
        return test;
      }
      const formatting = formattingDraftFor(index, file);
      if (formatting !== null) {
        addFile(formatting, file, kindOf);
        fileOwners.set(file, formatting);
        touch(formatting, entry.fact.ts);
        return formatting;
      }
      const main = mainDraftFor(index);
      addFile(main, file, kindOf);
      fileOwners.set(file, main);
      touch(main, entry.fact.ts);
      return main;
    }
    if (isTestPath(file)) {
      const test = testDraftFor(index);
      addFile(test, file, kindOf);
      fileOwners.set(file, test);
      touch(test, entry.fact.ts);
      return test;
    }
    const existing = mostConnectedUnit(file);
    if (existing !== null) {
      addFile(existing, file, kindOf);
      fileOwners.set(file, existing);
      touch(existing, entry.fact.ts);
      return existing;
    }
    const componentId = componentIdByFile.get(file);
    if (componentId !== undefined) {
      const draft = componentDraftFor(componentId);
      addFile(draft, file, kindOf);
      fileOwners.set(file, draft);
      touch(draft, entry.fact.ts);
      return draft;
    }
    const main = mainDraftFor(index);
    addFile(main, file, kindOf);
    fileOwners.set(file, main);
    touch(main, entry.fact.ts);
    return main;
  };

  const bucketCommands = new Map<number, SequencedFact[]>();
  const revertFacts: SequencedFact[] = [];
  const validationFacts = new Map<string, SequencedFact>();

  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    const earlierUnits = new Set(completedUnitIds);
    const bucketStartOrder = unitsInOrder.length;

    for (const entry of bucket.facts) {
      const fact = entry.fact;
      if (fact.type === "revert_detected") {
        for (const file of fact.files) revertMarkers.add(file);
        revertFacts.push(entry);
        continue;
      }
      if (fact.type === "test_result") {
        const { validation, failures: extracted } = extractTestResult(fact, sessionId);
        validations.push(validation);
        failures.push(...extracted);
        validationBuckets.set(validation.id, index);
        validationFacts.set(validation.id, entry);
        continue;
      }
      if (fact.type === "command_executed") {
        const commands = bucketCommands.get(index) ?? [];
        commands.push(entry);
        bucketCommands.set(index, commands);
        continue;
      }
      const draft = factUnitDraft(entry);
      if (entry.fact.type !== "git_hunk" || !entry.fact.isFormattingOnly) {
        draft.hasRealChange = true;
        draft.formattingOnly = false;
      }
      addEvidence(draft, entry.factId);
      if (entry.fact.type === "symbol_delta") {
        for (const symbol of entry.fact.added) addSymbol(draft, symbol, entry.fact.path, "added");
        for (const symbol of entry.fact.modified) addSymbol(draft, symbol, entry.fact.path, "modified");
      }
      if (entry.fact.type === "dependency_change") {
        for (const added of entry.fact.added) {
          draft.depChanges.push({ name: added.name, version: added.version, change: "added", manifest: entry.fact.manifest });
        }
        for (const removed of entry.fact.removed) {
          draft.depChanges.push({ name: removed.name, version: removed.version, change: "removed", manifest: entry.fact.manifest });
        }
      }
      const unitFacts = unitEvidenceFacts.get(draft.id) ?? [];
      unitFacts.push(entry);
      unitEvidenceFacts.set(draft.id, unitFacts);
    }

    for (const event of bucket.events) {
      if (event.kind === "decision_candidate") {
        const id = hashId("cu", sessionId, "event", event.id);
        let draft = drafts.get(id);
        if (draft === undefined) {
          draft = createDraft(sessionId, id, tsMs(event.createdAt));
          draft.eventKinds.push(event.kind);
          trackDraft(draft);
        }
        for (const file of event.files) {
          addFile(draft, file);
          touch(draft, event.createdAt);
        }
        addEventSymbols(draft, event.symbols, event.files[0] ?? "");
        addEvidence(draft, event.id);
        draft.hasRealChange = true;
        draft.formattingOnly = false;
        eventChangeUnitIds.set(event.id, draft.id);
        continue;
      }
      const firstFile = event.files[0];
      const owner = firstFile !== undefined ? fileOwners.get(firstFile) : undefined;
      const main = owner ?? mainDraftFor(index);
      for (const file of event.files) {
        if (fileOwners.has(file)) continue;
        addFile(main, file);
        fileOwners.set(file, main);
        touch(main, event.createdAt);
      }
      addEventSymbols(main, event.symbols, event.files[0] ?? "");
      addEvidence(main, event.id);
      main.eventIds.push(event.id);
      main.eventKinds.push(event.kind);
      main.hasRealChange = true;
      main.formattingOnly = false;
      eventChangeUnitIds.set(event.id, main.id);
    }

    // SPEC §6.1.3: a bucket with no file facts still yields a 1-fact command unit.
    const commands = bucketCommands.get(index) ?? [];
    if (commands.length > 0) {
      let primary: UnitDraft | null = null;
      for (const id of unitsInOrder.slice(bucketStartOrder)) {
        const candidate = drafts.get(id);
        if (candidate !== undefined && !candidate.createdByFailure) {
          primary = candidate;
          break;
        }
      }
      const host = primary ?? commandDraftFor(index);
      for (const entry of commands) {
        addEvidence(host, entry.factId);
        host.hasRealChange = true;
        host.formattingOnly = false;
        touch(host, entry.fact.ts);
        const unitFacts = unitEvidenceFacts.get(host.id) ?? [];
        unitFacts.push(entry);
        unitEvidenceFacts.set(host.id, unitFacts);
      }
    }

    for (const id of unitsInOrder) {
      if (!completedUnitIds.has(id)) completedUnitIds.add(id);
    }

    const bucketUnitIds = unitsInOrder.slice(bucketStartOrder);
    for (const clusterId of bucketUnitIds) {
      const cluster = drafts.get(clusterId);
      if (cluster === undefined) continue;
      let best: UnitDraft | null = null;
      let bestConnections = 0;
      for (const candidateId of earlierUnits) {
        if (candidateId === clusterId) continue;
        const candidate = drafts.get(candidateId);
        if (candidate === undefined || candidate.createdByFailure) continue;
        let connections = 0;
        for (const file of cluster.fileSet) {
          for (const candidateFile of candidate.fileSet) {
            if (edgeWeight(file, candidateFile) >= 0.5) {
              connections += 1;
              break;
            }
          }
        }
        if (connections > bestConnections) {
          best = candidate;
          bestConnections = connections;
        }
      }
      if (best !== null && cluster.fileSet.size > 0 && bestConnections / cluster.fileSet.size > 0.5) {
        mergeInto(best, cluster);
      }
    }
  }

  const seenDecisionIds = new Set<string>();
  for (const decision of input.decisions) {
    if (seenDecisionIds.has(decision.id)) continue;
    seenDecisionIds.add(decision.id);
    const linked: string[] = [];
    for (const ref of decision.evidence) {
      const unitId = eventChangeUnitIds.get(ref);
      if (unitId !== undefined && !linked.includes(unitId)) linked.push(unitId);
    }
    if (linked.length > 0) decisionChangeUnitIds.set(decision.id, linked);
  }

  const bucketFilesByIndex = new Map<number, Set<string>>();
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket === undefined) continue;
    const files = new Set<string>();
    for (const entry of bucket.facts) {
      for (const file of factFiles(entry.fact)) files.add(file);
    }
    bucketFilesByIndex.set(index, files);
  }

  for (const [validationId, bucketIndex] of validationBuckets) {
    const bucketFiles = bucketFilesByIndex.get(bucketIndex) ?? new Set<string>();
    const hosts: string[] = [];
    for (const id of unitsInOrder) {
      const draft = drafts.get(id);
      if (draft === undefined || draft.createdByFailure) continue;
      for (const file of draft.fileSet) {
        if (bucketFiles.has(file)) {
          hosts.push(id);
          break;
        }
      }
    }
    for (const hostId of hosts) {
      const draft = drafts.get(hostId);
      if (draft === undefined) continue;
      addEvidence(draft, validationId);
      const entry = validationFacts.get(validationId);
      if (entry !== undefined) {
        addEvidence(draft, entry.factId);
        const unitFacts = unitEvidenceFacts.get(hostId) ?? [];
        unitFacts.push(entry);
        unitEvidenceFacts.set(hostId, unitFacts);
      }
    }
    validationHostUnits.set(validationId, hosts);
  }

  for (const entry of revertFacts) {
    const files = entry.fact.type === "revert_detected" ? new Set(entry.fact.files) : new Set<string>();
    for (const id of unitsInOrder) {
      const draft = drafts.get(id);
      if (draft === undefined || draft.createdByFailure) continue;
      let touches = false;
      for (const file of draft.fileSet) {
        if (files.has(file)) {
          touches = true;
          break;
        }
      }
      if (!touches) continue;
      addEvidence(draft, entry.factId);
      const unitFacts = unitEvidenceFacts.get(draft.id) ?? [];
      unitFacts.push(entry);
      unitEvidenceFacts.set(draft.id, unitFacts);
    }
  }

  const fileHasFacts = new Set<string>();
  for (const entry of facts) {
    for (const file of factFiles(entry.fact)) fileHasFacts.add(file);
  }

  const failureHosts = new Map<string, string[]>();
  for (const failure of failures) {
    const hosts: string[] = [];
    for (const id of unitsInOrder) {
      const draft = drafts.get(id);
      if (draft === undefined) continue;
      if (draft.fileSet.has(failure.file)) {
        hosts.push(draft.id);
        continue;
      }
      for (const symbol of draft.symbols.keys()) {
        if (failure.testName.includes(symbol)) {
          hosts.push(draft.id);
          break;
        }
      }
    }
    if (hosts.length === 0 || !fileHasFacts.has(failure.file)) {
      const id = hashId("cu", sessionId, "fail", failure.file);
      const draft = createDraft(sessionId, id, tsMs(failure.ts));
      addFile(draft, failure.file);
      addEvidence(draft, failure.validationId);
      draft.createdByFailure = true;
      draft.hasRealChange = true;
      draft.formattingOnly = false;
      trackDraft(draft);
      hosts.push(id);
    }
    failureHosts.set(failure.id, [...new Set(hosts)]);
  }

  const units: ChangeUnit[] = [];
  for (const id of unitsInOrder) {
    const draft = drafts.get(id);
    if (draft === undefined) continue;
    if (draft.files.length === 0 && draft.evidence.length === 0) continue;
    const attachedFailures = failures.filter((failure) => {
      const hosts = failureHosts.get(failure.id) ?? [];
      return hosts.includes(draft.id);
    });
    const attachedValidations = new Set<string>();
    for (const [validationId, bucketUnits] of validationHostUnits) {
      if (bucketUnits.includes(draft.id)) attachedValidations.add(validationId);
    }
    for (const failure of attachedFailures) attachedValidations.add(failure.validationId);
    let status: ChangeUnit["status"] = "detected";
    const filesSuperseded = draft.files.some((file) => supersedeMarkers.has(file));
    const filesReverted = draft.files.some((file) => revertMarkers.has(file));
    if (filesSuperseded) {
      status = "superseded";
    } else if (filesReverted) {
      status = "reverted";
    } else if (attachedFailures.length > 0) {
      status = "failed";
    } else if (attachedValidations.size > 0) {
      status = "validated";
    }
    const interfacesChanged: InterfaceChange[] = [];
    for (const name of draft.symbolOrder) {
      const symbol = draft.symbols.get(name);
      if (symbol === undefined) continue;
      const kind = symbol.ref.kind;
      if (kind !== "function" && kind !== "class" && kind !== "method" && kind !== "interface" && kind !== "type") {
        continue;
      }
      interfacesChanged.push({
        name: symbol.ref.name,
        path: symbol.ref.path,
        change: symbol.state === "modified" ? "modified" : "added",
      });
    }
    const symbols: SymbolRef[] = draft.symbolOrder
      .map((name) => draft.symbols.get(name)?.ref)
      .filter((ref): ref is SymbolRef => ref !== undefined);
    const relatedDecisions: string[] = [];
    for (const [decisionId, unitIds] of decisionChangeUnitIds) {
      if (unitIds.includes(draft.id)) relatedDecisions.push(decisionId);
    }
    const createdAt = draft.firstTsMs !== null ? new Date(draft.firstTsMs).toISOString() : new Date(0).toISOString();
    const updatedAt = draft.lastTsMs !== null ? new Date(draft.lastTsMs).toISOString() : createdAt;
    units.push({
      id: draft.id,
      sessionId,
      title: buildPlaceholderTitle(draft.files),
      category: deterministicCategory({
        files: draft.files,
        eventKinds: draft.eventKinds,
        hasDependencyEvidence: draft.depChanges.length > 0,
        formattingOnly: draft.formattingOnly,
      }),
      status,
      files: draft.files,
      symbols,
      interfacesChanged,
      schemaChanges: [],
      dependencyChanges: draft.depChanges,
      relatedDecisions,
      validationResults: [...attachedValidations],
      evidence: draft.evidence,
      createdAt,
      updatedAt,
    });
  }

  return {
    sessionId,
    units,
    validations,
    failures,
    unitEvidenceFacts,
    eventChangeUnitIds,
    decisionChangeUnitIds,
    importEdges,
    packageImports,
    fileKinds,
  };

  function mergeInto(target: UnitDraft, source: UnitDraft): void {
    for (const file of source.files) addFile(target, file, source.fileKinds.get(file));
    for (const name of source.symbolOrder) {
      const symbol = source.symbols.get(name);
      if (symbol !== undefined && !target.symbols.has(name)) {
        target.symbols.set(name, symbol);
        target.symbolOrder.push(name);
      }
    }
    for (const evidenceId of source.evidence) addEvidence(target, evidenceId);
    for (const kind of source.eventKinds) {
      if (!target.eventKinds.includes(kind)) target.eventKinds.push(kind);
    }
    for (const eventId of source.eventIds) {
      if (!target.eventIds.includes(eventId)) target.eventIds.push(eventId);
      eventChangeUnitIds.set(eventId, target.id);
    }
    for (const change of source.depChanges) target.depChanges.push(change);
    if (source.firstTsMs !== null && (target.firstTsMs === null || source.firstTsMs < target.firstTsMs)) {
      target.firstTsMs = source.firstTsMs;
    }
    if (source.lastTsMs !== null && (target.lastTsMs === null || source.lastTsMs > target.lastTsMs)) {
      target.lastTsMs = source.lastTsMs;
    }
    const factsOf = unitEvidenceFacts.get(source.id);
    if (factsOf !== undefined && factsOf.length > 0) {
      const merged = unitEvidenceFacts.get(target.id) ?? [];
      merged.push(...factsOf);
      unitEvidenceFacts.set(target.id, merged);
      unitEvidenceFacts.delete(source.id);
    }
    dropDraft(source.id);
  }
}
