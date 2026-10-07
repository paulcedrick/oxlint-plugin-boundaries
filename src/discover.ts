// GENERIC engine module — package discovery.
//
// Zero repo-specific constants live here. This is part of the extraction seam
// for the standalone package: `discover.ts` + `engine.ts` form the reusable
// engine; the boundary table is passed in.
//
// oxlint exposes NO module resolver to JS plugins (verified against oxlint
// 1.69.0): a rule sees one file's AST + that file's path + config `settings`,
// nothing cross-file. So we classify by PATH. To turn a bare workspace
// specifier (e.g. `@scope/core`) into a directory, we read every workspace
// `package.json`'s `name` once and build a name -> dir index.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface DiscoveredPackage {
  name: string;
  dir: string;
}

// Minimal shape we read off a parsed package.json. `JSON.parse` yields `any`;
// narrowing through this type keeps the loose runtime checks below honest.
interface PackageJson {
  name?: unknown;
  workspaces?: unknown;
  exports?: unknown;
  source?: unknown;
  module?: unknown;
  main?: unknown;
  nx?: unknown;
}

/**
 * Walk up from `startDir` to the monorepo root: the nearest ancestor whose
 * `package.json` declares `"workspaces"` or the directory contains a
 * `pnpm-workspace.yaml`. Falls back to `fallback` (typically `context.cwd`)
 * when no such ancestor exists.
 *
 * Keying off the file path (not cwd) is what makes classification
 * cwd-independent — running oxlint from a workspace subdir resolves the same
 * root as running from the repo root.
 */
export function findWorkspaceRoot(startDir: string, fallback: string): string {
  let dir = startDir;
  // Guard against symlink / root loops: stop when `dirname` stops changing.
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
        if (pkg && (pkg.workspaces !== undefined || existsSync(join(dir, "pnpm-workspace.yaml")))) {
          return dir;
        }
      } catch {
        // Unreadable/!JSON package.json — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

/**
 * Read the `workspaces` field of a root `package.json` and return the raw glob
 * patterns. Supports both the array form (`["apps/*", ...]`) and the Bun/Yarn
 * object form (`{ packages: [...] }`). Returns `[]` on any problem.
 */
function parseYamlScalar(value: string): string | null {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (!trimmed) return null;
  const unquoted = trimmed.replace(
    /^(?:'([^']*)'|"((?:\\.|[^"])*)")$/,
    (_match, single, double) =>
      single ?? (double as string).replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
  );
  return unquoted === trimmed && /^[|>&*!{}[\],]/.test(trimmed) ? null : unquoted;
}

function splitYamlFlowSequence(value: string): string[] {
  const items: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote === '"' && char === "\\") {
      i += 1;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else if (!quote && char === ",") {
      items.push(value.slice(start, i));
      start = i + 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

/** Read pnpm's `packages:` block without adding a YAML runtime dependency. */
function readPnpmWorkspaceGlobs(root: string): string[] {
  try {
    const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const lines = text.split(/\r?\n/);
    const lineIndex = lines.findIndex((item) => /^\s*packages\s*:/.test(item));
    if (lineIndex === -1) return [];
    const line = lines[lineIndex] as string;
    const afterColon = line.slice(line.indexOf(":") + 1).trim();
    if (afterColon.startsWith("[")) {
      let sequence = afterColon;
      let close = sequence.indexOf("]");
      for (let i = lineIndex + 1; close === -1 && i < lines.length; i += 1) {
        sequence += ` ${(lines[i] as string).replace(/\s+#.*$/, "").trim()}`;
        close = sequence.indexOf("]");
      }
      if (close === -1) return [];
      const items = sequence.slice(1, close);
      return splitYamlFlowSequence(items)
        .map(parseYamlScalar)
        .filter((item): item is string => item !== null);
    }
    const out: string[] = [];
    for (const item of lines.slice(lineIndex + 1)) {
      if (item.trim() && !/^\s/.test(item)) break;
      const match = /^\s*-\s*(.*?)\s*$/.exec(item);
      if (match) {
        const value = parseYamlScalar(match[1] as string);
        if (value !== null) out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function readWorkspaceGlobs(root: string): string[] {
  const globs = readPnpmWorkspaceGlobs(root);
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return [...globs, ...(ws as string[])];
    if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
      return [...globs, ...(ws as { packages: string[] }).packages];
    }
  } catch {
    // fall through
  }
  return globs;
}

/**
 * Expand a single workspace glob into concrete package directories.
 *
 * Expand the `*` and `**` path segments used by npm/pnpm workspace patterns.
 */
function expandGlob(root: string, glob: string): string[] {
  const segments = glob.replaceAll("\\", "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const out: string[] = [];
  const visited = new Set<string>();
  const visit = (dir: string, index: number): void => {
    if (visited.has(`${dir}\0${index}`)) return;
    visited.add(`${dir}\0${index}`);
    if (index === segments.length) {
      if (existsSync(dir)) out.push(dir);
      return;
    }
    const segment = segments[index] as string;
    if (segment === "**") {
      visit(dir, index + 1);
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) visit(child, index);
        }
      } catch {
        // Ignore missing or unreadable directories.
      }
      return;
    }
    if (!segment.includes("*")) {
      visit(join(dir, segment), index + 1);
      return;
    }
    const matcher = new RegExp(`^${segment.split("*").map(escapeRegExp).join(".*")}$`);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          !matcher.test(entry.name)
        ) {
          continue;
        }
        const child = join(dir, entry.name);
        if (entry.isDirectory()) visit(child, index + 1);
      }
    } catch {
      // Ignore missing or unreadable directories.
    }
  };
  visit(root, 0);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Discover every workspace package under `root`: read each candidate dir's
 * `package.json` and pair its `name` with its absolute directory.
 */
export function discoverPackages(root: string): DiscoveredPackage[] {
  const packages: DiscoveredPackage[] = [];
  const seen = new Set<string>();
  for (const glob of readWorkspaceGlobs(root)) {
    const excluded = glob.startsWith("!");
    for (const dir of expandGlob(root, excluded ? glob.slice(1) : glob)) {
      if (excluded) {
        seen.delete(dir);
        const idx = packages.findIndex((pkg) => pkg.dir === dir);
        if (idx !== -1) packages.splice(idx, 1);
        continue;
      }
      if (seen.has(dir)) continue;
      seen.add(dir);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
        if (pkg && typeof pkg.name === "string") {
          packages.push({ name: pkg.name, dir });
        }
      } catch {
        // No/!JSON package.json in this dir — not a package; skip.
      }
    }
  }
  return packages;
}

/**
 * Build a `packageName -> absoluteDir` map, memoized per monorepo root so the
 * filesystem scan runs once across all linted files (mirrors oxlint's
 * once-per-process `createOnce` design).
 */
const indexCache = new Map<string, Map<string, string>>();

export function getPackageIndex(root: string): Map<string, string> {
  const cached = indexCache.get(root);
  if (cached) return cached;
  const index = new Map<string, string>();
  for (const { name, dir } of discoverPackages(root)) index.set(name, dir);
  indexCache.set(root, index);
  return index;
}

/**
 * Resolve a bare package specifier to its package directory via the index.
 *
 * Handles subpath specifiers (`@scope/pkg/sub`) by matching the longest
 * package name that the specifier equals or starts with (`name + "/"`). The
 * matched package's directory is returned; subpath refinement (mapping
 * `@scope/pkg/sub` to a sub-element) is intentionally NOT done here — callers
 * classify the returned dir. Today only bare names are used.
 */
export function resolveSpecifierDir(specifier: string, index: Map<string, string>): string | null {
  // Exact package name.
  const exact = index.get(specifier);
  if (exact) return exact;
  // Longest-prefix match for subpath specifiers (`@scope/pkg/sub`).
  let bestDir: string | null = null;
  let bestLen = -1;
  for (const [name, dir] of index) {
    const prefix = name + "/";
    if (specifier.startsWith(prefix) && name.length > bestLen) {
      bestDir = dir;
      bestLen = name.length;
    }
  }
  return bestDir;
}

/**
 * Resolve an internal package specifier to its best available source path.
 * Package identity remains available through `resolveSpecifierDir`; this path
 * is only used for element classification. Existing export targets and source
 * entry fields take precedence, with package directory as a safe fallback.
 */
const specifierPathCache = new Map<string, string | null>();

export function resolveSpecifierPath(specifier: string, index: Map<string, string>): string | null {
  const dir = resolveSpecifierDir(specifier, index);
  if (!dir) return null;
  const cacheKey = `${dir}\0${specifier}`;
  if (specifierPathCache.has(cacheKey)) return specifierPathCache.get(cacheKey) ?? null;
  const result = resolveSpecifierPathUncached(specifier, dir, index);
  specifierPathCache.set(cacheKey, result);
  return result;
}

function resolveSpecifierPathUncached(
  specifier: string,
  dir: string,
  index: Map<string, string>,
): string {
  const packageName = [...index.keys()]
    .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  const subpath =
    packageName && specifier !== packageName ? `./${specifier.slice(packageName.length + 1)}` : ".";
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
    const workspaceRoot = (start: string): string => {
      let current = start;
      for (;;) {
        if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
        try {
          const rootPkg = JSON.parse(
            readFileSync(join(current, "package.json"), "utf8"),
          ) as PackageJson;
          if (rootPkg.workspaces !== undefined) return current;
        } catch {
          // Keep walking when this package.json is unreadable.
        }
        const parent = dirname(current);
        if (parent === current) return start;
        current = parent;
      }
    };
    const root = workspaceRoot(dir);
    const targets: string[] = [];
    const addTarget = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("./")) targets.push(value);
      else if (value && typeof value === "object") {
        const conditions = value as Record<string, unknown>;
        for (const key of ["source", "import", "default", "types", "require"])
          addTarget(conditions[key]);
      }
    };
    const exports = pkg.exports;
    if (typeof exports === "string") {
      if (subpath === ".") addTarget(exports);
    } else if (exports && typeof exports === "object" && !Array.isArray(exports)) {
      const entries = exports as Record<string, unknown>;
      if (subpath === ".") addTarget("." in entries ? entries["."] : exports);
      else addTarget(entries[subpath]);
    }
    const nxSourceRoot = (pkg.nx as { sourceRoot?: unknown } | undefined)?.sourceRoot;
    if (typeof nxSourceRoot === "string") {
      targets.push(resolve(root, nxSourceRoot));
    }
    try {
      const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
        sourceRoot?: unknown;
      };
      if (typeof project.sourceRoot === "string") {
        targets.push(resolve(root, project.sourceRoot));
      }
    } catch {
      // Nx project metadata is optional.
    }
    if (subpath !== ".") targets.push(subpath);
    for (const key of ["source", "module", "main"] as const) {
      if (typeof pkg[key] === "string") {
        const value = pkg[key] as string;
        targets.push(value.startsWith("./") ? value : `./${value}`);
      }
    }
    for (const target of targets) {
      const abs = target.startsWith("./") ? resolve(dir, target) : resolve(target);
      if ((abs.startsWith(`${dir}${sep}`) || abs.startsWith(`${root}${sep}`)) && existsSync(abs)) {
        return abs;
      }
    }
  } catch {
    // A declared package is still known even if its metadata cannot be read.
  }
  return dir;
}

// Re-export for callers that build paths relative to a file.
export { dirname, resolve, sep };
