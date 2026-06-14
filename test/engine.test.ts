import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPath,
  classifySpecifier,
  classifyTarget,
  evaluate,
  toRelative,
} from "../src/engine.ts";
import type { BoundaryTable, Element, Verdict } from "../src/engine.ts";
import {
  discoverPackages,
  findWorkspaceRoot,
  getPackageIndex,
  resolveSpecifierDir,
  sep,
} from "../src/discover.ts";

// Small helper: build an Element from a path-prefix regex with the
// `^prefix(/|$)` semantics the engine relies on. A bare package directory (no
// trailing segment) must still classify, while a sibling like `apps/api-client`
// must NOT match an `apps/api` element.
function prefixElement(type: string, prefix: string): Element {
  const re = new RegExp(`^${prefix}(/|$)`);
  return { type, test: (relPath: string) => re.test(relPath) };
}

// Ordered specific-before-parent — first match wins.
const ELEMENTS: Element[] = [
  prefixElement("api-http", "apps/api/src/http"),
  prefixElement("api", "apps/api"),
  prefixElement("api-client", "apps/api-client"),
  prefixElement("core", "packages/core"),
];

const TABLE: BoundaryTable = {
  ELEMENTS,
  ALLOW: {
    api: new Set(["core"]),
    "api-http": new Set(["api", "core"]),
  },
  TYPE_ONLY_ALLOW: {
    "api-client": new Set(["core"]),
  },
};

describe("engine: toRelative", () => {
  it("normalizes an absolute path against a root to a forward-slashed relative", () => {
    expect(toRelative("/repo/apps/api/src/http/app.ts", "/repo")).toBe("apps/api/src/http/app.ts");
  });

  it("strips a trailing slash on the root", () => {
    expect(toRelative("/repo/apps/api", "/repo/")).toBe("apps/api");
  });

  it("returns '' when the path equals the root", () => {
    expect(toRelative("/repo", "/repo")).toBe("");
  });

  it("returns the path as-is when it is outside the root", () => {
    expect(toRelative("/other/place", "/repo")).toBe("/other/place");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(toRelative("\\repo\\apps\\api", "\\repo")).toBe("apps/api");
  });
});

describe("engine: classifyPath", () => {
  it("returns the first-matching element type for a nested path", () => {
    // Path is under apps/api/src/http -> matches the more-specific element first.
    expect(classifyPath("/repo/apps/api/src/http/app.ts", "/repo", ELEMENTS)).toBe("api-http");
  });

  it("falls through to the parent element when the specific one doesn't match", () => {
    expect(classifyPath("/repo/apps/api/src/db/client.ts", "/repo", ELEMENTS)).toBe("api");
  });

  it("returns null when nothing matches", () => {
    expect(classifyPath("/repo/apps/unknown/x.ts", "/repo", ELEMENTS)).toBeNull();
  });

  it("returns null when the path equals the root (empty relative)", () => {
    expect(classifyPath("/repo", "/repo", ELEMENTS)).toBeNull();
  });

  // Bare-directory prefix semantics — the critical correctness detail.
  it("classifies a path equal to a package dir with NO trailing slash", () => {
    expect(classifyPath("/repo/apps/api", "/repo", ELEMENTS)).toBe("api");
  });

  it("does NOT let a sibling (apps/api-client) match an apps/api element", () => {
    // Without the (/|$) boundary, `apps/api-client` would be caught by the
    // `apps/api` prefix. It must classify as api-client instead.
    expect(classifyPath("/repo/apps/api-client/src/x.ts", "/repo", ELEMENTS)).toBe("api-client");
  });
});

describe("engine: evaluate", () => {
  it("allows a self-import (same type)", () => {
    const v: Verdict = evaluate("api", "api", false, TABLE);
    expect(v).toEqual({ allowed: true, reason: "self" });
  });

  it("allows a value edge present in ALLOW", () => {
    expect(evaluate("api", "core", false, TABLE)).toEqual({
      allowed: true,
      reason: "value-allow",
    });
  });

  it("allows a type-only edge only when typeOnly is true and present in TYPE_ONLY_ALLOW", () => {
    expect(evaluate("api-client", "core", true, TABLE)).toEqual({
      allowed: true,
      reason: "type-allow",
    });
  });

  it("disallows that same type-only edge when typeOnly is false", () => {
    expect(evaluate("api-client", "core", false, TABLE)).toEqual({
      allowed: false,
      reason: "disallow",
    });
  });

  it("disallows an edge absent from every table", () => {
    expect(evaluate("core", "api", false, TABLE)).toEqual({
      allowed: false,
      reason: "disallow",
    });
  });

  it("prefers a value-allow over the type-only carve-out even on a type import", () => {
    // api -> core is a value edge; with typeOnly=true it should still report
    // value-allow (value rule checked before the type-only one).
    expect(evaluate("api", "core", true, TABLE)).toEqual({
      allowed: true,
      reason: "value-allow",
    });
  });
});

// --- discover.ts filesystem tests, backed by a tiny temp workspace ---

let fixtureRoot: string;

beforeAll(() => {
  // Build a minimal monorepo:
  //   <root>/package.json            (workspaces: ["apps/*", "packages/core"])
  //   <root>/apps/api/package.json   (name "@scope/api")
  //   <root>/apps/api-client/...     (name "@scope/api-client")
  //   <root>/packages/core/...       (name "@scope/core")
  fixtureRoot = mkdtempSync(join(tmpdir(), "oxbnd-"));

  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify({
      name: "root",
      private: true,
      workspaces: ["apps/*", "packages/core"],
    }),
  );

  const mkPkg = (relDir: string, name: string) => {
    const dir = join(fixtureRoot, relDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
    return dir;
  };

  mkPkg("apps/api", "@scope/api");
  mkPkg("apps/api-client", "@scope/api-client");
  mkPkg("packages/core", "@scope/core");

  // A nested source dir to start the workspace-root walk from.
  mkdirSync(join(fixtureRoot, "apps/api/src/http"), { recursive: true });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("discover: findWorkspaceRoot", () => {
  it("walks up from a nested dir to the nearest package.json with workspaces", () => {
    const start = join(fixtureRoot, "apps/api/src/http");
    expect(findWorkspaceRoot(start, "/nonexistent-fallback")).toBe(fixtureRoot);
  });

  it("returns the fallback when no workspaces ancestor exists", () => {
    const orphan = mkdtempSync(join(tmpdir(), "oxorphan-"));
    try {
      expect(findWorkspaceRoot(orphan, "/the-fallback")).toBe("/the-fallback");
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});

describe("discover: discoverPackages / getPackageIndex", () => {
  it("discovers every workspace package across array + literal globs", () => {
    const names = discoverPackages(fixtureRoot)
      .map((p) => p.name)
      .sort();
    expect(names).toEqual(["@scope/api", "@scope/api-client", "@scope/core"]);
  });

  it("builds a name -> dir index", () => {
    const index = getPackageIndex(fixtureRoot);
    expect(index.get("@scope/core")).toBe(join(fixtureRoot, "packages/core"));
    expect(index.get("@scope/api")).toBe(join(fixtureRoot, "apps/api"));
  });
});

describe("discover: resolveSpecifierDir", () => {
  it("resolves a bare exact package name to its dir", () => {
    const index = getPackageIndex(fixtureRoot);
    expect(resolveSpecifierDir("@scope/core", index)).toBe(join(fixtureRoot, "packages/core"));
  });

  it("resolves a subpath specifier to the longest-prefix package dir", () => {
    const index = getPackageIndex(fixtureRoot);
    expect(resolveSpecifierDir("@scope/core/utils/log", index)).toBe(
      join(fixtureRoot, "packages/core"),
    );
  });

  it("does NOT match @scope/api for @scope/api-client (boundary on name + '/')", () => {
    // `@scope/api-client` must resolve to api-client, not be swallowed by the
    // `@scope/api` prefix — the prefix is `name + "/"`, so `@scope/api/` ≠
    // `@scope/api-client`.
    const index = getPackageIndex(fixtureRoot);
    expect(resolveSpecifierDir("@scope/api-client", index)).toBe(
      join(fixtureRoot, "apps/api-client"),
    );
  });

  it("returns null for an unknown specifier", () => {
    const index = getPackageIndex(fixtureRoot);
    expect(resolveSpecifierDir("totally-unknown-pkg", index)).toBeNull();
  });
});

describe("engine: classifySpecifier / classifyTarget (integrated with discover)", () => {
  // Element table keyed on the FIXTURE's real dirs (apps/*, packages/core).
  const fixtureElements: Element[] = [
    prefixElement("api", "apps/api"),
    prefixElement("api-client", "apps/api-client"),
    prefixElement("core", "packages/core"),
  ];

  it("classifies a bare workspace specifier to its element type", () => {
    expect(classifySpecifier("@scope/core", fixtureRoot, fixtureElements)).toBe("core");
  });

  it("classifyTarget resolves a relative specifier against the importing file", () => {
    const fromFile = join(fixtureRoot, "apps/api/src/http/app.ts");
    const type = classifyTarget("../../../api-client/src/x.ts", fromFile, fixtureRoot, {
      elements: fixtureElements,
      workspaceScope: "@scope/",
    });
    expect(type).toBe("api-client");
  });

  it("classifyTarget resolves a bare workspace specifier within scope", () => {
    const fromFile = join(fixtureRoot, "apps/api/src/http/app.ts");
    expect(
      classifyTarget("@scope/core", fromFile, fixtureRoot, {
        elements: fixtureElements,
        workspaceScope: "@scope/",
      }),
    ).toBe("core");
  });

  it("classifyTarget returns null for an external (out-of-scope) dependency", () => {
    const fromFile = join(fixtureRoot, "apps/api/src/http/app.ts");
    expect(
      classifyTarget("zod", fromFile, fixtureRoot, {
        elements: fixtureElements,
        workspaceScope: "@scope/",
      }),
    ).toBeNull();
  });
});

describe("discover: sep re-export", () => {
  it("re-exports the platform path separator", () => {
    expect(typeof sep).toBe("string");
    expect(sep.length).toBe(1);
  });
});
