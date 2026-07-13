import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/native-host.bundle.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  legalComments: "external"
});
