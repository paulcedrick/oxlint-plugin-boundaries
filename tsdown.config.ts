import { defineConfig } from "tsdown";

// Build the plugin from real TypeScript source to ESM `.js` + `.d.ts`.
//
// Why a build step at all (the in-repo Postpipe version shipped raw `.mjs`,
// gotcha G3): a published package can be consumed by oxlint running under any
// Node version. Raw `.ts` plugins only load on Node >= 22.18 / ^20.19 (native
// type-stripping), so shipping `.ts` would silently break older consumers.
// Strategy B — author in `.ts`, ship compiled `.js` — keeps the artifact
// loadable everywhere while letting us author with full types. `target` below
// pins the OUTPUT to the oldest Node we promise to support; tsdown itself
// requires Node >= 22.18 to *run* the build (CI/dev only, not consumers).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20.19",
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
