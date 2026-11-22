import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import weekly from "../schemas/examples/collector.v2/valid/weekly-activity.json" with { type: "json" };

test("stock Ajv accepts every cent from $0.00 through $99.99 in the published snapshot schema", () => {
  const binary = join(import.meta.dirname, "..", "dist", "ambitious-audit.mjs");
  const printed = execFileSync(process.execPath, [binary, "schema", "snapshot"], { encoding: "utf8" });
  const { data } = JSON.parse(printed);
  const validate = new Ajv2020().compile(data.schema);
  const document = structuredClone(weekly);
  for (let cents = 0; cents <= 9999; cents++) {
    document.planUsage.extraCreditsLeftUsdCents = cents;
    assert.equal(validate(document), true, `Rejected ${cents} cents`);
  }
  document.planUsage.extraCreditsLeftUsdCents = 0.291 * 100;
  assert.equal(validate(document), false);
  assert.equal(validate.errors?.[0]?.instancePath, "/planUsage/extraCreditsLeftUsdCents");
});
