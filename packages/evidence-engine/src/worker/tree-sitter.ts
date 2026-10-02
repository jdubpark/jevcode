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
  /** web-tree-sitter and node-tree-sitter both provide it; extractImportSpecifiers falls back to a walk. */
  descendantsOfType?(types: string | string[]): ParseNode[];
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

/** Import specifiers and top-level exported names of one file (spec §5.1). */
export interface ImportScan {
  specifiers: string[];
  exports: string[];
}

const EXPORT_DECLARATION_TYPES = new Set([
  ...DECLARATION_NODE_TYPES,
  "generator_function_declaration",
  "abstract_class_declaration",
  "enum_declaration",
]);

// require( and import( can sit anywhere in a file; static imports and exports are top-level.
const DYNAMIC_IMPORT_HINT = /\brequire\s*\(|\bimport\s*\(/;

function stringLiteral(node: ParseNode | null | undefined, source: string): string | null {
  if (!node || node.type !== "string") return null;
  const raw = source.slice(node.startIndex, node.endIndex);
  return raw.length >= 2 ? raw.slice(1, -1) : null;
}

function moduleSource(node: ParseNode): ParseNode | null {
  return node.childForFieldName("source") ?? node.children.find((child) => child.type === "string") ?? null;
}

function exportedNames(node: ParseNode, source: string): string[] {
  const names: string[] = [];
  const declaration = node.children.find((child) => EXPORT_DECLARATION_TYPES.has(child.type));
  if (declaration) {
    if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
      for (const child of declaration.children) {
        if (child.type !== "variable_declarator") continue;
        const name = child.childForFieldName("name");
        if (name && name.type === "identifier") names.push(textOf(name, source));
      }
    } else {
      const name = declaration.childForFieldName("name");
      if (name) names.push(textOf(name, source));
    }
  }
  for (const child of node.children) {
    if (child.type !== "export_clause") continue;
    for (const spec of child.children) {
      if (spec.type !== "export_specifier") continue;
      const binding = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
      if (binding) names.push(textOf(binding, source));
    }
  }
  if (names.length === 0 && node.children.some((child) => child.type === "default")) names.push("default");
  return names;
}

function descendantsOfType(root: ParseNode, type: string): readonly ParseNode[] {
  if (root.descendantsOfType) return root.descendantsOfType(type);
  const out: ParseNode[] = [];
  const stack: ParseNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ParseNode;
    if (node.type === type) out.push(node);
    for (const child of node.children) stack.push(child);
  }
  return out;
}

/**
 * Static imports and re-exports (`import … from`, `import "x"`, `import x = require("x")`,
 * `export … from`), plus `require("x")` and `import("x")` calls with a string literal anywhere
 * in the file. Template literals and computed specifiers are ignored. Both lists are sorted
 * and unique.
 */
export function extractImportSpecifiers(root: ParseNode, source: string): ImportScan {
  const specifiers = new Set<string>();
  const exports = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null && value !== "") specifiers.add(value);
  };
  for (const node of root.children) {
    if (node.type === "import_statement") {
      const requireClause = node.children.find((child) => child.type === "import_require_clause");
      add(stringLiteral(moduleSource(requireClause ?? node), source));
    } else if (node.type === "export_statement") {
      add(stringLiteral(node.childForFieldName("source"), source));
      for (const name of exportedNames(node, source)) exports.add(name);
    }
  }
  if (DYNAMIC_IMPORT_HINT.test(source)) {
    for (const call of descendantsOfType(root, "call_expression")) {
      const callee = call.childForFieldName("function");
      if (!callee) continue;
      const isRequire = callee.type === "identifier" && source.slice(callee.startIndex, callee.endIndex) === "require";
      if (!isRequire && callee.type !== "import") continue;
      const args = call.childForFieldName("arguments");
      const first = args?.children.find((child) => child.type !== "(" && child.type !== ")" && child.type !== ",");
      add(stringLiteral(first, source));
    }
  }
  return { specifiers: [...specifiers].sort(), exports: [...exports].sort() };
}
