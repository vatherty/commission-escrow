// Standalone client build.
//
// Bundles src/main.tsx with Bun.build (production), compiles theme.css's
// Tailwind imports via bun-plugin-tailwind, and emits dist/index.html by
// copying ./index.html and rewriting its dev script tag to the built
// bundle (+ a stylesheet link for the built CSS). Bundle names are
// index-[hash].js / index-[hash].css; dist/index.html always points at
// the files this run produced.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";

/* Paths are anchored to this file's directory — the package script runs
   build.mjs from the standalone root, not from client/. */
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const result = await Bun.build({
  entrypoints: [here("./src/main.tsx")],
  outdir: here("./dist"),
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  naming: {
    entry: "index-[hash].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "[name]-[hash].[ext]",
  },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const baseName = (p) => p.split("/").pop();
const jsOut = result.outputs.find((o) => o.kind === "entry-point");
const cssOut = result.outputs.find((o) => o.path.endsWith(".css"));
if (!jsOut) {
  console.error("client build produced no JS entry point");
  process.exit(1);
}
const jsName = baseName(jsOut.path);
const cssName = cssOut ? baseName(cssOut.path) : null;

let html = readFileSync(here("./index.html"), "utf8");
const devTag = '<script src="./src/main.tsx" type="module"></script>';
if (!html.includes(devTag)) {
  console.error("client/index.html does not contain the expected dev script tag");
  process.exit(1);
}
html = html.replace(devTag, `<script src="./${jsName}" type="module"></script>`);
if (cssName) {
  html = html.replace("\n  </head>", `\n    <link rel="stylesheet" href="./${cssName}" />\n  </head>`);
}
writeFileSync(here("./dist/index.html"), html);

console.log(
  `client built: dist/${jsName}${cssName ? ` + dist/${cssName}` : ""} + dist/index.html`,
);
