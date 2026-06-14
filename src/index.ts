// Public entry point for oxlint-plugin-boundaries.
//
// Wires the generic engine (engine.ts) and the config layer (config.ts) into two
// oxlint jsPlugins rules:
//   - boundaries/element-types — enforce the configured allow-matrix (with the
//     type-only carve-out and the `default` verdict).
//   - boundaries/no-unknown    — flag a workspace specifier that resolves to no
//     package (typo / deleted package).
//
// oxlint's plugin layer exposes NO module resolver, so both ends of an import are
// classified by FILE PATH (see engine.ts / discover.ts). The element table and
// allow-matrix come entirely from `settings.boundaries` (config.ts), which is
// what makes this package generic — no repo-specific constants live here.
//
// Honored alpha-API gotchas (verified against oxlint / @oxlint/plugins 1.69.0):
//   G1 — `createOnce` runs ONCE across all files. `context.filename` is read
//        INSIDE the visitor, never in the `createOnce` body.
//   G2 — `report()` needs a node carrying `range`; we report on the real
//        `ImportDeclaration` node.
//   G5 — plugin name `boundaries`; rule ids `boundaries/element-types`,
//        `boundaries/no-unknown`.

import { definePlugin, defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

import { classifyPath, classifyTarget, evaluate, toRelative } from "./engine.js";
import {
  discoverPackages,
  findWorkspaceRoot,
  getPackageIndex,
  resolveSpecifierDir,
} from "./discover.js";
import { dirname } from "node:path";
import { compileConfig, type CompiledBoundaries } from "./config.js";

// oxlint exposes its AST node types under the `ESTree` namespace, not as
// top-level exports. Alias the one node we visit.
type ImportDeclaration = ESTree.ImportDeclaration;

// Resolve the monorepo root for a file, memoized by the file's directory. Keying
// off the file path (not cwd) keeps classification cwd-independent.
const rootCache = new Map<string, string>();
function rootFor(filename: string, cwd: string): string {
  const fileDir = dirname(filename);
  const cached = rootCache.get(fileDir);
  if (cached !== undefined) return cached;
  const root = findWorkspaceRoot(fileDir, cwd);
  rootCache.set(fileDir, root);
  return root;
}

// Compile `settings.boundaries` once per workspace root, memoized. Returns null
// when no `boundaries` config is present (rule is then a no-op). A present but
// INVALID config throws BoundariesConfigError (actionable) — not swallowed.
const compiledCache = new Map<string, CompiledBoundaries | null>();
function compiledFor(context: Context, root: string): CompiledBoundaries | null {
  const cached = compiledCache.get(root);
  if (cached !== undefined) return cached;

  const settings = context.settings as { boundaries?: unknown };
  if (settings.boundaries === undefined || settings.boundaries === null) {
    compiledCache.set(root, null);
    return null;
  }
  const packageNames = discoverPackages(root).map((p) => p.name);
  const compiled = compileConfig(settings.boundaries, { packageNames });
  compiledCache.set(root, compiled);
  return compiled;
}

// True when the importing file should be skipped entirely (matches an `ignore`
// pattern), computed against the file's root-relative path.
function isIgnored(compiled: CompiledBoundaries, filename: string, root: string): boolean {
  if (compiled.ignore.length === 0) return false;
  const rel = toRelative(filename, root);
  return compiled.ignore.some((matcher) => matcher.test(rel));
}

const plugin = definePlugin({
  meta: { name: "boundaries" },
  rules: {
    "element-types": defineRule({
      meta: {
        type: "problem",
        docs: {
          description:
            "Enforce the configured cross-package dependency matrix (which element types may import which).",
        },
      },
      createOnce(context: Context) {
        // G1: nothing that reads context.filename here — only inside the visitor.
        return {
          ImportDeclaration(node: ImportDeclaration) {
            const filename = context.filename;
            const root = rootFor(filename, context.cwd);
            const compiled = compiledFor(context, root);
            if (!compiled) return; // rule enabled but not configured -> no-op
            if (isIgnored(compiled, filename, root)) return;

            const fromType = classifyPath(filename, root, compiled.elements);
            if (fromType === null) return; // importing file is not a known element

            const specifier = node.source.value;
            const toType = classifyTarget(specifier, filename, root, {
              elements: compiled.elements,
              workspaceScope: compiled.workspaceScope,
            });
            if (toType === null) return; // external dep / unclassifiable — not an edge

            const typeOnly = node.importKind === "type";
            const verdict = evaluate(fromType, toType, typeOnly, compiled.table);
            // The engine never applies `default`; do it here. An uncovered edge
            // (verdict.allowed === false with reason "disallow") is permitted
            // when default is "allow".
            if (verdict.allowed) return;
            if (compiled.default === "allow") return;

            // G2: report on the real ImportDeclaration node (carries range).
            const custom = compiled.messageFor(fromType, toType);
            const message =
              custom ??
              `'${fromType}' is not allowed to import '${toType}'.` +
                (typeOnly ? "" : ` (If this should be type-only, use \`import type\`.)`);
            context.report({ message, node });
          },
        };
      },
    }),

    "no-unknown": defineRule({
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow importing a workspace-scope specifier that resolves to no package (typo / nonexistent).",
        },
      },
      createOnce(context: Context) {
        return {
          ImportDeclaration(node: ImportDeclaration) {
            const filename = context.filename;
            const root = rootFor(filename, context.cwd);
            const compiled = compiledFor(context, root);
            if (!compiled) return;
            if (isIgnored(compiled, filename, root)) return;

            // Only meaningful from a recognized element.
            if (classifyPath(filename, root, compiled.elements) === null) return;

            const specifier = node.source.value;
            if (!specifier.startsWith(compiled.workspaceScope)) return; // external/relative

            const dir = resolveSpecifierDir(specifier, getPackageIndex(root));
            if (dir !== null) return; // resolves to a real workspace package

            // G2: report on the real node.
            context.report({
              message: `Unknown workspace import: '${specifier}' resolves to no ${compiled.workspaceScope}* package (typo?).`,
              node,
            });
          },
        };
      },
    }),
  },
});

export default plugin;
