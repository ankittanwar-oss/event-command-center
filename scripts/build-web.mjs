// Bundles the frontend into apps/web/dist (index.html, styles.css, app.js).
import { build, context } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/web/dist");
const watch = process.argv.includes("--watch");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// copy static files (read/write rather than cpSync, which fails on some mounted filesystems)
for (const f of readdirSync(path.join(root, "apps/web/public"))) {
  writeFileSync(path.join(out, f), readFileSync(path.join(root, "apps/web/public", f)));
}

const options = {
  entryPoints: [path.join(root, "apps/web/src/main.ts")],
  outfile: path.join(out, "app.js"),
  bundle: true,
  format: "esm",
  target: ["es2020", "chrome100", "safari15", "firefox100"],
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
