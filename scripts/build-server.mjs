// Bundles the server entrypoints (web service, sync worker, migration CLI) into apps/server/dist.
// @ecc/core is bundled in; pg stays an external runtime dependency.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "apps/server/dist");
rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: {
    index: path.join(root, "apps/server/src/index.ts"),
    worker: path.join(root, "apps/server/src/worker.ts"),
    migrate: path.join(root, "apps/server/src/migrate-cli.ts"),
  },
  outdir: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["pg"],
  logLevel: "info",
});
