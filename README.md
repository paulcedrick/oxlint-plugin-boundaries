# oxlint-plugin-boundaries

Config-driven **cross-package / element-type boundaries** for [oxlint](https://oxc.rs) — enforce an architectural dependency matrix (which parts of your codebase may import which) **without a module resolver**.

You declare your own element table and allow-matrix in `.oxlintrc.json`; the plugin classifies every import by file path and flags edges your matrix disallows. Works in any monorepo (Bun / npm / pnpm / Yarn workspaces) and in single-package repos.

> **Status: alpha.** oxlint's JS plugin system (`jsPlugins`) is itself alpha and not yet semver-stable. This plugin pins a tested `oxlint` range in `peerDependencies` and is exercised against an oxlint-version matrix in CI. Expect a new minor when oxlint changes the plugin API. See [Versioning & the alpha pin](#versioning--the-alpha-pin).

## Why this exists

oxlint has no native cross-package boundaries rule, and the popular [`eslint-plugin-boundaries`](https://github.com/javierbrea/eslint-plugin-boundaries) **cannot run under oxlint's JS-plugin layer**: that layer intentionally exposes _no module resolver_ (no `context.resolve`, empty `parserServices`), and `eslint-plugin-boundaries` depends on one (`eslint-import-resolver-typescript`).

This plugin sidesteps the missing resolver by **classifying purely from the file path**. It walks up to your workspace root, reads each package's `package.json` `name` once to build a `name → directory` index, and resolves bare specifiers like `@scope/pkg` to a directory — then to an element type. No resolver required.

## Install

```sh
bun add -D oxlint-plugin-boundaries
# or: npm i -D oxlint-plugin-boundaries  /  pnpm add -D oxlint-plugin-boundaries
```

`oxlint` is a peer dependency — install it yourself and keep it within the supported range.

## Usage

Reference the plugin in `jsPlugins`, describe your architecture under `settings.boundaries`, and turn the rules on:

```jsonc
{
  "jsPlugins": ["oxlint-plugin-boundaries"],
  "settings": {
    "boundaries": {
      // Ordered: more-specific patterns BEFORE their parents. First match wins.
      "elements": [
        { "type": "core", "pattern": "packages/core/**" },
        { "type": "db", "pattern": "packages/db/**" },
        { "type": "schemas", "pattern": "packages/schemas/**" },
        { "type": "api-client", "pattern": "packages/api-client/**" },
        { "type": "app-web", "pattern": "apps/web/**" },
      ],
      "rules": [
        { "from": "core", "allow": ["db", "schemas"] },
        { "from": "db", "allow": ["schemas"] },
        { "from": "app-web", "allow": ["api-client", "schemas"] },
        {
          "from": "api-client",
          "allow": ["app-api"],
          "importKind": "type",
          "message": "api-client may import apps/api only as `import type`.",
        },
      ],
      "default": "disallow",
      "ignore": ["**/*.test.ts", "**/*.spec.ts"],
    },
  },
  "rules": {
    "boundaries/element-types": "error",
    "boundaries/no-unknown": "error",
  },
}
```

> oxlint resolves `jsPlugins` paths **relative to the config file**. Using the package name (as above) is the normal case; a relative path would be resolved against the `.oxlintrc.json` location, not your shell's cwd.

## Configuration (`settings.boundaries`)

This object is the plugin's public API.

| Field            | Type                      | Required                  | Meaning                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `elements`       | `Element[]`               | yes                       | Ordered list mapping path patterns to element types. **First match wins**, so list specific patterns before their parents.                                                                                                                                                                                                           |
| `rules`          | `Rule[]`                  | yes                       | Directional allow-matrix. Each entry says what a `from` element may import.                                                                                                                                                                                                                                                          |
| `default`        | `"disallow"` \| `"allow"` | no (default `"disallow"`) | Verdict for an edge not covered by any rule.                                                                                                                                                                                                                                                                                         |
| `ignore`         | `string[]`                | no                        | Glob-ish patterns for files to skip entirely.                                                                                                                                                                                                                                                                                        |
| `workspaceScope` | `string`                  | no (derived)              | The package-name prefix marking workspace-internal imports (e.g. `"@acme/"`). A bare specifier starting with it is a candidate boundary edge; anything else is an external dependency and ignored. When omitted, it is derived from the common scope of your workspace packages; set it explicitly if your packages don't share one. |

**`Element`**

| Field     | Type     | Meaning                                                        |
| --------- | -------- | -------------------------------------------------------------- |
| `type`    | `string` | Element type name, referenced by `rules`.                      |
| `pattern` | `string` | Path pattern (root-relative) classifying files into this type. |

**`Rule`**

| Field        | Type                  | Meaning                                                                                          |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| `from`       | `string`              | The importing element type this rule governs.                                                    |
| `allow`      | `string[]`            | Element types `from` may import.                                                                 |
| `importKind` | `"value"` \| `"type"` | Optional. `"type"` narrows the `allow` list to `import type` edges only (a type-only carve-out). |
| `message`    | `string`              | Optional. Custom message shown when this edge is violated.                                       |

Self-imports (an element importing its own type) are always allowed. External dependencies (npm packages outside your workspace) are never boundary edges and are ignored.

### Rules

- **`boundaries/element-types`** — the core rule. For every import, classifies both ends and reports edges your matrix disallows (honoring the type-only carve-out).
- **`boundaries/no-unknown`** — flags a workspace-style specifier that resolves to _no_ package (typically a typo or a deleted package). Closes the gap that `element-types` leaves when a target classifies to nothing.

## How classification works

1. **Find the workspace root** — walk up from the file to the nearest `package.json` declaring `workspaces` (falls back to oxlint's cwd). Keying off the file path keeps results identical no matter which directory you run oxlint from.
2. **Index packages** — read each workspace package's `name` once; memoize a `name → dir` map.
3. **Classify both ends of each import** — the importing file by its path; the target by resolving a relative specifier against the file's directory, or a bare workspace specifier (`@scope/pkg[/sub]`) to its package dir via longest-prefix match.
4. **Evaluate** — `self` → allowed; in the value allow-list → allowed; `import type` and in the type-only allow-list → allowed; otherwise the `default` decides.

## Versioning & the alpha pin

oxlint's `jsPlugins` API is **alpha** and not semver-stable. The policy here:

- `peerDependencies.oxlint` is pinned to a **tested range**; CI runs an oxlint-version matrix.
- When oxlint ships a breaking plugin-API change, this package cuts a new release with an updated range. The test suite is the tripwire — there are no defensive version guards in the runtime.
- Keep your `oxlint` within the supported range for predictable behavior.

## Authoring / build (for contributors)

Authored in TypeScript, shipped as compiled **ESM `.js` + `.d.ts`** so the published artifact loads on any supported Node — including versions below the 22.18 floor that raw `.ts` oxlint plugins require. Built with [tsdown](https://tsdown.dev) (oxc / Rolldown).

```sh
bun install
bun run build        # tsdown -> dist/ (.js + .d.ts), runs publint + attw
bun run type-check
bun run lint         # dogfoods this very plugin
bun test
```

> tsdown requires Node ≥ 22.18 / ≥ 24 to _run the build_. This affects contributors and CI only — never consumers of the published package.

## License

[MIT](./LICENSE) © Paul Cedrick Artigo
