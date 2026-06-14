import { describe, expect, it } from "bun:test";

import { compileConfig, deriveWorkspaceScope } from "../src/config.ts";
import type { CompiledBoundaries } from "../src/config.ts";
import { evaluate } from "../src/engine.ts";

// A representative, valid `settings.boundaries` block (the public contract from
// the README). Reused across the happy-path tests; clone + tweak for edge cases.
function validRaw(): Record<string, unknown> {
  return {
    elements: [
      { type: "api-http", pattern: "apps/api/src/http/**" },
      { type: "api", pattern: "apps/api/**" },
      { type: "api-client", pattern: "apps/api-client/**" },
      { type: "core", pattern: "packages/core/**" },
    ],
    rules: [
      { from: "api", allow: ["core"] },
      { from: "api-http", allow: ["api", "core"] },
      {
        from: "api-client",
        allow: ["core"],
        importKind: "type",
        message: "api-client may import core only as `import type`.",
      },
    ],
    workspaceScope: "@scope/",
  };
}

describe("config: compileConfig — shape", () => {
  it("returns the compiled-config surface Step 4 consumes", () => {
    const c: CompiledBoundaries = compileConfig(validRaw());
    expect(Array.isArray(c.elements)).toBe(true);
    // table.ELEMENTS is the same ordered list the engine classifies against.
    expect(c.table.ELEMENTS).toBe(c.elements);
    expect(c.table.ALLOW).toBeDefined();
    expect(c.table.TYPE_ONLY_ALLOW).toBeDefined();
    expect(c.default).toBe("disallow");
    expect(Array.isArray(c.ignore)).toBe(true);
    expect(c.workspaceScope).toBe("@scope/");
    expect(typeof c.messageFor).toBe("function");
  });
});

describe("config: element pattern compiler (gotcha G6)", () => {
  it("compiles `dir/**` into a working matcher", () => {
    const c = compileConfig(validRaw());
    const core = c.elements.find((e) => e.type === "core");
    expect(core?.test("packages/core/index.ts")).toBe(true);
  });

  it("classifies a path EQUAL to the package dir (no trailing slash) — the G6 regression", () => {
    // A bare workspace specifier resolves to a package dir with no trailing
    // segment. `^prefix/` would miss it; `^prefix(/|$)` must match it.
    const c = compileConfig(validRaw());
    const core = c.elements.find((e) => e.type === "core");
    expect(core?.test("packages/core")).toBe(true);
  });

  it("does NOT let a sibling dir match (apps/api must not swallow apps/api-client)", () => {
    const c = compileConfig(validRaw());
    const api = c.elements.find((e) => e.type === "api");
    expect(api?.test("apps/api-client/src/x.ts")).toBe(false);
    expect(api?.test("apps/api/src/x.ts")).toBe(true);
  });

  it("respects first-match-wins ordering via the engine table (specific before parent)", () => {
    const c = compileConfig(validRaw());
    // Both `api-http` and `api` patterns prefix this path; the ordered list must
    // surface api-http first.
    const firstMatch = c.elements.find((e) => e.test("apps/api/src/http/app.ts"));
    expect(firstMatch?.type).toBe("api-http");
  });

  it("supports a bare directory pattern (no trailing /**)", () => {
    const c = compileConfig({
      elements: [{ type: "core", pattern: "packages/core" }],
      rules: [],
      workspaceScope: "@scope/",
    });
    const core = c.elements[0];
    expect(core?.test("packages/core")).toBe(true);
    expect(core?.test("packages/core/index.ts")).toBe(true);
    expect(core?.test("packages/core-utils/x.ts")).toBe(false);
  });

  it("escapes regex metacharacters in the literal portion", () => {
    // A dot in the path segment must be a literal dot, not 'any char'.
    const c = compileConfig({
      elements: [{ type: "dot", pattern: "packages/a.b/**" }],
      rules: [],
      workspaceScope: "@scope/",
    });
    const dot = c.elements[0];
    expect(dot?.test("packages/a.b/x.ts")).toBe(true);
    expect(dot?.test("packages/axb/x.ts")).toBe(false);
  });
});

describe("config: rules normalize into ALLOW / TYPE_ONLY_ALLOW", () => {
  it("puts value rules (no importKind) into ALLOW", () => {
    const c = compileConfig(validRaw());
    expect(c.table.ALLOW.api).toEqual(new Set(["core"]));
    expect(c.table.ALLOW["api-http"]).toEqual(new Set(["api", "core"]));
  });

  it("puts an importKind:'type' rule ONLY into TYPE_ONLY_ALLOW", () => {
    const c = compileConfig(validRaw());
    expect(c.table.TYPE_ONLY_ALLOW["api-client"]).toEqual(new Set(["core"]));
    expect(c.table.ALLOW["api-client"]).toBeUndefined();
  });

  it("treats importKind:'value' the same as omitting importKind", () => {
    const c = compileConfig({
      elements: [
        { type: "a", pattern: "a/**" },
        { type: "b", pattern: "b/**" },
      ],
      rules: [{ from: "a", allow: ["b"], importKind: "value" }],
      workspaceScope: "@scope/",
    });
    expect(c.table.ALLOW.a).toEqual(new Set(["b"]));
    expect(c.table.TYPE_ONLY_ALLOW.a).toBeUndefined();
  });

  it("unions multiple rules with the same `from` instead of overwriting", () => {
    const c = compileConfig({
      elements: [
        { type: "a", pattern: "a/**" },
        { type: "b", pattern: "b/**" },
        { type: "d", pattern: "d/**" },
      ],
      rules: [
        { from: "a", allow: ["b"] },
        { from: "a", allow: ["d"] },
      ],
      workspaceScope: "@scope/",
    });
    expect(c.table.ALLOW.a).toEqual(new Set(["b", "d"]));
  });

  it("lets the same `from` populate both maps independently (value + type rules)", () => {
    const c = compileConfig({
      elements: [
        { type: "a", pattern: "a/**" },
        { type: "b", pattern: "b/**" },
        { type: "d", pattern: "d/**" },
      ],
      rules: [
        { from: "a", allow: ["b"] },
        { from: "a", allow: ["d"], importKind: "type" },
      ],
      workspaceScope: "@scope/",
    });
    expect(c.table.ALLOW.a).toEqual(new Set(["b"]));
    expect(c.table.TYPE_ONLY_ALLOW.a).toEqual(new Set(["d"]));
  });
});

describe("config: end-to-end with the engine", () => {
  it("feeds the compiled table into evaluate() for allow / deny / type-only / self", () => {
    const { table } = compileConfig(validRaw());
    // value-allow
    expect(evaluate("api", "core", false, table).reason).toBe("value-allow");
    // disallow (edge absent everywhere)
    expect(evaluate("core", "api", false, table).allowed).toBe(false);
    // type-only allowed on a type import...
    expect(evaluate("api-client", "core", true, table).reason).toBe("type-allow");
    // ...but the same edge denied on a value import
    expect(evaluate("api-client", "core", false, table).allowed).toBe(false);
    // self
    expect(evaluate("api", "api", false, table).reason).toBe("self");
  });
});

describe("config: default", () => {
  it("defaults to 'disallow' when omitted", () => {
    const raw = validRaw();
    delete raw.default;
    expect(compileConfig(raw).default).toBe("disallow");
  });

  it("carries through an explicit 'allow'", () => {
    expect(compileConfig({ ...validRaw(), default: "allow" }).default).toBe("allow");
  });
});

describe("config: ignore", () => {
  it("compiles ignore globs into matchers usable by the Step-4 rule", () => {
    const c = compileConfig({
      ...validRaw(),
      ignore: ["**/*.test.ts", "packages/core/**"],
    });
    expect(c.ignore.length).toBe(2);
    // `**/*.test.ts` should match a test file at any depth.
    expect(c.ignore.some((m) => m.test("apps/api/src/x.test.ts"))).toBe(true);
    // `packages/core/**` should match files under core (and the bare dir).
    expect(c.ignore.some((m) => m.test("packages/core/index.ts"))).toBe(true);
    expect(c.ignore.some((m) => m.test("packages/core"))).toBe(true);
  });

  it("defaults to an empty ignore list", () => {
    const raw = validRaw();
    delete raw.ignore;
    expect(compileConfig(raw).ignore).toEqual([]);
  });
});

describe("config: messageFor", () => {
  it("returns the configured per-edge message", () => {
    const c = compileConfig(validRaw());
    expect(c.messageFor("api-client", "core")).toBe(
      "api-client may import core only as `import type`.",
    );
  });

  it("returns undefined for an edge with no custom message", () => {
    const c = compileConfig(validRaw());
    expect(c.messageFor("api", "core")).toBeUndefined();
  });
});

describe("config: workspaceScope", () => {
  it("uses an explicit settings.boundaries.workspaceScope", () => {
    expect(compileConfig(validRaw()).workspaceScope).toBe("@scope/");
  });

  it("derives the common scope prefix from discovered package names when omitted", () => {
    const raw = validRaw();
    delete raw.workspaceScope;
    const c = compileConfig(raw, {
      packageNames: ["@acme/core", "@acme/api", "@acme/api-client"],
    });
    expect(c.workspaceScope).toBe("@acme/");
  });

  it("throws an actionable error when workspaceScope is neither set nor derivable", () => {
    const raw = validRaw();
    delete raw.workspaceScope;
    expect(() => compileConfig(raw)).toThrow(/workspaceScope/);
  });

  it("deriveWorkspaceScope finds the shared @scope/ prefix", () => {
    expect(deriveWorkspaceScope(["@acme/core", "@acme/api"])).toBe("@acme/");
  });

  it("deriveWorkspaceScope returns null when names share no @scope/ prefix", () => {
    expect(deriveWorkspaceScope(["@acme/core", "@other/api"])).toBeNull();
    expect(deriveWorkspaceScope(["plain", "core"])).toBeNull();
    expect(deriveWorkspaceScope([])).toBeNull();
  });
});

describe("config: validation errors (actionable, specific)", () => {
  it("rejects a non-object config", () => {
    expect(() => compileConfig(null)).toThrow(/settings\.boundaries/);
    expect(() => compileConfig(42)).toThrow(/settings\.boundaries/);
  });

  it("rejects missing or empty `elements`", () => {
    expect(() => compileConfig({ rules: [], workspaceScope: "@s/" })).toThrow(/elements/);
    expect(() => compileConfig({ elements: [], rules: [], workspaceScope: "@s/" })).toThrow(
      /elements.*non-empty|non-empty.*elements/,
    );
  });

  it("rejects an element missing `type` or `pattern`", () => {
    expect(() =>
      compileConfig({
        elements: [{ pattern: "a/**" }],
        rules: [],
        workspaceScope: "@s/",
      }),
    ).toThrow(/type/);
    expect(() =>
      compileConfig({
        elements: [{ type: "a" }],
        rules: [],
        workspaceScope: "@s/",
      }),
    ).toThrow(/pattern/);
  });

  it("rejects a rule missing `from` or `allow`", () => {
    expect(() =>
      compileConfig({
        elements: [{ type: "a", pattern: "a/**" }],
        rules: [{ allow: ["a"] }],
        workspaceScope: "@s/",
      }),
    ).toThrow(/from/);
    expect(() =>
      compileConfig({
        elements: [{ type: "a", pattern: "a/**" }],
        rules: [{ from: "a" }],
        workspaceScope: "@s/",
      }),
    ).toThrow(/allow/);
  });

  it("rejects a rule.from referencing an unknown element type", () => {
    expect(() =>
      compileConfig({
        elements: [{ type: "a", pattern: "a/**" }],
        rules: [{ from: "ghost", allow: ["a"] }],
        workspaceScope: "@s/",
      }),
    ).toThrow(/ghost/);
  });

  it("rejects a rule.allow referencing an unknown element type", () => {
    expect(() =>
      compileConfig({
        elements: [{ type: "a", pattern: "a/**" }],
        rules: [{ from: "a", allow: ["ghost"] }],
        workspaceScope: "@s/",
      }),
    ).toThrow(/ghost/);
  });

  it("rejects a bad importKind", () => {
    expect(() =>
      compileConfig({
        elements: [
          { type: "a", pattern: "a/**" },
          { type: "b", pattern: "b/**" },
        ],
        rules: [{ from: "a", allow: ["b"], importKind: "typeof" }],
        workspaceScope: "@s/",
      }),
    ).toThrow(/importKind/);
  });

  it("rejects a bad `default`", () => {
    expect(() => compileConfig({ ...validRaw(), default: "maybe" })).toThrow(/default/);
  });

  it("rejects a duplicate element type", () => {
    expect(() =>
      compileConfig({
        elements: [
          { type: "a", pattern: "a/**" },
          { type: "a", pattern: "a2/**" },
        ],
        rules: [],
        workspaceScope: "@s/",
      }),
    ).toThrow(/duplicate|a/);
  });

  it("rejects an unsupported pattern shape rather than silently mis-matching", () => {
    // A mid-segment wildcard like `packages/*/src` is not in the supported set.
    expect(() =>
      compileConfig({
        elements: [{ type: "a", pattern: "packages/*/src/**" }],
        rules: [],
        workspaceScope: "@s/",
      }),
    ).toThrow(/pattern/);
  });
});
