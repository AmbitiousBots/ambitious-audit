#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReportPayload } from "../src/domain/schema.ts";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = join(import.meta.dirname, "..");
const binary = join(root, "dist", "ambitious-audit.mjs");
const owner = readFileSync(join(root, "test", "fixtures", "owner.json"), "utf8");
const validateShape = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(root, "schemas", "send_report.v4.json"), "utf8")));
const verifyPayload = (payload) => {
  assert.ok(validateShape(payload), JSON.stringify(validateShape.errors));
  assert.ok(isReportPayload(payload), "The report failed the v4 field checks.");
};
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
const announcements = Array.from({ length: 12 }, (_, index) => ({
  id: `service-update-${index}`,
  publishedAt: "2026-11-15T00:00:00Z",
  priority: index === 11 ? "high" : "low",
  title: `  Service update ${index}: preserve spacing & punctuation!  `,
  body: "The service supplied this body; it must not enter the report.",
  url: null,
  extra: { ignored: true },
}));
announcements.push({ ...announcements[0], priority: "high", title: "A duplicate must not replace the first entry." });
const built = run(["report", "build"], JSON.stringify({ snapshotId: snapshot.snapshotId, reviewRequired: true, announcements }));
assert.equal(built.payload.schemaVersion, 4);
assert.deepEqual(built.payload.moduleVersions, { audit: "0.4.2" });
assert.deepEqual(built.payload.announcements, [11, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
  id: announcements[index].id,
  priority: announcements[index].priority,
  title: announcements[index].title,
})));
assert.ok(built.payload.findings.some((item) => item.severity === "high"));
assert.ok(built.payload.findings.some((item) => item.severity === "medium"));
assert.ok(built.payload.findings.some((item) => item.severity === "low"));
for (const item of built.payload.findings) assert.equal(item.priority, item.severity === "high" ? "high" : "low");
for (const item of built.payload.recommendations) {
  assert.equal(item.priority, ["failing-routine", "connector-needs-auth"].includes(item.id) ? "high" : "low");
}
assert.equal(fail(["report", "build"], JSON.stringify({
  snapshotId: snapshot.snapshotId,
  reviewRequired: true,
  announcements: [...announcements, { id: "invalid-after-limit", priority: "high", title: "" }],
})), 1);
verifyPayload(built.payload);
const again = run(["report", "build"], JSON.stringify({ snapshotId: snapshot.snapshotId, reviewRequired: true, announcements: [] }));
assert.deepEqual(again.payload, built.payload);
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
assert.deepEqual(unseenReport.payload.announcements, []);
assert.ok(unseenReport.payload.findings.every((item) => item.priority === "low"));
verifyPayload(unseenReport.payload);
if (unseenReport.payload.accountKind !== "unknown" || unseenReport.payload.counts.tasks.open !== null || !unseenReport.payload.summary.includes("role is unknown")) {
  stop("the report for an unobserved account did not say the role is unknown, or wrote a number for a count nobody saw");
}
const partial = run(["snapshot"], readFileSync(join(root, "test", "fixtures", "partial.json"), "utf8"));
const partialAdvice = run(["recommend"], JSON.stringify({ snapshotId: partial.snapshotId }));
const partialIds = partialAdvice.recommendations.map((item) => item.id);
if (partialAdvice.mode !== "partial" || !partialIds.includes("connector-needs-auth") || partialAdvice.recommendations.some((item) => item.evidenceIds.length < 1) || partialIds.length > 3) {
  stop("an account with an unknown role got no evidence-backed sign-in advice for the bot's own connector, or more than three recommendations");
}
if (partialIds.includes("failing-routine") || !partialAdvice.withheld.includes("failing-routine")) stop("an account with an unknown role got advice that depends on the role");
const zero = JSON.parse(owner);
zero.tasks = { open: null, stale7d: null, blocked: null };
const refused = spawnSync(process.execPath, [binary, "snapshot", "--now", "2026-11-15T00:00:00Z", "--seed", "1"], { encoding: "utf8", input: JSON.stringify(zero), env: { ...process.env, AMBITIOUS_HOME: home } });
const refusal = JSON.parse(refused.stdout).errors[0];
if (refused.status !== 1 || refusal.code !== "E_INPUT_SCHEMA" || !refusal.message.includes("/visibility/5/seen") || !refusal.message.includes("rule: null-needs-visibility-gap")) {
  stop("a null count with no visibility gap was accepted, or the error did not name the field and the rule");
}
const sharesDocument = JSON.parse(readFileSync(join(root, "test", "fixtures", "shares.json"), "utf8"));
const shares = run(["snapshot"], JSON.stringify(sharesDocument));
const sharesReport = run(["report", "build"], JSON.stringify({ snapshotId: shares.snapshotId, reviewRequired: false }));
verifyPayload(sharesReport.payload);
assert.ok(sharesReport.payload.recommendations.length > 0);
assert.ok(sharesReport.payload.recommendations.every((item) => item.priority === "low"));
const feedback = run(["feedback", "build"], JSON.stringify({ text: "Feedback about the service generally.", from: "customer" }));
assert.equal(Object.hasOwn(feedback.payload, "reportId"), false);
const pausedFindings = run(["findings"], JSON.stringify({ snapshotId: shares.snapshotId })).findings.filter((item) => item.ruleId.startsWith("paused-routine"));
const longPause = pausedFindings.find((item) => item.ruleId === "paused-routine");
const unknownPause = pausedFindings.find((item) => item.ruleId === "paused-routine-since-unknown");
if (pausedFindings.length !== 2 || longPause?.evidenceIds.join() !== "ev-1" || unknownPause?.evidenceIds.join() !== "ev-2" || unknownPause.severity !== "low" || /days|more than/.test(unknownPause.summary)) {
  stop("paused routines were not reported as: one paused for more than 7 days by its pause time, one paused since an unknown time with no duration, and none for the routine created paused the day before");
}
if (shares.normalized.usageOther?.share !== 0.08 || shares.normalized.weeklyLimitUsed?.percent !== 37 || shares.normalized.bots[0].usage?.share !== 0.62 || shares.normalized.bots[2].usage !== null) {
  stop("usage given as shares, the summed line for the other bots or the weekly limit was not stored as written");
}
if (run(["findings"], JSON.stringify({ snapshotId: shares.snapshotId })).findings.some((item) => item.ruleId === "bot-unused")) stop("a bot the usage report did not list was called unused");
sharesDocument.visibility = sharesDocument.visibility.map((entry) => (entry.signal === "usage" ? { ...entry, seen: true } : entry));
if (fail(["snapshot"], JSON.stringify(sharesDocument)) !== 1) stop("usage was accepted as seen although one bot's usage was not listed");
if (run(["schema"]).schema.$id !== "urn:ambitious:audit:schema:collector:v2") stop("schema did not print the collector schema");
const v2 = run(["snapshot"], readFileSync(join(root, "schemas/examples/collector.v2/valid/weekly-activity.json"), "utf8"));
const v4 = run(["report", "build"], JSON.stringify({ snapshotId: v2.snapshotId, reviewRequired: false }));
verifyPayload(v4.payload);
assert.equal(v4.payload.planUsage.extraCreditsLeftUsd, 0.29);
assert.equal(isReportPayload({ ...v4.payload, planUsage: { ...v4.payload.planUsage, extraCreditsLeftUsd: 0.291 } }), false);
assert.deepEqual(v4.payload, JSON.parse(readFileSync(join(root, "dist/weekly-report.v4.json"), "utf8")));
assert.deepEqual(run(["schema", "send", "report"]).schema.$id, "urn:ambitious:audit:schema:send_report:v4");
process.stdout.write(`verify/audit: ok. report ${built.reportId}, ${recommendations.length} recommendation(s)\n`);
