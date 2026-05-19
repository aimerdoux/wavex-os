/** Bundle the plugin UI into a single ESM file Paperclip can load via
 *  blob URL. The host's bare-specifier rewriter only handles
 *  `@paperclipai/plugin-sdk/ui`, `react`, and `react/jsx-runtime` — so
 *  every other import must be inlined. Multi-file output from `tsc`
 *  breaks because nested `import "./foo.js"` paths can't resolve from
 *  a blob URL. esbuild bundles everything into one file. */

import { build } from "/Users/dylanriedweg/wavex-os/node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/lib/main.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const OUT = "./dist/ui/index.js";
mkdirSync(dirname(OUT), { recursive: true });

await build({
  entryPoints: ["./src/ui/index.tsx"],
  outfile: OUT,
  bundle: true,
  format: "esm",
  target: "es2022",
  // Classic transform (not "automatic"). Why: esbuild's automatic mode
  // wires every JSX call through React 19's prod `react/jsx-runtime`
  // (the only bare specifier Paperclip's host rewriter resolves). The
  // prod runtime doesn't tag elements with `_store.validated`, so React's
  // dev-mode reconciler emits false-positive "missing key" warnings on
  // every multi-child JSX. Classic transform calls React.createElement,
  // which validates correctly and produces zero false positives. Real
  // `.map()`-missing-key bugs still warn.
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  inject: ["./build-ui-react-shim.mjs"],
  // Override tsconfig.json's `jsx: react-jsx`. Without this, esbuild
  // respects the tsconfig setting and our jsx/jsxFactory options are
  // silently ignored.
  tsconfigRaw: { compilerOptions: { jsx: "react" } },
  // Externals — Paperclip's bare-specifier rewriter resolves these via
  // shim blob URLs at load time. Everything else gets inlined.
  // (`react/jsx-runtime` dropped: classic transform doesn't import it.)
  external: [
    "react",
    "react-dom",
    "@paperclipai/plugin-sdk/ui",
  ],
  // Don't minify — easier to debug if something else breaks
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

console.log(`\n✓ bundled to ${OUT}`);
