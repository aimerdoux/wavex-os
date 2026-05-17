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
  jsx: "automatic",
  // Externals — Paperclip's bare-specifier rewriter resolves these via
  // shim blob URLs at load time. Everything else gets inlined.
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  // Don't minify — easier to debug if something else breaks
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

console.log(`\n✓ bundled to ${OUT}`);
