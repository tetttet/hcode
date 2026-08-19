import path from "node:path";

export const REPO_MAP_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
]);

export interface SymbolSummary {
  imports: string[];
  exports: string[];
  classes: string[];
  functions: string[];
  types: string[];
}

function unique(values: string[], limit = 40): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function matches(content: string, expression: RegExp, group = 1): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(expression)) {
    const value = match[group]?.trim();
    if (value) {
      values.push(value);
    }
  }
  return unique(values);
}

function moduleName(specifier: string): string {
  return specifier.replace(/^['"]|['"]$/g, "");
}

function scriptSummary(content: string): SymbolSummary {
  const imports = [
    ...matches(content, /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm),
    ...matches(content, /\brequire\(\s*["']([^"']+)["']\s*\)/g),
  ].map(moduleName);
  const exports = [
    ...matches(content, /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g),
    ...matches(content, /\bexports?\.([A-Za-z_$][\w$]*)\s*=/g),
  ];
  for (const group of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const item of (group[1] ?? "").split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop();
      if (name) exports.push(name);
    }
  }
  return {
    imports: unique(imports),
    exports: unique(exports),
    classes: matches(content, /\bclass\s+([A-Za-z_$][\w$]*)/g),
    functions: unique([
      ...matches(content, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
      ...matches(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g),
    ]),
    types: unique([
      ...matches(content, /\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g),
    ]),
  };
}

function pythonSummary(content: string): SymbolSummary {
  const imports = unique([
    ...matches(content, /^\s*import\s+([\w.]+)/gm),
    ...matches(content, /^\s*from\s+([\w.]+)\s+import\b/gm),
  ]);
  const functions = matches(content, /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm);
  const classes = matches(content, /^\s*class\s+([A-Za-z_]\w*)/gm);
  return {
    imports,
    exports: unique([...functions, ...classes].filter((name) => !name.startsWith("_"))),
    classes,
    functions,
    types: [],
  };
}

function goSummary(content: string): SymbolSummary {
  const imports = unique(matches(content, /["']([^"']+)["']/g));
  const functions = matches(content, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm);
  const types = matches(content, /^type\s+([A-Za-z_]\w*)/gm);
  const exported = [...functions, ...types].filter((name) => /^[A-Z]/.test(name));
  return { imports, exports: unique(exported), classes: [], functions, types };
}

function rustSummary(content: string): SymbolSummary {
  const imports = matches(content, /^\s*use\s+([^;]+);/gm);
  const functions = matches(content, /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g);
  const classes = matches(content, /\b(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)/g);
  const types = matches(content, /\b(?:pub(?:\([^)]*\))?\s+)?(?:trait|type)\s+([A-Za-z_]\w*)/g);
  const exports = unique([
    ...matches(content, /\bpub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/g),
    ...matches(content, /\bpub(?:\([^)]*\))?\s+(?:struct|enum|trait|type|mod|static|const)\s+([A-Za-z_]\w*)/g),
  ]);
  return { imports, exports, classes, functions, types };
}

export function extractSymbols(filePath: string, content: string): SymbolSummary {
  switch (path.extname(filePath).toLowerCase()) {
    case ".py": return pythonSummary(content);
    case ".go": return goSummary(content);
    case ".rs": return rustSummary(content);
    default: return scriptSummary(content);
  }
}

export function hasUsefulSymbols(summary: SymbolSummary): boolean {
  return Object.values(summary).some((values) => values.length > 0);
}
