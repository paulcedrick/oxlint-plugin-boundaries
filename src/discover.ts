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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
}

/**
 * Walk up from `startDir` to the monorepo root: the nearest ancestor whose
 * `package.json` declares `"workspaces"`. Falls back to `fallback` (typically
 * `context.cwd`) when no such ancestor exists.
 *
 * Keying off the file path (not cwd) is what makes classification
 * cwd-independent — running oxlint from a workspace subdir resolves the same
 * root as running from the repo root.
 */
export function findWorkspaceRoot(startDir: string, fallback: string): string {
  let dir = startDir;
  // Guard against symlink / root loops: stop when `dirname` stops changing.
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
        if (pkg && pkg.workspaces !== undefined) return dir;
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
function readWorkspaceGlobs(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws as string[];
    if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
      return (ws as { packages: string[] }).packages;
    }
  } catch {
    // fall through
  }
  return [];
}

/**
 * Expand a single workspace glob into concrete package directories.
 *
 * Only the two shapes monorepos actually use are handled: a literal directory
 * (`packages/core`) and a single-level wildcard (`packages/*`, `apps/*`). A
 * `**` glob is treated as the directory before it. No glob engine needed.
 */
function expandGlob(root: string, glob: string): string[] {
  const normalized = glob.replaceAll("\\", "/").replace(/\/+$/, "");
  const starIdx = normalized.indexOf("*");
  if (starIdx === -1) {
    const dir = resolve(root, normalized);
    return existsSync(dir) ? [dir] : [];
  }
  // Parent of the first wildcard segment, e.g. "packages/*" -> "packages".
  const beforeStar = normalized.slice(0, starIdx);
  const parentRel = beforeStar.replace(/\/[^/]*$/, "").replace(/\/$/, "");
  const parentDir = resolve(root, parentRel);
  if (!existsSync(parentDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(parentDir)) {
    if (entry.startsWith(".")) continue;
    const child = join(parentDir, entry);
    try {
      if (statSync(child).isDirectory()) out.push(child);
    } catch {
      // ignore unreadable entries
    }
  }
  return out;
}

/**
 * Discover every workspace package under `root`: read each candidate dir's
 * `package.json` and pair its `name` with its absolute directory.
 */
export function discoverPackages(root: string): DiscoveredPackage[] {
  const packages: DiscoveredPackage[] = [];
  const seen = new Set<string>();
  for (const glob of readWorkspaceGlobs(root)) {
    for (const dir of expandGlob(root, glob)) {
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

// Re-export for callers that build paths relative to a file.
export { dirname, resolve, sep };
