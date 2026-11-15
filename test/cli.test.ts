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
const reportSchema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "send_report.v2.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateReport = ajv.compile(reportSchema);

contractTests(binary);

const freshHome = (t: TestContext): string => {
  const home = mkdtempSync(join(tmpdir(), "ambitious-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

type Ran = { readonly exit: number | null; readonly data: unknown; readonly errors: readonly unknown[]; readonly stdout: string };

const run = (home: string, args: readonly string[], input = ""): Ran => {
  const result = spawnSync(process.execPath, [binary, ...args, "--now", "2026-11-15T00:00:00Z", "--seed", "1"], {
    encoding: "utf8",
    input,
    env: { ...process.env, AMBITIOUS_HOME: home },
  });
  const parsed: unknown = JSON.parse(result.stdout);
  const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
  return { exit: result.status, data: isRecord(parsed) ? parsed.data : undefined, errors, stdout: result.stdout };
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

test("three failed marks then another mark exhausts attempts", (t) => {
  const home = freshHome(t);
  const snapshotId = dataOf(run(home, ["snapshot"], owner).data).snapshotId;
  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false }));
  assert.equal(built.exit, 0);
  const reportId = dataOf(built.data).reportId;
  for (const at of ["2026-11-15T00:00:00Z", "2026-11-15T00:01:00Z", "2026-11-15T00:02:00Z"]) {
    assert.equal(run(home, ["report", "mark"], JSON.stringify({ reportId, state: "failed", at })).exit, 0);
  }
  const exhausted = run(home, ["report", "mark"], JSON.stringify({ reportId, state: "failed", at: "2026-11-15T00:03:00Z" }));
  assert.equal(exhausted.exit, 1);
  assert.match(exhausted.stdout, /"code":"E_ATTEMPTS_EXHAUSTED"/);
});

test("a sent report refuses a following failed mark", (t) => {
  const home = freshHome(t);
  const snapshotId = dataOf(run(home, ["snapshot"], owner).data).snapshotId;
  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false }));
  assert.equal(built.exit, 0);
  const reportId = dataOf(built.data).reportId;
  assert.equal(run(home, ["report", "mark"], JSON.stringify({ reportId, state: "sent", at: "2026-11-15T00:00:00Z" })).exit, 0);
  const failed = run(home, ["report", "mark"], JSON.stringify({ reportId, state: "failed", at: "2026-11-15T00:01:00Z" }));
  assert.equal(failed.exit, 1);
  assert.match(failed.stdout, /"code":"E_TRANSITION"/);
});

test("rebuilding a built report can ask for a review and refuses any other mismatch", (t) => {
  const home = freshHome(t);
  const snapshotId = dataOf(run(home, ["snapshot"], owner).data).snapshotId;
  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false }));
  assert.equal(built.exit, 0);
  const reportId = dataOf(built.data).reportId;
  const upgraded = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true }));
  assert.equal(upgraded.exit, 0);
  assert.equal(dataOf(upgraded.data).reportId, reportId);
  const next = dataOf(upgraded.data).next;
  assert.ok(isRecord(next) && next.kind === "waitForReview");
  const sent = run(home, ["report", "mark"], JSON.stringify({ reportId, state: "sent", at: "2026-11-15T00:00:00Z" }));
  assert.equal(sent.exit, 1);
  assert.match(sent.stdout, /"code":"E_REVIEW_REQUIRED"/);
  const same = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true }));
  assert.equal(same.exit, 0);
  const downgrade = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false }));
  assert.equal(downgrade.exit, 1);
  assert.match(downgrade.stdout, /"code":"E_REVIEW_REQUIRED"/);
  assert.equal(run(home, ["report", "mark"], JSON.stringify({ reportId, state: "reviewed", at: "2026-11-15T00:00:00Z" })).exit, 0);
  const afterReview = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false }));
  assert.equal(afterReview.exit, 1);
  assert.match(afterReview.stdout, /"code":"E_REVIEW_REQUIRED"/);
});

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const changed = (text: string, change: (document: Record<string, unknown>) => void): string => {
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error("fixture");
  const copy = { ...document };
  change(copy);
  return JSON.stringify(copy);
};

const errorTexts = (ran: Ran): readonly { readonly code: unknown; readonly message: string; readonly hint: string }[] =>
  ran.errors.flatMap((entry) => (isRecord(entry) && typeof entry.message === "string" && typeof entry.hint === "string" ? [{ code: entry.code, message: entry.message, hint: entry.hint }] : []));

const listOf = (value: unknown): readonly Readonly<Record<string, unknown>>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

test("a collector that observed nothing yields only visibility findings and no recommendation", (t) => {
  const home = freshHome(t);
  const stored = run(home, ["snapshot"], fixture("nothing-observed.json"));
  assert.equal(stored.exit, 0, stored.stdout);
  const snapshotId = dataOf(stored.data).snapshotId;
  const found = dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data);
  assert.equal(found.mode, "partial");
  const findings = listOf(found.findings);
  assert.equal(findings.length, 9);
  assert.deepEqual([...new Set(findings.map((finding) => finding.kind))], ["visibility"]);
  const recommended = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data);
  assert.deepEqual(recommended.recommendations, []);
  assert.deepEqual(recommended.withheld, []);

  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true }));
  assert.equal(built.exit, 0, built.stdout);
  const payload = dataOf(dataOf(built.data).payload);
  assert.equal(validateReport(payload), true);
  assert.equal(payload.accountKind, "unknown");
  assert.deepEqual(dataOf(payload.counts).tasks, { open: null, stale7d: null, blocked: null });
  assert.deepEqual(dataOf(payload.counts).pages, { count: null, updated7d: null });
  assert.match(String(payload.summary), /The account role is unknown/);
  assert.match(String(payload.summary), /Not observed: .*task counts.*page counts/);
});

test("a partly observed account with an unknown role gets advice about its own connectors and has role-dependent recommendations withheld", (t) => {
  const home = freshHome(t);
  const stored = run(home, ["snapshot"], fixture("partial.json"));
  assert.equal(stored.exit, 0, stored.stdout);
  const snapshotId = dataOf(stored.data).snapshotId;
  const findings = listOf(dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data).findings);
  const fromRules = findings.filter((finding) => finding.kind === "rule");
  assert.deepEqual(fromRules.map((finding) => finding.ruleId), ["failing-routine", "connector-needs-auth", "connector-needs-grant", "stale-tasks"]);
  assert.deepEqual(fromRules.map((finding) => finding.withheld), ["roleUnknown", undefined, undefined, undefined]);
  assert.deepEqual(
    findings.filter((finding) => finding.kind === "visibility").map((finding) => finding.ruleId),
    ["visibility-transcripts", "visibility-usage", "visibility-audit-log", "visibility-account-role", "visibility-pages", "visibility-bot-activity"],
  );

  const recommended = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data);
  assert.equal(recommended.mode, "partial");
  assert.deepEqual(listOf(recommended.recommendations).map((item) => [item.id, item.evidenceIds]), [
    ["connector-needs-auth", ["ev-4"]],
    ["connector-needs-grant", ["ev-3"]],
    ["stale-tasks", ["ev-2"]],
  ]);
  assert.deepEqual(recommended.withheld, ["failing-routine"]);

  const payload = dataOf(dataOf(run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: false })).data).payload);
  assert.equal(validateReport(payload), true);
  assert.deepEqual(dataOf(payload.counts).connectors, { ok: 0, needsAuth: 1, needsGrant: 1, initializing: 1, error: 0 });
  assert.deepEqual(dataOf(payload.counts).tasks, { open: 14, stale7d: 3, blocked: 1 });
  assert.deepEqual(dataOf(payload.counts).pages, { count: null, updated7d: null });
  assert.ok(listOf(payload.evidence).some((item) => item.id === "ev-2" && item.source === "tasks"));
  assert.deepEqual(listOf(payload.recommendations).map((item) => item.id), ["connector-needs-auth", "connector-needs-grant", "stale-tasks"]);
  assert.match(String(payload.summary), /recommendations that depend on it are withheld \(1 in this report\)/);
});

test("with an unknown role, three connectors that need a sign-in give one sign-in recommendation citing all three, and nothing else", (t) => {
  const home = freshHome(t);
  const document = changed(fixture("partial.json"), (copy) => {
    copy.connectors = ["calendar", "documents", "mail"].map((name) => ({ name, status: "needsAuth" }));
    copy.tasks = { open: 14, stale7d: 0, blocked: 1 };
    copy.evidence = [
      { id: "ev-1", kind: "excerpt", text: "The routine stopped with an error.", source: "routine-2" },
      { id: "ev-2", kind: "excerpt", text: "calendar: sign in again.", source: "calendar" },
      { id: "ev-3", kind: "excerpt", text: "documents: sign in again.", source: "documents" },
      { id: "ev-4", kind: "excerpt", text: "mail: sign in again.", source: "mail" },
    ];
  });
  const stored = run(home, ["snapshot"], document);
  assert.equal(stored.exit, 0, stored.stdout);
  const snapshotId = dataOf(stored.data).snapshotId;

  const found = dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data);
  assert.equal(found.mode, "partial");
  assert.deepEqual(
    listOf(found.findings).filter((finding) => finding.kind === "rule").map((finding) => [finding.ruleId, finding.withheld]),
    [["failing-routine", "roleUnknown"], ["connector-needs-auth", undefined]],
  );

  const recommended = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data);
  assert.equal(recommended.mode, "partial");
  assert.deepEqual(listOf(recommended.recommendations).map((item) => [item.id, item.title, item.evidenceIds]), [["connector-needs-auth", "Sign the connector in again", ["ev-2", "ev-3", "ev-4"]]]);
  assert.deepEqual(recommended.withheld, ["failing-routine"]);

  const payload = dataOf(dataOf(run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true })).data).payload);
  assert.equal(validateReport(payload), true);
  assert.equal(payload.accountKind, "unknown");
  assert.deepEqual(listOf(payload.recommendations).map((item) => item.id), ["connector-needs-auth"]);
  assert.deepEqual(dataOf(payload.moduleVersions), { audit: "0.2.2" });
});

test("with an unknown role, a connector that needs a sign-in but has no evidence line gets a finding and no recommendation", (t) => {
  const home = freshHome(t);
  const document = changed(fixture("partial.json"), (copy) => {
    copy.evidence = listOf(copy.evidence).filter((item) => item.source !== "calendar");
  });
  const snapshotId = dataOf(run(home, ["snapshot"], document).data).snapshotId;
  const findings = listOf(dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data).findings);
  assert.ok(findings.some((finding) => finding.ruleId === "connector-needs-auth" && finding.withheld === undefined));
  const recommended = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data);
  assert.deepEqual(listOf(recommended.recommendations).map((item) => item.id), ["connector-needs-grant", "stale-tasks"]);
});

test("when the role is known the same account gets its role-dependent recommendations", (t) => {
  const home = freshHome(t);
  const known = changed(fixture("partial.json"), (document) => {
    document.account = { kind: "owner", label: "Main workspace" };
    document.visibility = listOf(document.visibility).map((entry) => (entry.signal === "accountRole" ? { ...entry, seen: true, why: "The account holder said so." } : entry));
  });
  const snapshotId = dataOf(run(home, ["snapshot"], known).data).snapshotId;
  const recommended = dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data);
  assert.equal(recommended.mode, "full");
  assert.deepEqual(recommended.withheld, []);
  assert.deepEqual(listOf(recommended.recommendations).map((item) => item.id), ["failing-routine", "connector-needs-auth", "connector-needs-grant"]);
});

test("a refused collector names each failing field as a JSON pointer with the rule it broke", (t) => {
  const home = freshHome(t);
  const wrongTypes = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.tasks = { open: "none", stale7d: 3 };
      document.transcript = "all of it";
    }),
  );
  assert.equal(wrongTypes.exit, 1);
  const texts = errorTexts(wrongTypes);
  assert.ok(texts.every((entry) => entry.code === "E_INPUT_SCHEMA"));
  assert.ok(texts.some((entry) => entry.message.includes("field /tasks/open must be integer or null (rule: type)")), wrongTypes.stdout);
  assert.ok(texts.some((entry) => entry.message.includes("field /tasks/blocked is required and is missing (rule: required)")), wrongTypes.stdout);
  assert.ok(texts.some((entry) => entry.message.includes("field /transcript is not a field of this input (rule: additionalProperties)")), wrongTypes.stdout);
  assert.ok(texts.every((entry) => entry.hint.includes('ambitious-audit schema snapshot')));
  assert.ok(texts.some((entry) => entry.hint.includes("null when not observed")), wrongTypes.stdout);

  const short = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.visibility = listOf(document.visibility).filter((entry) => entry.signal !== "tasks");
    }),
  );
  assert.deepEqual(
    errorTexts(short).map((entry) => entry.message),
    ['The input field /visibility must have one entry whose signal is "tasks" (rule: contains).', "The input field /visibility must NOT have fewer than 9 items (rule: minItems)."],
  );

  const legacy = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.bots = [{ id: "bot-1", name: "Helper", lastActiveAt: null, routineCount: 0, usage: { credits7d: 1 } }];
    }),
  );
  assert.ok(errorTexts(legacy).some((entry) => entry.message.includes("/bots/0/usage/credits7d")), legacy.stdout);

  assert.equal(run(home, ["snapshot"], owner).exit, 0);
  const badId = run(home, ["findings"], JSON.stringify({ snapshotId: "not-an-id" }));
  assert.equal(badId.exit, 1);
  assert.ok(errorTexts(badId).some((entry) => entry.message.includes("field /snapshotId") && entry.message.includes("rule: pattern") && entry.hint.includes("schema findings")), badId.stdout);
  const badMark = run(home, ["report", "mark"], JSON.stringify({ reportId: "018f0000-0000-7000-8000-000000000001", state: "done", at: "2026-11-15T00:00:00Z" }));
  assert.ok(errorTexts(badMark).some((entry) => entry.message.includes('field /state must be one of "reviewed", "sent", "acked", "failed" (rule: enum)')), badMark.stdout);
});

test("a null needs its visibility gap, and a role nobody saw must be unknown", (t) => {
  const home = freshHome(t);
  const zeroless = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.tasks = { open: null, stale7d: null, blocked: null };
    }),
  );
  assert.equal(zeroless.exit, 1);
  const gap = errorTexts(zeroless)[0];
  assert.match(gap?.message ?? "", /field \/visibility\/5\/seen must be false, because \/tasks\/open is null, which means not observed \(rule: null-needs-visibility-gap\)/);
  assert.match(gap?.hint ?? "", /Never write zero or a guess/);

  const inferred = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.visibility = listOf(document.visibility).map((entry) => (entry.signal === "accountRole" ? { ...entry, seen: false, why: "No tool reports it." } : entry));
    }),
  );
  assert.equal(inferred.exit, 1);
  assert.match(errorTexts(inferred)[0]?.message ?? "", /field \/account\/kind must be "unknown".*\(rule: role-needs-a-source\)/);

  const share = run(
    home,
    ["snapshot"],
    changed(owner, (document) => {
      document.bots = [{ id: "bot-1", name: "Helper", lastActiveAt: "never", routineCount: 0, usage: { unit: "percent", amount7d: 140 } }];
    }),
  );
  assert.match(errorTexts(share)[0]?.message ?? "", /field \/bots\/0\/usage\/amount7d must be 100 or less when unit is percent \(rule: percent-range\)/);
});

test("schema prints the collector schema, and schema with a command name prints that command's input schema", (t) => {
  const home = freshHome(t);
  const collector: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "collector.v1.json"), "utf8"));
  const printed = dataOf(run(home, ["schema"]).data);
  assert.deepEqual(printed.schema, collector);
  assert.equal(printed.input, "snapshot");
  const names = Array.isArray(printed.commands) ? printed.commands.filter((name) => typeof name === "string") : [];
  assert.deepEqual(names, ["snapshot", "baseline set", "diff", "findings", "recommend", "report build", "report mark", "feedback build"]);
  const listed = listOf(dataOf(run(home, ["commands"]).data).commands);
  assert.deepEqual(
    listed.filter((entry) => entry.input === true).map((entry) => entry.name).sort(),
    [...names].sort(),
  );
  for (const name of names) {
    const ran = run(home, ["schema", ...name.split(" ")]);
    assert.equal(ran.exit, 0, name);
    const schema = dataOf(dataOf(ran.data).schema);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    const example = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    assert.equal(example({}), false, name);
  }
  assert.equal(run(home, ["schema", "nothing"]).exit, 1);
});

test("a routine created paused on the day of the snapshot, and one paused since an unknown time, give a report with no claim about how long", (t) => {
  const home = freshHome(t);
  const document = changed(fixture("shares.json"), (copy) => {
    copy.routines = listOf(copy.routines).filter((routine) => routine.id !== "routine-3");
    copy.evidence = listOf(copy.evidence).filter((item) => item.source !== "routine-3");
  });
  const stored = run(home, ["snapshot"], document);
  assert.equal(stored.exit, 0, stored.stdout);
  const snapshotId = dataOf(stored.data).snapshotId;
  const normalized = dataOf(dataOf(stored.data).normalized);
  assert.deepEqual(normalized.usageOther, { share: 0.08, botCount: 1 });
  assert.deepEqual(normalized.weeklyLimitUsed, { percent: 37, asOf: "2026-11-15T00:00:00Z" });
  assert.deepEqual(listOf(normalized.bots).map((bot) => (isRecord(bot.usage) ? bot.usage.share : bot.usage)), [0.62, 0.3, null]);

  const findings = listOf(dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data).findings);
  assert.deepEqual(
    findings.filter((finding) => finding.kind === "rule").map((finding) => [finding.ruleId, finding.severity, finding.summary, finding.evidenceIds]),
    [["paused-routine-since-unknown", "low", "1 routine is paused, and the account did not show since when.", ["ev-2"]]],
  );
  const recommended = listOf(dataOf(run(home, ["recommend"], JSON.stringify({ snapshotId })).data).recommendations);
  assert.deepEqual(recommended.map((item) => item.id), ["paused-routine-since-unknown"]);

  const built = run(home, ["report", "build"], JSON.stringify({ snapshotId, reviewRequired: true }));
  assert.equal(built.exit, 0, built.stdout);
  const payload = dataOf(dataOf(built.data).payload);
  assert.equal(validateReport(payload), true);
  assert.doesNotMatch(JSON.stringify([payload.summary, payload.findings, payload.recommendations]), /\d+\s*\+?\s*days|for more than/);
  assert.deepEqual(dataOf(payload.counts).routines, { active: 1, paused: 2, failing: 0 });
  assert.ok(listOf(payload.visibility).some((entry) => entry.signal === "usage" && entry.seen === false && String(entry.why).includes("one summed line for the rest")));
});

test("a routine whose pause time is 8 days before the snapshot is reported as paused for more than 7 days", (t) => {
  const home = freshHome(t);
  const snapshotId = dataOf(run(home, ["snapshot"], fixture("shares.json")).data).snapshotId;
  const findings = listOf(dataOf(run(home, ["findings"], JSON.stringify({ snapshotId })).data).findings);
  assert.deepEqual(
    findings.filter((finding) => finding.kind === "rule").map((finding) => [finding.ruleId, finding.severity, finding.summary, finding.evidenceIds]),
    [
      ["paused-routine", "medium", "1 routine has been paused for more than 7 days.", ["ev-1"]],
      ["paused-routine-since-unknown", "low", "1 routine is paused, and the account did not show since when.", ["ev-2"]],
    ],
  );
});

test("schema describes the pause time and usage as shares, so a collector can learn them from the command", (t) => {
  const home = freshHome(t);
  const defs = dataOf(dataOf(dataOf(run(home, ["schema"]).data).schema).$defs);
  const routine = dataOf(dataOf(defs.routine).properties);
  assert.match(String(dataOf(routine.pausedAt).description), /Leave it out when the account does not show it/);
  assert.ok(isRecord(routine.createdAt));
  const usage = dataOf(dataOf(defs.botUsage).properties);
  assert.deepEqual(dataOf(usage.unit).enum, ["credits", "percent", "share"]);
  assert.deepEqual(dataOf(usage.period).enum, ["this_week", "last_7_days", "last_30_days"]);
  const top = dataOf(dataOf(dataOf(run(home, ["schema", "snapshot"]).data).schema).properties);
  assert.ok(isRecord(top.usageOther) && isRecord(top.weeklyLimitUsed));
});
