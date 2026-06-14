import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../src/index.ts";

// Rule-level tests. We drive each rule's `createOnce` directly with a faked
// oxlint `Context` and faked `ImportDeclaration` nodes, over a REAL temp
// workspace on disk (discover.ts reads the filesystem to resolve bare
// specifiers). This reproduces the behavior bar of the original
// eslint-plugin-boundaries config: allow / deny / self / type-only / external /
// default / ignore / custom message / no-unknown.

// --- temp workspace fixture -------------------------------------------------
//
//   <root>/package.json            { workspaces: ["packages/*"] }
//   <root>/packages/core/...       @acme/core
//   <root>/packages/db/...         @acme/db
//   <root>/packages/schemas/...    @acme/schemas
//   <root>/packages/web/...        @acme/web
//   <root>/packages/api/...        @acme/api  (the type-only target)
//   <root>/packages/api-client/... @acme/api-client

let root: string;

function pkgAt(at: string, dir: string, name: string): void {
  mkdirSync(join(at, dir, "src"), { recursive: true });
  writeFileSync(join(at, dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  writeFileSync(join(at, dir, "src", "index.ts"), "export const x = 1;\n");
}

// Build a fresh temp workspace with the standard @acme/* packages and return its
// root. Each distinct config needs its OWN root, because the plugin memoizes the
// compiled config per workspace root (correct in production — one config per
// repo — but it means two configs at the same root would collide in tests).
const allRoots: string[] = [];
function makeWorkspace(): string {
  const r = mkdtempSync(join(tmpdir(), "oxb-rules-"));
  allRoots.push(r);
  writeFileSync(
    join(r, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
  );
  for (const [dir, name] of [
    ["packages/core", "@acme/core"],
    ["packages/db", "@acme/db"],
    ["packages/schemas", "@acme/schemas"],
    ["packages/web", "@acme/web"],
    ["packages/api", "@acme/api"],
    ["packages/api-client", "@acme/api-client"],
  ] as const) {
    pkgAt(r, dir, name);
  }
  return r;
}

beforeAll(() => {
  root = makeWorkspace();
});

afterAll(() => {
  for (const r of allRoots) rmSync(r, { recursive: true, force: true });
});

// The settings.boundaries config used by most tests — a small slice of the
// Postpipe matrix exercising every behavior:
//   web    -> api-client, schemas
//   core   -> db, schemas
//   db     -> schemas
//   api-client -> schemas (value); api (type-only)
//   default disallow; ignore **/*.test.ts
function baseConfig(): unknown {
  return {
    elements: [
      { type: "core", pattern: "packages/core/**" },
      { type: "db", pattern: "packages/db/**" },
      { type: "schemas", pattern: "packages/schemas/**" },
      { type: "web", pattern: "packages/web/**" },
      { type: "api", pattern: "packages/api/**" },
      { type: "api-client", pattern: "packages/api-client/**" },
    ],
    rules: [
      { from: "web", allow: ["api-client", "schemas"] },
      { from: "core", allow: ["db", "schemas"] },
      { from: "db", allow: ["schemas"] },
      { from: "api-client", allow: ["schemas"] },
      {
        from: "api-client",
        allow: ["api"],
        importKind: "type",
        message: "api-client may import api only as `import type`.",
      },
    ],
    default: "disallow",
    ignore: ["**/*.test.ts"],
    workspaceScope: "@acme/",
  };
}

// Minimal fake of an oxlint ImportDeclaration node carrying what the rules read:
// `source.value` and optional `importKind`, plus a `range` (G2). Cast through
// unknown since we only populate the fields the rules touch.
function importNode(specifier: string, importKind: "value" | "type" = "value"): any {
  return {
    type: "ImportDeclaration",
    source: { type: "Literal", value: specifier },
    importKind,
    range: [0, 0],
    start: 0,
    end: 0,
  };
}

// Build a fake Context and run a rule's ImportDeclaration visitor against one
// import, returning the messages reported (empty array = allowed).
function runRule(
  ruleId: "element-types" | "no-unknown",
  fromFile: string,
  node: ReturnType<typeof importNode>,
  config: unknown = baseConfig(),
  atRoot: string = root,
): string[] {
  const messages: string[] = [];
  const rule = (plugin.rules as Record<string, { createOnce: (ctx: any) => any }>)[ruleId];
  if (!rule) throw new Error(`rule ${ruleId} not found`);
  const context = {
    id: `boundaries/${ruleId}`,
    filename: join(atRoot, fromFile),
    physicalFilename: join(atRoot, fromFile),
    cwd: atRoot,
    options: [],
    settings: { boundaries: config },
    report: (d: { message?: string }) => {
      messages.push(d.message ?? "");
    },
  };
  const visitor = rule.createOnce(context);
  // Support `before` hook if the rule uses one.
  if (typeof visitor.before === "function") visitor.before();
  visitor.ImportDeclaration?.(node);
  return messages;
}

describe("plugin shape (smoke parity)", () => {
  it("is named boundaries with both rules exposing createOnce", () => {
    expect(plugin.meta?.name).toBe("boundaries");
    const ids = Object.keys(plugin.rules);
    expect(ids).toContain("element-types");
    expect(ids).toContain("no-unknown");
    for (const id of ids) {
      expect(typeof (plugin.rules as any)[id].createOnce).toBe("function");
    }
  });
});

describe("element-types: value edges", () => {
  it("allows a configured edge (web -> schemas)", () => {
    expect(
      runRule("element-types", "packages/web/src/index.ts", importNode("@acme/schemas")),
    ).toEqual([]);
  });

  it("allows web -> api-client", () => {
    expect(
      runRule("element-types", "packages/web/src/index.ts", importNode("@acme/api-client")),
    ).toEqual([]);
  });

  it("denies an unconfigured edge (web -> db)", () => {
    const msgs = runRule("element-types", "packages/web/src/index.ts", importNode("@acme/db"));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("web");
    expect(msgs[0]).toContain("db");
  });

  it("denies core -> web (not allowed)", () => {
    expect(
      runRule("element-types", "packages/core/src/index.ts", importNode("@acme/web")).length,
    ).toBe(1);
  });

  it("allows self-imports (core -> core) via a relative path", () => {
    // A relative import within the same package classifies to the same element.
    expect(runRule("element-types", "packages/core/src/index.ts", importNode("./helper"))).toEqual(
      [],
    );
  });

  it("ignores external dependencies (web -> zod)", () => {
    expect(runRule("element-types", "packages/web/src/index.ts", importNode("zod"))).toEqual([]);
  });
});

describe("element-types: type-only carve-out", () => {
  it("denies a VALUE import on a type-only edge (api-client -> api)", () => {
    const msgs = runRule(
      "element-types",
      "packages/api-client/src/index.ts",
      importNode("@acme/api", "value"),
    );
    expect(msgs.length).toBe(1);
  });

  it("allows an `import type` on a type-only edge (api-client -> api)", () => {
    expect(
      runRule("element-types", "packages/api-client/src/index.ts", importNode("@acme/api", "type")),
    ).toEqual([]);
  });

  it("surfaces the configured per-edge message", () => {
    const msgs = runRule(
      "element-types",
      "packages/api-client/src/index.ts",
      importNode("@acme/api", "value"),
    );
    expect(msgs[0]).toContain("import type");
  });
});

describe("element-types: default verdict", () => {
  it("default:allow widens an uncovered edge (web -> db becomes allowed)", () => {
    // Fresh root: this config differs from baseConfig, and the plugin memoizes
    // the compiled config per root.
    const r = makeWorkspace();
    const cfg = baseConfig() as Record<string, unknown>;
    cfg.default = "allow";
    expect(
      runRule("element-types", "packages/web/src/index.ts", importNode("@acme/db"), cfg, r),
    ).toEqual([]);
  });
});

describe("element-types: ignore", () => {
  it("skips a file matching an ignore pattern (web test file -> db not reported)", () => {
    // db is NOT allowed from web; but the importing file is ignored, so no report.
    expect(
      runRule("element-types", "packages/web/src/index.test.ts", importNode("@acme/db")),
    ).toEqual([]);
  });
});

describe("no-unknown", () => {
  it("flags a workspace specifier that resolves to no package", () => {
    const msgs = runRule("no-unknown", "packages/web/src/index.ts", importNode("@acme/nope"));
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("@acme/nope");
  });

  it("does not flag a real workspace package", () => {
    expect(runRule("no-unknown", "packages/web/src/index.ts", importNode("@acme/core"))).toEqual(
      [],
    );
  });

  it("ignores non-workspace specifiers (zod)", () => {
    expect(runRule("no-unknown", "packages/web/src/index.ts", importNode("zod"))).toEqual([]);
  });
});

describe("missing settings", () => {
  it("element-types is a no-op when settings.boundaries is absent", () => {
    // Fresh root: "no settings" is a distinct config state from baseConfig,
    // which the plugin memoizes per root.
    const r = makeWorkspace();
    const rule = (plugin.rules as any)["element-types"];
    const messages: string[] = [];
    const context = {
      id: "boundaries/element-types",
      filename: join(r, "packages/web/src/index.ts"),
      physicalFilename: join(r, "packages/web/src/index.ts"),
      cwd: r,
      options: [],
      settings: {},
      report: (d: { message?: string }) => messages.push(d.message ?? ""),
    };
    const visitor = rule.createOnce(context);
    if (typeof visitor.before === "function") visitor.before();
    visitor.ImportDeclaration?.(importNode("@acme/db"));
    expect(messages).toEqual([]);
  });
});
