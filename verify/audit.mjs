#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = join(import.meta.dirname, "..");
const binary = join(root, "dist", "ambitious-audit.mjs");
const owner = readFileSync(join(root, "test", "fixtures", "owner.json"), "utf8");
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(root, "schemas", "send_report.v2.json"), "utf8")));
const home = process.env.AMBITIOUS_HOME;
if (home === undefined || home === "") {
  process.stderr.write("verify/audit: AMBITIOUS_HOME is not set.\n");
  process.exit(1);
}

const run = (args, input = "") => {
  const result = spawnSync(process.execPath, [binary, ...args, "--now", "2026-11-15T00:00:00Z", "--seed", "1"], {
    encoding: "utf8",
    input,
    env: { ...process.env, AMBITIOUS_HOME: home },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(`verify/audit: ${args.join(" ")} exited ${result.status}\n`);
    process.exit(1);
  }
  return JSON.parse(result.stdout).data;
};

const fail = (runArgs, input) => {
  const result = spawnSync(process.execPath, [binary, ...runArgs, "--now", "2026-11-15T00:00:00Z", "--seed", "1"], {
    encoding: "utf8",
    input,
    env: { ...process.env, AMBITIOUS_HOME: home },
  });
  return result.status;
};

const snapshot = run(["snapshot"], owner);
const diff = run(["diff"], JSON.stringify({ to: snapshot.snapshotId, from: run(["baseline", "set"], JSON.stringify({ snapshotId: snapshot.snapshotId })).baselineId }));
if (diff.changes.length !== 0) {
  process.stderr.write("verify/audit: diff of a snapshot with itself was not empty\n");
  process.exit(1);
}
const recommendations = run(["recommend"], JSON.stringify({ snapshotId: snapshot.snapshotId })).recommendations;
if (recommendations.length > 3 || recommendations.some((item) => item.evidenceIds.length < 1)) {
  process.stderr.write("verify/audit: recommendations broke the limit or cited no evidence\n");
  process.exit(1);
}
const built = run(["report", "build"], JSON.stringify({ snapshotId: snapshot.snapshotId, reviewRequired: true }));
if (!validate(built.payload)) {
  process.stderr.write(`verify/audit: payload rejected: ${JSON.stringify(validate.errors)}\n`);
  process.exit(1);
}
const again = run(["report", "build"], JSON.stringify({ snapshotId: snapshot.snapshotId, reviewRequired: true }));
if (again.reportId !== built.reportId) {
  process.stderr.write("verify/audit: the same snapshot and seed did not return the same report id\n");
  process.exit(1);
}
if (fail(["report", "mark"], JSON.stringify({ reportId: built.reportId, state: "sent", at: "2026-11-15T00:00:00Z" })) !== 1) {
  process.stderr.write("verify/audit: a report was marked sent before review\n");
  process.exit(1);
}
run(["report", "mark"], JSON.stringify({ reportId: built.reportId, state: "reviewed", at: "2026-11-15T00:00:00Z" }));
run(["report", "mark"], JSON.stringify({ reportId: built.reportId, state: "sent", at: "2026-11-15T00:00:00Z" }));
if (fail(["report", "mark"], JSON.stringify({ reportId: built.reportId, state: "sent", at: "2026-11-15T00:01:00Z" })) !== 1) {
  process.stderr.write("verify/audit: a report was marked sent twice\n");
  process.exit(1);
}
const stop = (message) => {
  process.stderr.write(`verify/audit: ${message}\n`);
  process.exit(1);
};
const unseen = run(["snapshot"], readFileSync(join(root, "test", "fixtures", "nothing-observed.json"), "utf8"));
const unseenFindings = run(["findings"], JSON.stringify({ snapshotId: unseen.snapshotId }));
if (unseenFindings.mode !== "partial" || unseenFindings.findings.length === 0 || unseenFindings.findings.some((item) => item.kind !== "visibility")) {
  stop("an account where nothing was observed produced a finding that is not about visibility");
}
if (run(["recommend"], JSON.stringify({ snapshotId: unseen.snapshotId })).recommendations.length !== 0) stop("an account where nothing was observed got a recommendation");
const unseenReport = run(["report", "build"], JSON.stringify({ snapshotId: unseen.snapshotId, reviewRequired: true }));
if (!validate(unseenReport.payload)) stop(`payload for an unobserved account rejected: ${JSON.stringify(validate.errors)}`);
if (unseenReport.payload.accountKind !== "unknown" || unseenReport.payload.counts.tasks.open !== null || !unseenReport.payload.summary.includes("role is unknown")) {
  stop("the report for an unobserved account did not say the role is unknown, or wrote a number for a count nobody saw");
}
const zero = JSON.parse(owner);
zero.tasks = { open: null, stale7d: null, blocked: null };
const refused = spawnSync(process.execPath, [binary, "snapshot", "--now", "2026-11-15T00:00:00Z", "--seed", "1"], { encoding: "utf8", input: JSON.stringify(zero), env: { ...process.env, AMBITIOUS_HOME: home } });
const refusal = JSON.parse(refused.stdout).errors[0];
if (refused.status !== 1 || refusal.code !== "E_INPUT_SCHEMA" || !refusal.message.includes("/visibility/5/seen") || !refusal.message.includes("rule: null-needs-visibility-gap")) {
  stop("a null count with no visibility gap was accepted, or the error did not name the field and the rule");
}
if (run(["schema"]).schema.$id !== "urn:ambitious:audit:schema:collector:v1") stop("schema did not print the collector schema");
process.stdout.write(`verify/audit: ok. report ${built.reportId}, ${recommendations.length} recommendation(s)\n`);
