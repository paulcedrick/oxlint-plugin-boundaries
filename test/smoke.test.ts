import { describe, expect, it } from "bun:test";

// Smoke test — the package's load-time contract.
//
// This asserts the SHIPPED public API: the default export is a valid oxlint
// plugin object named `boundaries` exposing the two rules. It is expected to
// FAIL during Step 1 (the entry point throws "not implemented yet") and to go
// green once Steps 2-4 assemble the real plugin. It is the tripwire that the
// extraction actually produced a loadable plugin — not just files on disk.

describe("oxlint-plugin-boundaries: public entry", () => {
  it("default-exports an oxlint plugin named 'boundaries'", async () => {
    const mod = await import("../src/index.ts");
    const plugin = mod.default;

    expect(plugin).toBeDefined();
    expect(plugin.meta?.name).toBe("boundaries");
  });

  it("registers the element-types and no-unknown rules", async () => {
    const mod = await import("../src/index.ts");
    const plugin = mod.default;

    const ruleIds = Object.keys(plugin.rules ?? {});
    expect(ruleIds).toContain("element-types");
    expect(ruleIds).toContain("no-unknown");
  });

  it("exposes createOnce on each rule (oxlint jsPlugins shape)", async () => {
    const mod = await import("../src/index.ts");
    const plugin = mod.default;

    for (const id of ["element-types", "no-unknown"] as const) {
      const rule = (plugin.rules as Record<string, { createOnce?: unknown }>)[id];
      expect(typeof rule?.createOnce).toBe("function");
    }
  });
});
