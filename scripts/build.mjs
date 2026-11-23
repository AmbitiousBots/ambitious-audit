import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleOptions } from "@ambitious/kit/build/bundle-options";
import { build } from "esbuild";
import manifest from "../package.json" with { type: "json" };

const root = join(import.meta.dirname, "..");
await build(bundleOptions({ root, module: "audit" }));
await copyFile(join(root, "schemas/examples/send_report.v4/valid/weekly-activity.json"), join(root, "dist/weekly-report.v4.json"));

if (process.argv.includes("--release")) {
  const directory = join(root, "dist", manifest.version);
  const asset = `${manifest.name}-${manifest.version}.mjs`;
  const bundle = await readFile(join(root, "dist", `${manifest.name}.mjs`));
  const checksum = `${createHash("sha256").update(bundle).digest("hex")}  ${asset}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, asset), bundle);
  await writeFile(join(directory, "SHA256SUMS"), checksum);
  process.stdout.write(checksum);
}
