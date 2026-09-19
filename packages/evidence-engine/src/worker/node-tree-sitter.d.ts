declare module "node-tree-sitter" {
  export interface NativeParser {
    setLanguage(language: unknown): void;
    parse(source: string): { rootNode: unknown };
  }
  export const Parser: new () => NativeParser;
  export const Language: {
    load(grammarPath: string): unknown;
  };
}
