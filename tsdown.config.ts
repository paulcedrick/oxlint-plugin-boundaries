import { defineConfig } from "tsdown";

// Build the plugin from real TypeScript source to ESM `.js` + `.d.ts`.
//
// Why a build step at all (the in-repo Postpipe version shipped raw `.mjs`,
// gotcha G3): even though this package now requires Node >= 24 (which strips
// TypeScript natively), shipping compiled `.js` keeps the published artifact a
// plain, dependency-free ESM module — no reliance on the consumer's Node having
// type-stripping enabled, and full `.d.ts` for type consumers. `target` below
// pins the OUTPUT to our supported Node floor.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  clean: true,
  // package.json is `"type": "module"`, so a `.js` file is already ESM. Force
  // the `.js`/`.d.ts` extension (tsdown defaults to `.mjs` under type:module)
  // so the emitted files match the `exports`/`types`/`main` paths declared in
  // package.json — otherwise publint/attw (and consumers) see a path mismatch.
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  // Fold the publish-time validators into the build so a broken `exports`
  // map or type-resolution problem fails locally, not after publishing.
  publint: true,
  // ESM-only on purpose — tell attw so it doesn't flag the (expected) "CJS
  // resolves to ESM" case for `require()` consumers under node16 resolution.
  attw: { profile: "esm-only" },
});
