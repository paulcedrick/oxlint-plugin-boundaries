// GENERIC engine module — path classification + matrix evaluation.
//
// Zero repo-specific constants live here. Everything repo-specific (the element
// list, the allow-matrix, the type-only carve-out) is passed in via a `table`
// object. This is the extraction seam for the standalone package: `engine.ts` +
// `discover.ts` are the reusable engine.
//
// Classification is by FILE PATH, because oxlint exposes no module resolver to
// JS plugins (verified against oxlint 1.69.0). Both ends of an import are
// classified to an element type from the path alone:
//   - importing file  -> `context.filename`            (absolute)
//   - imported target -> relative spec resolved against the file dir, OR a bare
//                         workspace specifier mapped to its package dir.

import { dirname, getPackageIndex, resolve, resolveSpecifierDir } from "./discover.js";

export interface Element {
  type: string;
  test: (relPath: string) => boolean;
}

export interface BoundaryTable {
  /** Ordered, specific-before-parent. First matching element wins. */
  ELEMENTS: Element[];
  /** `fromType -> Set(allowed toType)` for VALUE imports. */
  ALLOW: Record<string, Set<string>>;
  /** `fromType -> Set(allowed toType)` permitted ONLY for `import type` edges. */
  TYPE_ONLY_ALLOW: Record<string, Set<string>>;
}

/** Options for {@link classifyTarget}. */
export interface ClassifyTargetOptions {
  /** Ordered element list. */
  elements: Element[];
  /**
   * Scope prefix marking workspace packages (e.g. `"@scope/"`). Bare specifiers
   * outside this scope are treated as external and ignored.
   */
  workspaceScope: string;
}

/**
 * Normalize an absolute path to forward slashes and strip the monorepo-root
 * prefix, yielding a root-relative path the element tests match against
 * (e.g. `apps/api/src/http/app.ts`). This mirrors the old
 * `eslint-plugin-boundaries` `mode:"full"` behavior, which matched patterns
 * against root-relative paths.
 *
 * @param absPath absolute path
 * @param root absolute monorepo root
 * @returns root-relative, forward-slashed path
 */
export function toRelative(absPath: string, root: string): string {
  const normAbs = absPath.replaceAll("\\", "/");
  const normRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normAbs === normRoot) return "";
  if (normAbs.startsWith(normRoot + "/")) return normAbs.slice(normRoot.length + 1);
  return normAbs; // outside the root — return as-is; element tests just won't match
}

/**
 * Classify an absolute path to an element type, or null if it matches no
 * element. The first matching element in `ELEMENTS` wins, so the table MUST be
 * ordered specific-before-parent.
 *
 * @param absPath absolute path to classify
 * @param root absolute monorepo root
 * @param elements ordered element list
 */
export function classifyPath(absPath: string, root: string, elements: Element[]): string | null {
  const rel = toRelative(absPath, root);
  if (!rel) return null;
  for (const element of elements) {
    if (element.test(rel)) return element.type;
  }
  return null;
}

/**
 * Classify a bare workspace specifier (`@scope/pkg[/sub]`) to an element type
 * by resolving it to its package directory and classifying that dir.
 *
 * @param specifier import specifier as written
 * @param root absolute monorepo root
 * @param elements ordered element list
 */
export function classifySpecifier(
  specifier: string,
  root: string,
  elements: Element[],
): string | null {
  const dir = resolveSpecifierDir(specifier, getPackageIndex(root));
  if (!dir) return null;
  return classifyPath(dir, root, elements);
}

/**
 * Resolve an import specifier (relative or bare workspace) to the element type
 * of its target. Returns null for external deps (`zod`, `hono`, …) and for
 * anything that classifies to no element.
 *
 * @param specifier import specifier as written (`node.source.value`)
 * @param fromFile absolute path of the importing file
 * @param root absolute monorepo root
 * @param options elements + workspace scope
 */
export function classifyTarget(
  specifier: string,
  fromFile: string,
  root: string,
  { elements, workspaceScope }: ClassifyTargetOptions,
): string | null {
  if (specifier.startsWith(".")) {
    const abs = resolve(dirname(fromFile), specifier);
    return classifyPath(abs, root, elements);
  }
  if (specifier.startsWith(workspaceScope)) {
    return classifySpecifier(specifier, root, elements);
  }
  return null; // external dependency — not a boundary edge
}

export interface Verdict {
  allowed: boolean;
  reason: "self" | "value-allow" | "type-allow" | "disallow";
}

/**
 * Evaluate whether `fromType` may import `toType` given the import kind.
 *
 * Rules:
 *   - self (`toType === fromType`)            -> allowed (intra-package).
 *   - `ALLOW[fromType]` contains `toType`     -> allowed (value edge).
 *   - `typeOnly` AND `TYPE_ONLY_ALLOW[from]`
 *     contains `toType`                       -> allowed (type-only carve-out).
 *   - otherwise                               -> disallowed.
 *
 * @param fromType element type of the importing file
 * @param toType element type of the imported target
 * @param typeOnly whether the import is `import type` (declaration-level)
 * @param table the repo-specific table (passed in)
 */
export function evaluate(
  fromType: string,
  toType: string,
  typeOnly: boolean,
  table: BoundaryTable,
): Verdict {
  if (toType === fromType) return { allowed: true, reason: "self" };
  if (table.ALLOW[fromType]?.has(toType)) return { allowed: true, reason: "value-allow" };
  if (typeOnly && table.TYPE_ONLY_ALLOW[fromType]?.has(toType)) {
    return { allowed: true, reason: "type-allow" };
  }
  return { allowed: false, reason: "disallow" };
}
