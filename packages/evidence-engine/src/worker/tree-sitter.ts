import type { SymbolInfo, SymbolKind } from "@jevcode/contracts";

export interface ParsePoint {
  row: number;
  column: number;
}

export interface ParseNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: ParsePoint;
  endPosition: ParsePoint;
  children: readonly ParseNode[];
  childForFieldName(fieldName: string): ParseNode | null;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function symbolFromNode(
  node: ParseNode,
  source: string,
  kind: SymbolKind,
  signatureEndIndex?: number,
): SymbolInfo {
  const nameNode = node.childForFieldName("name");
  const name = nameNode
    ? collapseWhitespace(source.slice(nameNode.startIndex, nameNode.endIndex))
    : kind;
  const signature = collapseWhitespace(
    source.slice(node.startIndex, signatureEndIndex ?? node.endIndex),
  );
  return {
    name,
    kind,
    signature,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

const DECLARATION_NODE_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "lexical_declaration",
  "variable_declaration",
  "function_expression",
  "arrow_function",
]);

function declarationSymbol(node: ParseNode, source: string): SymbolInfo | null {
  switch (node.type) {
    case "function_declaration":
      return symbolFromNode(
        node,
        source,
        "function",
        node.childForFieldName("body")?.startIndex,
      );
    case "class_declaration":
      return symbolFromNode(
        node,
        source,
        "class",
        node.childForFieldName("body")?.startIndex,
      );
    case "interface_declaration":
      return symbolFromNode(
        node,
        source,
        "interface",
        node.childForFieldName("body")?.startIndex,
      );
    case "type_alias_declaration":
      return symbolFromNode(node, source, "type");
    default:
      return null;
  }
}

function variableSymbols(node: ParseNode, source: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  for (const child of node.children) {
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (!nameNode) continue;
    const name = collapseWhitespace(
      source.slice(nameNode.startIndex, nameNode.endIndex),
    );
    if (!name) continue;
    symbols.push({
      name,
      kind: "variable",
      signature: collapseWhitespace(source.slice(child.startIndex, child.endIndex)),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }
  return symbols;
}

function methodSymbols(classNode: ParseNode, source: string): SymbolInfo[] {
  const body = classNode.childForFieldName("body");
  if (!body) return [];
  const symbols: SymbolInfo[] = [];
  for (const child of body.children) {
    if (child.type !== "method_definition") continue;
    symbols.push(
      symbolFromNode(
        child,
        source,
        "method",
        child.childForFieldName("body")?.startIndex,
      ),
    );
  }
  return symbols;
}

function textOf(node: ParseNode, source: string): string {
  return collapseWhitespace(source.slice(node.startIndex, node.endIndex));
}

function stripQuotes(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, "");
}

// Emits one "import" symbol per imported local binding; the module specifier
// stays visible in the signature (which clustering regexes against).
function importSymbols(node: ParseNode, source: string): SymbolInfo[] {
  const signature = textOf(node, source);
  const sourceNode = node.childForFieldName("source");
  const specifier = sourceNode ? stripQuotes(textOf(sourceNode, source)) : "";
  const clause = node.children.find((child) => child.type === "import_clause");
  const names: string[] = [];
  if (clause) {
    for (const child of clause.children) {
      if (child.type === "identifier") {
        names.push(textOf(child, source));
      } else if (child.type === "named_imports") {
        for (const spec of child.children) {
          if (spec.type !== "import_specifier") continue;
          const alias = spec.childForFieldName("alias");
          const nameNode = spec.childForFieldName("name");
          const binding = alias ?? nameNode;
          if (binding) names.push(textOf(binding, source));
        }
      } else if (child.type === "namespace_import") {
        const namespace = child.childForFieldName("namespace");
        if (namespace) {
          names.push(textOf(namespace, source));
        } else {
          const identifier = child.children.find((candidate) => candidate.type === "identifier");
          if (identifier) names.push(textOf(identifier, source));
        }
      }
    }
  }
  if (names.length === 0) names.push(specifier !== "" ? specifier : "import");
  return names.map((name) => ({
    name,
    kind: "import" as const,
    signature,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  }));
}

// Emits kind "export" symbols whose name is the exported binding, walking the
// export_clause alias/name nodes or the declaration's name node.
function exportSymbols(node: ParseNode, source: string): SymbolInfo[] {
  const signature = textOf(node, source);
  const names: string[] = [];
  const declaration = node.children.find((child) =>
    DECLARATION_NODE_TYPES.has(child.type),
  );
  if (declaration) {
    const nameNode = declaration.childForFieldName("name");
    names.push(nameNode ? textOf(nameNode, source) : "default");
  }
  for (const child of node.children) {
    if (child.type !== "export_clause") continue;
    for (const spec of child.children) {
      if (spec.type !== "export_specifier") continue;
      const alias = spec.childForFieldName("alias");
      const nameNode = spec.childForFieldName("name");
      const binding = alias ?? nameNode;
      if (binding) names.push(textOf(binding, source));
    }
  }
  if (names.length === 0) {
    const sourceNode = node.childForFieldName("source");
    const specifier = sourceNode ? stripQuotes(textOf(sourceNode, source)) : "";
    names.push(specifier !== "" ? specifier : "export");
  }
  return names.map((name) => ({
    name,
    kind: "export" as const,
    signature,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  }));
}

function collectNode(node: ParseNode, source: string, out: SymbolInfo[]): void {
  if (node.type === "export_statement") {
    const declaration = node.children.find((child) =>
      DECLARATION_NODE_TYPES.has(child.type),
    );
    if (declaration) {
      collectNode(declaration, source, out);
    }
    out.push(...exportSymbols(node, source));
    return;
  }
  switch (node.type) {
    case "function_declaration":
    case "class_declaration":
    case "interface_declaration":
    case "type_alias_declaration": {
      const symbol = declarationSymbol(node, source);
      if (symbol) out.push(symbol);
      if (node.type === "class_declaration") {
        out.push(...methodSymbols(node, source));
      }
      return;
    }
    case "lexical_declaration":
    case "variable_declaration":
      out.push(...variableSymbols(node, source));
      return;
    case "import_statement":
      out.push(...importSymbols(node, source));
      return;
    default:
      return;
  }
}

export function extractSymbols(root: ParseNode, source: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  for (const child of root.children) {
    collectNode(child, source, symbols);
  }
  return symbols;
}
