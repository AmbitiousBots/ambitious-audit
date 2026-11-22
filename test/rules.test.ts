import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";
import botUnused from "../rules/bot-unused.json" with { type: "json" };
import botsBarelyUsed from "../rules/bots-barely-used.json" with { type: "json" };
import connectorNeedsAuth from "../rules/connector-needs-auth.json" with { type: "json" };
import connectorNeedsGrant from "../rules/connector-needs-grant.json" with { type: "json" };
import duplicateRoutines from "../rules/duplicate-routines.json" with { type: "json" };
import failingRoutine from "../rules/failing-routine.json" with { type: "json" };
import pausedRoutine from "../rules/paused-routine.json" with { type: "json" };
import pausedRoutineSinceUnknown from "../rules/paused-routine-since-unknown.json" with { type: "json" };
import staleTasks from "../rules/stale-tasks.json" with { type: "json" };
import { parseCollector } from "../src/domain/input.ts";
import { assembleReport, recommendationsFrom } from "../src/domain/report.ts";
import { evaluateRules, parseRule, type RuleDefinition, type RuleHit } from "../src/domain/rules.ts";
import { isReportPayload } from "../src/domain/schema.ts";
import type { CollectorInput, EvidenceId } from "../src/domain/types.ts";
import { isEvidenceId, isFingerprint, isReportId, isRuleId } from "../src/domain/types.ts";

const FILES: readonly unknown[] = [failingRoutine, connectorNeedsAuth, connectorNeedsGrant, pausedRoutine, pausedRoutineSinceUnknown, botUnused, staleTasks, duplicateRoutines, botsBarelyUsed];

type Fixture = {
  readonly name: string;
  readonly expect: "hit" | "miss";
  readonly bots?: CollectorInput["bots"];
  readonly routines?: CollectorInput["routines"];
  readonly connectors?: CollectorInput["connectors"];
  readonly tasks?: CollectorInput["tasks"];
};

const visibility: CollectorInput["visibility"] = [
  { signal: "transcripts", seen: false, why: "No tool reads conversations." },
  { signal: "usage", seen: false, why: "Usage was not read for every bot and routine." },
  { signal: "otherBots", seen: true, why: "Listed with the bot list." },
  { signal: "auditLog", seen: false, why: "The account does not share the audit log." },
  { signal: "accountRole", seen: true, why: "The member view shows the role." },
  { signal: "tasks", seen: false, why: "Some task counts were not read." },
  { signal: "pages", seen: true, why: "Counted with the page list tool." },
  { signal: "botActivity", seen: false, why: "Some bots show no last-active time." },
  { signal: "routines", seen: false, why: "Some routines show no run time." },
];

const isFixture = (value: unknown): value is Fixture => {
  if (!isRecord(value) || typeof value.name !== "string" || (value.expect !== "hit" && value.expect !== "miss")) return false;
  return true;
};

const fixturesOf = (file: unknown): readonly Fixture[] => {
  if (!isRecord(file) || !Array.isArray(file.fixtures)) return [];
  return file.fixtures.filter(isFixture);
};

const snapshotFor = (fixture: Fixture): CollectorInput => {
  const bots = fixture.bots ?? [];
  const routines = fixture.routines ?? [];
  const connectors = fixture.connectors ?? [];
  const evidence = [
    ...routines.map((routine, index) => ({ id: `ev-${index + 1}`, kind: "excerpt" as const, text: `Routine ${routine.id}.`, source: routine.id })),
    ...connectors.map((connector, index) => ({ id: `ev-${routines.length + index + 1}`, kind: "excerpt" as const, text: `Connector ${connector.name}.`, source: connector.name })),
    ...bots.map((bot, index) => ({ id: `ev-${routines.length + connectors.length + index + 1}`, kind: "count" as const, text: `Bot ${bot.id}.`, source: bot.id })),
    { id: "ev-90", kind: "count" as const, text: "Open tasks have not changed.", source: "tasks" },
  ].filter((item) => isEvidenceId(item.id));
  return parseCollector({
    schemaVersion: 2,
    collectedAt: "2026-11-15T00:00:00Z",
    account: { kind: "owner", label: "Main" },
    bots,
    routines,
    connectors,
    tasks: fixture.tasks ?? { open: 0, stale7d: 0, blocked: 0 },
    pages: { count: 0, updated7d: 0 },
    visibility,
    evidence,
  });
};

test("every rule has a positive fixture and a negative fixture", () => {
  const rules = FILES.map(parseRule);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, rules.length);
  for (const file of FILES) {
    const fixtures = fixturesOf(file);
    assert.equal(fixtures.some((fixture) => fixture.expect === "hit"), true, parseRule(file).id);
    assert.equal(fixtures.some((fixture) => fixture.expect === "miss"), true, parseRule(file).id);
  }
});

test("each rule matches its positive fixtures and not its negative fixtures", () => {
  for (const file of FILES) {
    const rule: RuleDefinition = parseRule(file);
    for (const fixture of fixturesOf(file)) {
      const hits = evaluateRules(snapshotFor(fixture), [rule]);
      const matched = hits.some((hit) => hit.rule.id === rule.id);
      assert.equal(matched, fixture.expect === "hit", `${rule.id}: ${fixture.name}`);
    }
  }
});

test("recommendations stay within three and each cites evidence that exists", () => {
  const rules = FILES.map(parseRule);
  const snapshot = snapshotFor({
    name: "everything",
    expect: "hit",
    bots: [{ id: "bot-1", name: "Helper", lastActiveAt: "never", routineCount: 2, usage: null }],
    routines: [
      { id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", state: "failing", lastRunAt: "2026-11-01T00:00:00Z", usage: null },
      { id: "routine-2", botId: "bot-1", schedule: "every day at 08:00", state: "paused", lastRunAt: "2026-11-01T00:00:00Z", usage: null },
    ],
    connectors: [{ name: "calendar", status: "needsAuth" }],
    tasks: { open: 4, stale7d: 2, blocked: 0 },
  });
  const recommendations = recommendationsFrom(evaluateRules(snapshot, rules), new Set()).map((item) => item.recommendation);
  assert.ok(recommendations.length <= 3);
  const known = new Set(snapshot.evidence.map((item) => item.id));
  for (const recommendation of recommendations) {
    assert.ok(recommendation.evidenceIds.length >= 1);
    for (const id of recommendation.evidenceIds) assert.equal(known.has(id), true);
  }
});

test("evidence for bot-10 is not cited for bot-1, and the same holds for routines", () => {
  const snapshot = parseCollector({
    schemaVersion: 2,
    collectedAt: "2026-11-15T00:00:00Z",
    account: { kind: "owner", label: "Main" },
    bots: [
      { id: "bot-1", name: "Helper", lastActiveAt: "never", routineCount: 0, usage: null },
      { id: "bot-10", name: "Worker", lastActiveAt: "2026-11-14T00:00:00Z", routineCount: 1, usage: { unit: "credits", amount7d: 1 } },
    ],
    routines: [
      { id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", state: "failing", lastRunAt: "2026-11-14T08:00:00Z", usage: null },
      { id: "routine-10", botId: "bot-10", schedule: "every day at 09:00", state: "active", lastRunAt: "2026-11-14T09:00:00Z", usage: null },
    ],
    connectors: [],
    tasks: { open: 0, stale7d: 0, blocked: 0 },
    pages: { count: 0, updated7d: 0 },
    visibility,
    evidence: [
      { id: "ev-1", kind: "excerpt", text: "Active yesterday.", source: "bot-10" },
      { id: "ev-2", kind: "excerpt", text: "Ran yesterday.", source: "routine-10" },
    ],
  });
  const hits = evaluateRules(snapshot, [parseRule(botUnused), parseRule(failingRoutine)]);
  const unused = hits.find((item) => item.rule.id === "bot-unused");
  const failing = hits.find((item) => item.rule.id === "failing-routine");
  assert.deepEqual(unused?.subjects, ["bot-1"]);
  assert.deepEqual(unused?.evidenceIds, []);
  assert.deepEqual(failing?.subjects, ["routine-1"]);
  assert.deepEqual(failing?.evidenceIds, []);
  const cited = recommendationsFrom(hits, new Set()).flatMap((item) => item.recommendation.evidenceIds);
  assert.equal(cited.some((id) => id === "ev-1"), false);
  assert.equal(cited.some((id) => id === "ev-2"), false);
});

test("stale-task evidence matches the source tasks and not the word task", () => {
  const snapshot = snapshotFor({
    name: "stale",
    expect: "hit",
    tasks: { open: 4, stale7d: 2, blocked: 0 },
  });
  const withExtra = parseCollector({
    ...snapshot,
    evidence: [
      { id: "ev-1", kind: "excerpt", text: "This task is unrelated.", source: "task list tool" },
      { id: "ev-2", kind: "excerpt", text: "task", source: "task" },
      { id: "ev-3", kind: "count", text: "Open tasks have not changed.", source: "Tasks" },
    ],
  });
  const hits = evaluateRules(withExtra, [parseRule(staleTasks)]);
  assert.deepEqual(hits[0]?.evidenceIds, ["ev-3"]);
});

const branded = <T extends string>(value: string, accept: (raw: string) => raw is T, label: string): T => {
  if (!accept(value)) throw new Error(label);
  return value;
};

test("cited recommendation evidence stays in the report when the evidence list is cut to 30", () => {
  const evidence = Array.from({ length: 40 }, (_, index) => ({
    id: `ev-${index + 1}`,
    kind: "count" as const,
    text: `Row ${index + 1}.`,
    source: "notes",
  }));
  const snapshot = snapshotFor({ name: "many", expect: "hit" });
  const full = parseCollector({ ...snapshot, evidence });
  const ids = (from: number, count: number): EvidenceId[] =>
    Array.from({ length: count }, (_, index) => branded(`ev-${from + index}`, isEvidenceId, "evidence id"));
  const base = parseRule(botUnused);
  const ruleHit = (id: string, rank: number, evidenceIds: EvidenceId[]): RuleHit => ({
    rule: { ...base, id: branded(id, isRuleId, "rule id"), rank },
    subjects: ["bot-1"],
    withheld: false,
    evidenceIds,
    summary: "One bot has not been used.",
    fingerprint: branded(id, isFingerprint, "fingerprint"),
  });
  const hits = [
    ruleHit("bot-unused", 1, ids(31, 10)),
    ruleHit("bot-unused-early", 2, ids(1, 10)),
    ruleHit("bot-unused-middle", 3, ids(11, 10)),
    ruleHit("bot-unused-late", 4, ids(21, 10)),
  ];
  const reportId = branded("018f0000-0000-7000-8000-000000000099", isReportId, "report id");
  const { payload } = assembleReport(full, hits, new Set(), reportId, "0.4.0");
  const kept = new Set(payload.evidence.map((item) => item.id));
  assert.equal(payload.evidence.length, 30);
  for (const recommendation of payload.recommendations) {
    for (const id of recommendation.evidenceIds) assert.equal(kept.has(id), true, id);
  }
  assert.equal(payload.evidence[0]?.id, "ev-31");
});

test("when the role is unknown, at most three recommendations are returned and the ones that depend on the role are left out", () => {
  const connectors = ["calendar", "documents"].map((name) => ({ name, status: "needsAuth" as const }));
  const known = snapshotFor({ name: "many", expect: "hit", connectors, tasks: { open: 4, stale7d: 2, blocked: 0 } });
  const snapshot = parseCollector({
    ...known,
    account: { kind: "unknown", label: "Main" },
    visibility: known.visibility.map((entry) => (entry.signal === "accountRole" ? { ...entry, seen: false, why: "No tool reports the role." } : entry)),
  });
  const signIn = parseRule(connectorNeedsAuth);
  const copies = ["connector-sign-in-a", "connector-sign-in-b", "connector-sign-in-c"].map((id, index) => ({ ...signIn, id: branded(id, isRuleId, "rule id"), rank: index + 1 }));
  const roleBound = { ...signIn, id: branded("connector-sign-in-role-bound", isRuleId, "rule id"), rank: 0, dependsOnRole: true };
  const hits = evaluateRules(snapshot, [roleBound, signIn, ...copies, parseRule(staleTasks)]);
  assert.equal(hits.length, 6);
  const recommended = recommendationsFrom(hits, new Set()).map((item) => String(item.recommendation.id));
  assert.deepEqual(recommended, ["connector-sign-in-a", "connector-sign-in-b", "connector-sign-in-c"]);
  const reportId = branded("018f0000-0000-7000-8000-000000000098", isReportId, "report id");
  const { payload } = assembleReport(snapshot, hits, new Set(), reportId, "0.4.0");
  assert.equal(payload.recommendations.length, 3);
  assert.equal(payload.recommendations.every((item) => item.evidenceIds.length === 2), true);
  assert.deepEqual(payload.findings.filter((finding) => finding.withheld === "roleUnknown").map((finding) => String(finding.ruleId)), ["connector-sign-in-role-bound"]);
});

test("a suppressed fingerprint is dropped and an unknown one is kept", () => {
  const rule = parseRule(failingRoutine);
  const snapshot = snapshotFor({
    name: "failing",
    expect: "hit",
    routines: [{ id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", state: "failing", lastRunAt: "2026-11-14T08:00:00Z", usage: null }],
  });
  const hits = evaluateRules(snapshot, [rule]);
  const fingerprint = hits[0]?.fingerprint;
  assert.ok(fingerprint !== undefined);
  assert.equal(recommendationsFrom(hits, new Set([fingerprint])).length, 0);
  assert.equal(recommendationsFrom(hits, new Set()).length, 1);
});

test("every rule maps high severity to high priority and medium or low severity to low priority in findings and recommendations", () => {
  const priorities: Readonly<Record<string, "high" | "low">> = {
    "failing-routine": "high",
    "connector-needs-auth": "high",
    "connector-needs-grant": "low",
    "paused-routine": "low",
    "paused-routine-since-unknown": "low",
    "bot-unused": "low",
    "bots-barely-used": "low",
    "stale-tasks": "low",
    "duplicate-routines": "low",
  };
  const reportId = branded("018f0000-0000-7000-8000-000000000097", isReportId, "report id");
  for (const file of FILES) {
    const rule = parseRule(file);
    const fixture = fixturesOf(file).find((item) => item.expect === "hit");
    assert.ok(fixture !== undefined, rule.id);
    const snapshot = snapshotFor(fixture);
    const { payload } = assembleReport(snapshot, evaluateRules(snapshot, [rule]), new Set(), reportId, "0.4.0");
    assert.equal(payload.schemaVersion, 4);
    assert.deepEqual(payload.announcements, []);
    const finding = payload.findings.find((item) => item.ruleId === rule.id);
    assert.ok(finding !== undefined, rule.id);
    assert.equal(finding.severity, rule.severity, rule.id);
    assert.equal(finding.priority, priorities[rule.id], rule.id);
    assert.deepEqual(payload.recommendations.map((item) => [item.id, item.priority]), [[rule.id, priorities[rule.id]]], rule.id);
    const visibilityFindings = payload.findings.filter((item) => item.kind === "visibility");
    assert.ok(visibilityFindings.length > 0);
    assert.ok(visibilityFindings.every((item) => item.severity === "low" && item.priority === "low"));
  }
});

test("the report reader rejects announcement ids repeated with different titles or priorities", () => {
  const snapshot = snapshotFor({ name: "empty", expect: "miss" });
  const reportId = branded("018f0000-0000-7000-8000-000000000096", isReportId, "report id");
  const { payload } = assembleReport(snapshot, [], new Set(), reportId, "0.4.0");
  const announcements = [{ id: "release", priority: "low", title: "Service title" }];
  assert.equal(isReportPayload({ ...payload, announcements }), true);
  assert.equal(isReportPayload({ ...payload, announcements: [...announcements, { id: "release", priority: "high", title: "A different service title" }] }), false);
});
