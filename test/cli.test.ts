import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { contractTests } from "@ambitious/kit/contract/contract-tests";
import { isRecord } from "@ambitious/kit/domain/json";

const binary = join(import.meta.dirname, "..", "dist", "ambitious-audit.mjs");
const owner = readFileSync(join(import.meta.dirname, "fixtures", "owner.json"), "utf8");
const reportSchema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "send_report.v1.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateReport = ajv.compile(reportSchema);

contractTests(binary);

const freshHome = (t: TestContext): string => {
  const home = mkdtempSync(join(tmpdir(), "ambitious-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

const run = (home: string, args: readonly string[], input = ""): { readonly exit: number | null; readonly data: unknown; readonly stdout: string } => {
  const result = spawnSync(process.execPath, [binary, ...args, "--now", "2026-11-15T00:00:00Z", "--seed", "1"], {
    encoding: "utf8",
    input,
    env: { ...process.env, AMBITIOUS_HOME: home },
  });
  const parsed: unknown = JSON.parse(result.stdout);
  return { exit: result.status, data: isRecord(parsed) ? parsed.data : undefined, stdout: result.stdout };
};

const dataOf = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("data");
  return value;
};

test("snapshot, diff, recommend and report build follow the limits", (t) => {
  const home = freshHome(t);
  const stored = run(home, ["snapshot"], owner);
  assert.equal(stored.exit, 0);
  const snapshotId = dataOf(stored.data).snapshotId;
  assert.equal(typeof snapshotId, "string");
  const again = run(home, ["snapshot"], owner);
  assert.equal(dataOf(again.data).snapshotId, snapshotId);

  const baseline = run(home, ["baseline", "set"], JSON.stringify({ snapshotId }));
  assert.equal(baseline.exit, 0);
  const diff = run(home, ["diff"], JSON.stringify({ to: snapshotId }));
  assert.deepEqual(dataOf(diff.data).changes, []);

  const recommendations = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data).recommendations;
  assert.ok(Array.isArray(recommendations) && recommendations.length <= 3 && recommendations.length >= 1);
  for (const item of recommendations) {
    assert.ok(isRecord(item) && Array.isArray(item.evidenceIds) && item.evidenceIds.length >= 1);
  }

  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true }));
  assert.equal(built.exit, 0);
  const payload = dataOf(built.data).payload;
  assert.equal(validateReport(payload), true);
  assert.equal(dataOf(built.data).reportId, dataOf(run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true })).data).reportId);
  const reportId = dataOf(built.data).reportId;
  assert.equal(typeof reportId, "string");
  const blocked = run(home, ["report", "mark"], JSON.stringify({ reportId, state: "sent", at: "2026-11-15T00:00:00Z" }));
  assert.equal(blocked.exit, 1);
  assert.match(blocked.stdout, /"code":"E_REVIEW_REQUIRED"/);
  assert.equal(run(home, ["report", "mark"], JSON.stringify({ reportId, state: "reviewed", at: "2026-11-15T00:00:00Z" })).exit, 0);
  assert.equal(run(home, ["report", "mark"], JSON.stringify({ reportId, state: "sent", at: "2026-11-15T00:00:00Z" })).exit, 0);
  const secondSend = run(home, ["report", "mark"], JSON.stringify({ reportId, state: "sent", at: "2026-11-15T00:01:00Z" }));
  assert.equal(secondSend.exit, 1);
  assert.match(secondSend.stdout, /"code":"E_TRANSITION"/);

  const after = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data).recommendations;
  assert.ok(Array.isArray(after) && Array.isArray(recommendations) && after.length < recommendations.length);
  const feedback = run(home, ["feedback", "build"], JSON.stringify({ text: "The report was useful.", from: "customer", reportId }));
  assert.equal(feedback.exit, 0);
  assert.equal(dataOf(dataOf(feedback.data).payload).schemaVersion, 1);
});
