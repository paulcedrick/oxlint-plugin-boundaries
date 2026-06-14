// End-to-end suite — drives the REAL oxlint CLI over a synthetic workspace.
//
// Unlike rules.test.ts (which calls createOnce with faked nodes), this proves
// the published artifact actually enforces boundaries when oxlint loads it as a
// jsPlugin and passes `settings.boundaries` through. It is the real-world bar:
// the same kind of allow/deny/type-only/unknown checks the original
// eslint-plugin-boundaries config guaranteed, now under oxlint.
//
// Strategy (mirrors the Postpipe regression suite):
//   - Build the plugin to dist/ first (oxlint loads the compiled .js, matching
//     what consumers get from npm — Strategy B).
//   - Write a synthetic monorepo to a temp dir: a root package.json with
//     `workspaces`, several @acme/* packages, an `.oxlintrc.json` carrying
//     `jsPlugins` (pointing at the built dist, relative to the config — G9) and
//     `settings.boundaries`, and per-case fixture files.
//   - Run `oxlint -c <config> <fixture>` via spawnSync; assert on status+output.
//   - oxlint emits the rule id as `boundaries(element-types)` (plugin(rule)).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const oxlintBin = resolve(repoRoot, "node_modules/.bin/oxlint");
const builtPlugin = resolve(repoRoot, "dist/index.js");

let workspace: string;
let configPath: string;

// The boundaries config the synthetic workspace enforces — a slice of the
// Postpipe matrix exercising every behavior the ESLint plugin guaranteed.
const boundariesSettings = {
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
      message: "api-client may import api ONLY as `import type`.",
    },
  ],
  default: "disallow",
  ignore: ["**/*.test.ts", "**/*.spec.ts"],
  workspaceScope: "@acme/",
};

function writePkg(dir: string, name: string): void {
  mkdirSync(join(workspace, dir, "src"), { recursive: true });
  writeFileSync(join(workspace, dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
}

// Write a fixture file containing a single import line and return its abs path.
function fixture(relPath: string, importLine: string): string {
  const abs = join(workspace, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${importLine}\nexport const _ = 1;\n`);
  return abs;
}

beforeAll(() => {
  // Ensure the plugin is built (oxlint loads dist/index.js).
  if (!existsSync(builtPlugin)) {
    execSync("bun run build", { cwd: repoRoot, stdio: "ignore" });
  }

  workspace = mkdtempSync(join(tmpdir(), "oxb-e2e-"));
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({
      name: "synthetic-root",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  writePkg("packages/core", "@acme/core");
  writePkg("packages/db", "@acme/db");
  writePkg("packages/schemas", "@acme/schemas");
  writePkg("packages/web", "@acme/web");
  writePkg("packages/api", "@acme/api");
  writePkg("packages/api-client", "@acme/api-client");

  // jsPlugins path is resolved RELATIVE TO THE CONFIG FILE (G9). The config
  // lives at the workspace root, so point at the absolute built plugin to be
  // robust regardless of cwd.
  configPath = join(workspace, ".oxlintrc.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        plugins: [],
        jsPlugins: [builtPlugin],
        settings: { boundaries: boundariesSettings },
        rules: {
          "boundaries/element-types": "error",
          "boundaries/no-unknown": "error",
        },
        ignorePatterns: ["**/node_modules/**"],
      },
      null,
      2,
    ),
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

type LintRun = { status: number | null; output: string };

function lint(fixturePath: string, opts: { cwd?: string } = {}): LintRun {
  const result = spawnSync(oxlintBin, ["-c", configPath, fixturePath], {
    cwd: opts.cwd ?? workspace,
    encoding: "utf8",
  });
  return {
    status: result.status,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

const ELEMENT_TYPES_RULE = "boundaries(element-types)";
const NO_UNKNOWN_RULE = "boundaries(no-unknown)";

function expectRejected(run: LintRun, fromType: string, toType: string): void {
  expect(run.status).not.toBe(0);
  expect(run.output).toContain(ELEMENT_TYPES_RULE);
  expect(run.output).toContain(`'${fromType}'`);
  expect(run.output).toContain(`'${toType}'`);
}

function expectClean(run: LintRun): void {
  expect(run.output).not.toContain(ELEMENT_TYPES_RULE);
  expect(run.output).not.toContain(NO_UNKNOWN_RULE);
  expect(run.status).toBe(0);
}

describe("e2e: element-types value edges (bare workspace specifiers)", () => {
  test("web -> schemas is allowed", () => {
    expectClean(lint(fixture("packages/web/src/ok-schemas.ts", `import "@acme/schemas";`)));
  });

  test("web -> api-client is allowed", () => {
    expectClean(lint(fixture("packages/web/src/ok-client.ts", `import "@acme/api-client";`)));
  });

  test("web -> db is rejected (not in allow-list)", () => {
    expectRejected(lint(fixture("packages/web/src/bad-db.ts", `import "@acme/db";`)), "web", "db");
  });

  test("core -> db is allowed; core -> web is rejected", () => {
    expectClean(lint(fixture("packages/core/src/ok-db.ts", `import "@acme/db";`)));
    expectRejected(
      lint(fixture("packages/core/src/bad-web.ts", `import "@acme/web";`)),
      "core",
      "web",
    );
  });

  test("db -> core is rejected (db may only reach schemas)", () => {
    expectRejected(
      lint(fixture("packages/db/src/bad-core.ts", `import "@acme/core";`)),
      "db",
      "core",
    );
  });
});

describe("e2e: self-imports and external deps", () => {
  test("relative self-import within core is allowed", () => {
    // sibling file in the same package; create the target so resolution is real
    fixture("packages/core/src/helper.ts", `export const h = 1;`);
    expectClean(lint(fixture("packages/core/src/ok-self.ts", `import "./helper.ts";`)));
  });

  test("external dependency (zod) is ignored", () => {
    expectClean(lint(fixture("packages/web/src/ok-external.ts", `import "zod";`)));
  });
});

describe("e2e: type-only carve-out (api-client -> api)", () => {
  test("VALUE import of @acme/api from api-client is rejected (with the custom message)", () => {
    // This edge configures a custom `message`, so the diagnostic shows that text
    // instead of the default "'from' is not allowed to import 'to'." form —
    // proving per-edge messages flow through real oxlint.
    const run = lint(
      fixture("packages/api-client/src/bad-value.ts", `import { x } from "@acme/api";`),
    );
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(ELEMENT_TYPES_RULE);
    expect(run.output).toContain("api-client may import api ONLY as `import type`.");
  });

  test("`import type` of @acme/api from api-client is allowed", () => {
    expectClean(
      lint(fixture("packages/api-client/src/ok-type.ts", `import type { X } from "@acme/api";`)),
    );
  });
});

describe("e2e: no-unknown", () => {
  test("a typo'd @acme/* specifier is flagged", () => {
    const run = lint(fixture("packages/web/src/bad-unknown.ts", `import "@acme/nope";`));
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(NO_UNKNOWN_RULE);
    expect(run.output).toContain("@acme/nope");
  });

  test("a real workspace package is not flagged by no-unknown", () => {
    const run = lint(fixture("packages/web/src/ok-known.ts", `import "@acme/schemas";`));
    expect(run.output).not.toContain(NO_UNKNOWN_RULE);
  });
});

describe("e2e: cwd-independence", () => {
  test("classification is the same when oxlint runs from a workspace subdir", () => {
    const f = fixture("packages/db/src/bad-core-subdir.ts", `import "@acme/core";`);
    // Run from inside packages/db rather than the workspace root.
    expectRejected(lint(f, { cwd: join(workspace, "packages", "db") }), "db", "core");
  });
});
