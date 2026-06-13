// Public entry point for oxlint-plugin-boundaries.
//
// Step 1 (scaffold) intentionally ships an EMPTY plugin (no rules) so the smoke
// test in test/smoke.test.ts fails for a precise reason — the two rules are not
// registered yet. The real plugin is assembled in Steps 2-4 of the handoff:
//   - Step 2: lift the generic engine (engine.ts + discover.ts) from Postpipe.
//   - Step 3: add the config layer (config.ts) reading settings.boundaries.
//   - Step 4: generalize the two rules (element-types, no-unknown) here.
//
// Target shape (verified against the Postpipe Plan-B plugin and @oxlint/plugins):
//   { meta: { name: "boundaries" }, rules: { "element-types": {...}, "no-unknown": {...} } }

const plugin = {
  meta: { name: "boundaries" },
  // Empty until Step 4. The smoke test asserts "element-types" and "no-unknown"
  // are present, so it fails here — that failure IS the entry point into Step 4.
  rules: {},
};

export default plugin;
