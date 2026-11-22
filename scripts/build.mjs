import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleOptions } from "@ambitious/kit/build/bundle-options";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
await build(bundleOptions({ root, module: "audit" }));
await copyFile(join(root, "schemas/examples/send_report.v4/valid/weekly-activity.json"), join(root, "dist/weekly-report.v4.json"));
