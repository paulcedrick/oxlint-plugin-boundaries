// Config layer - translate the user's `settings.boundaries` into exactly the
// structures the generic engine consumes.
//
// The engine (engine.ts) is table-free: it takes an ordered `Element[]`, an
// `ALLOW` map and a `TYPE_ONLY_ALLOW` map and evaluates edges. It knows nothing
// about the public config schema. THIS module is the only place that schema is
// understood: it validates the raw config once (throwing actionable errors),
// compiles element/ignore patterns to matchers, and normalizes the directional
// rules into the engine's two allow-maps. Pure - no oxlint imports, no
// filesystem; the Step-4 rule layer wires the compiled output into oxlint.

import type { BoundaryTable, Element } from "./engine.js";
// Re-export the engine verdict type so Step 4 can import everything it needs
// from one place.
export type { BoundaryTable, Element, Verdict } from "./engine.js";

// A single `settings.boundaries.elements[]` entry, post-validation.
export interface ElementConfig {
  type: string;
  pattern: string;
}

// A single `settings.boundaries.rules[]` entry, post-validation.
export interface RuleConfig {
  from: string;
  allow: string[];
  importKind?: "value" | "type";
  message?: string;
}

// The compiled, validated config the Step-4 rules consume. `elements` and
// `table.ELEMENTS` are the SAME array (the engine classifies against
// `table.ELEMENTS`); both are exposed for call-site clarity.
export interface CompiledBoundaries {
  // Ordered, first-match-wins element matchers.
  elements: Element[];
  // The engine table: ELEMENTS + ALLOW + TYPE_ONLY_ALLOW.
  table: BoundaryTable;
  // Verdict for an edge no rule covers. Applied by the Step-4 rule, not the engine.
  default: "allow" | "disallow";
  // Compiled matchers for files to skip entirely (root-relative path tests).
  ignore: Element[];
  // Scope prefix marking workspace-internal bare specifiers, e.g. "@scope/".
  workspaceScope: string;
  // Per-edge custom message, or undefined when none was configured.
  messageFor: (fromType: string, toType: string) => string | undefined;
}

// Options for compileConfig.
export interface CompileConfigOptions {
  // Workspace package names (from `discoverPackages`) used to DERIVE
  // `workspaceScope` when the config omits it. Ignored when the config sets
  // `workspaceScope` explicitly.
  packageNames?: string[];
}

// Thrown for any invalid `settings.boundaries`. The message is actionable.
export class BoundariesConfigError extends Error {
  constructor(message: string) {
    super(`Invalid settings.boundaries: ${message}`);
    this.name = "BoundariesConfigError";
  }
}

function fail(message: string): never {
  throw new BoundariesConfigError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- pattern compilation ----------------------------------------------------

// Escape every RegExp metacharacter in a literal path fragment.
function escapeLiteral(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compile an ELEMENT pattern (a root-relative path prefix) to a matcher.
//
// Supported shapes - the small set monorepos actually use:
//   - "dir/<star><star>" -> match the dir itself AND anything under it.
//   - "dir"              -> identical (a bare directory).
//
// Both compile to `^<dir>(/|$)` (gotcha G6). The `(/|$)` boundary is the whole
// point: a bare workspace specifier (`@scope/core`) resolves to a package dir
// with NO trailing segment, so a "must be followed by slash" test would
// silently classify it as null and no-op the rule. `(/|$)` matches the dir
// itself while still preventing `apps/api` from matching `apps/api-client`.
//
// Anything else (a mid-segment wildcard, a `*.ext` tail, a leading globstar
// segment) is rejected - element patterns are prefixes, not file globs.
function compileElementPattern(pattern: string, label: string): (relPath: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  // Strip an optional trailing globstar segment (or bare slash) for the prefix.
  const dir = normalized.replace(/\/\*\*$/, "").replace(/\/+$/, "");
  if (dir === "" || dir === "**") {
    fail(`${label} pattern ${JSON.stringify(pattern)} is too broad - name a directory.`);
  }
  if (dir.includes("*")) {
    fail(
      `${label} pattern ${JSON.stringify(pattern)} is unsupported - element patterns must be a ` +
        `directory ("dir") or a directory tree ("dir" + slash + globstar), with no wildcards ` +
        `inside the path.`,
    );
  }
  const re = new RegExp(`^${escapeLiteral(dir)}(/|$)`);
  return (relPath) => re.test(relPath);
}

// Compile an IGNORE glob to a matcher. Ignore patterns are file globs (they
// match a whole root-relative path), so they support a broader vocabulary than
// element prefixes:
//   - globstar -> any characters, any depth (`.*`)
//   - `*`      -> any characters within a single segment (`[^/]*`)
//   - a trailing "dir/" + globstar also matches the bare dir (`(/|$)`
//     boundary), matching element semantics so an ignore and an element written
//     the same way agree.
//
// Everything else is treated as a literal.
function compileIgnorePattern(pattern: string): (relPath: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  // Special-case a trailing globstar segment so `packages/core/<star><star>`
  // also matches the bare dir `packages/core` (same `(/|$)` boundary as
  // element patterns).
  const trailingTree = normalized.endsWith("/**");
  const body = trailingTree ? normalized.slice(0, -3) : normalized;

  let source = "";
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("**/", i)) {
      // Leading globstar segment - any number of leading segments (incl. none).
      source += "(?:.*/)?";
      i += 3;
    } else if (body.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (body[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += escapeLiteral(body[i] as string);
      i += 1;
    }
  }
  const tail = trailingTree ? "(/|$)" : "$";
  const re = new RegExp(`^${source}${tail}`);
  return (relPath) => re.test(relPath);
}

// --- validation -------------------------------------------------------------

function validateElements(raw: unknown): ElementConfig[] {
  if (!Array.isArray(raw)) fail("`elements` is required and must be an array.");
  if (raw.length === 0) fail("`elements` must be a non-empty array.");
  const seen = new Set<string>();
  const out: ElementConfig[] = [];
  raw.forEach((entry, idx) => {
    if (!isObject(entry)) fail(`elements[${idx}] must be an object.`);
    const { type, pattern } = entry;
    if (typeof type !== "string" || type === "") {
      fail(`elements[${idx}] is missing a string \`type\`.`);
    }
    if (typeof pattern !== "string" || pattern === "") {
      fail(`elements[${idx}] (type ${JSON.stringify(type)}) is missing a string \`pattern\`.`);
    }
    if (seen.has(type)) fail(`duplicate element type ${JSON.stringify(type)}.`);
    seen.add(type);
    out.push({ type, pattern });
  });
  return out;
}

function validateRules(raw: unknown, knownTypes: Set<string>): RuleConfig[] {
  if (!Array.isArray(raw)) fail("`rules` is required and must be an array.");
  const out: RuleConfig[] = [];
  raw.forEach((entry, idx) => {
    if (!isObject(entry)) fail(`rules[${idx}] must be an object.`);
    const { from, allow, importKind, message } = entry;
    if (typeof from !== "string" || from === "") {
      fail(`rules[${idx}] is missing a string \`from\`.`);
    }
    if (!knownTypes.has(from)) {
      fail(`rules[${idx}].from references unknown element type ${JSON.stringify(from)}.`);
    }
    if (!Array.isArray(allow)) {
      fail(`rules[${idx}] (from ${JSON.stringify(from)}) is missing an \`allow\` array.`);
    }
    allow.forEach((to, j) => {
      if (typeof to !== "string" || to === "") {
        fail(`rules[${idx}].allow[${j}] must be a non-empty string.`);
      }
      if (!knownTypes.has(to)) {
        fail(`rules[${idx}].allow references unknown element type ${JSON.stringify(to)}.`);
      }
    });
    if (importKind !== undefined && importKind !== "value" && importKind !== "type") {
      fail(
        `rules[${idx}].importKind must be "value" or "type" (got ${JSON.stringify(importKind)}).`,
      );
    }
    if (message !== undefined && typeof message !== "string") {
      fail(`rules[${idx}].message must be a string.`);
    }
    out.push({
      from,
      allow: allow as string[],
      ...(importKind !== undefined ? { importKind: importKind as "value" | "type" } : {}),
      ...(message !== undefined ? { message: message as string } : {}),
    });
  });
  return out;
}

// --- workspaceScope ---------------------------------------------------------

// Derive the workspace scope prefix shared by every package name, e.g.
// `["@acme/core", "@acme/api"]` -> `"@acme/"`. Returns null when the names do
// not all share a single `@scope/` prefix (so the caller can fall back to the
// explicit config field or fail loudly).
export function deriveWorkspaceScope(packageNames: string[]): string | null {
  const scopes = new Set<string>();
  for (const name of packageNames) {
    const match = /^(@[^/]+\/)/.exec(name);
    if (!match) return null; // an unscoped package - no common scope
    scopes.add(match[1] as string);
  }
  if (scopes.size !== 1) return null;
  return [...scopes][0] as string;
}

// --- entry point ------------------------------------------------------------

// Validate and compile a raw `settings.boundaries` object into the structures
// the Step-4 rules consume. Throws BoundariesConfigError with an actionable
// message on any invalid config.
export function compileConfig(
  raw: unknown,
  options: CompileConfigOptions = {},
): CompiledBoundaries {
  if (!isObject(raw)) {
    fail("settings.boundaries must be an object.");
  }

  const elementConfigs = validateElements(raw.elements);
  const knownTypes = new Set(elementConfigs.map((e) => e.type));
  const ruleConfigs = validateRules(raw.rules, knownTypes);

  // `default`.
  let dflt: "allow" | "disallow" = "disallow";
  if (raw.default !== undefined) {
    if (raw.default !== "allow" && raw.default !== "disallow") {
      fail(`\`default\` must be "allow" or "disallow" (got ${JSON.stringify(raw.default)}).`);
    }
    dflt = raw.default;
  }

  // `ignore`.
  let ignorePatterns: string[] = [];
  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) fail("`ignore` must be an array of glob strings.");
    raw.ignore.forEach((p, idx) => {
      if (typeof p !== "string" || p === "") fail(`ignore[${idx}] must be a non-empty string.`);
    });
    ignorePatterns = raw.ignore as string[];
  }

  // `workspaceScope`: explicit field wins; otherwise derive from package names.
  let workspaceScope: string;
  if (raw.workspaceScope !== undefined) {
    if (typeof raw.workspaceScope !== "string" || raw.workspaceScope === "") {
      fail('`workspaceScope` must be a non-empty string (e.g. "@acme/").');
    }
    workspaceScope = raw.workspaceScope;
  } else {
    const derived = deriveWorkspaceScope(options.packageNames ?? []);
    if (derived === null) {
      fail(
        "`workspaceScope` is required and could not be derived from the workspace package " +
          "names. Set settings.boundaries.workspaceScope to your packages' shared scope " +
          '(e.g. "@acme/").',
      );
    }
    workspaceScope = derived;
  }

  // Compile element matchers (ordered, first-match-wins preserved).
  const elements: Element[] = elementConfigs.map((e) => ({
    type: e.type,
    test: compileElementPattern(e.pattern, `elements[type ${JSON.stringify(e.type)}]`),
  }));

  // Compile ignore matchers - reuse the Element shape (type is a placeholder
  // label; only `test` is used by the rule).
  const ignore: Element[] = ignorePatterns.map((pattern, idx) => ({
    type: `ignore[${idx}]`,
    test: compileIgnorePattern(pattern),
  }));

  // Normalize rules into ALLOW / TYPE_ONLY_ALLOW (union same-`from`, never
  // overwrite). Keep a per-edge message lookup.
  const ALLOW: Record<string, Set<string>> = {};
  const TYPE_ONLY_ALLOW: Record<string, Set<string>> = {};
  const messages = new Map<string, string>();
  const edgeKey = (from: string, to: string) => `${from} ${to}`;

  for (const rule of ruleConfigs) {
    const target = rule.importKind === "type" ? TYPE_ONLY_ALLOW : ALLOW;
    const set = (target[rule.from] ??= new Set<string>());
    for (const to of rule.allow) {
      set.add(to);
      if (rule.message !== undefined) messages.set(edgeKey(rule.from, to), rule.message);
    }
  }

  const table: BoundaryTable = { ELEMENTS: elements, ALLOW, TYPE_ONLY_ALLOW };

  return {
    elements,
    table,
    default: dflt,
    ignore,
    workspaceScope,
    messageFor: (fromType, toType) => messages.get(edgeKey(fromType, toType)),
  };
}
