import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";
import botUnused from "../rules/bot-unused.json" with { type: "json" };
import connectorNeedsAuth from "../rules/connector-needs-auth.json" with { type: "json" };
import duplicateRoutines from "../rules/duplicate-routines.json" with { type: "json" };
import failingRoutine from "../rules/failing-routine.json" with { type: "json" };
import pausedRoutine from "../rules/paused-routine.json" with { type: "json" };
import staleTasks from "../rules/stale-tasks.json" with { type: "json" };
import { parseCollector } from "../src/domain/input.ts";
import { recommendationsFrom } from "../src/domain/report.ts";
import { evaluateRules, parseRule, type RuleDefinition } from "../src/domain/rules.ts";
import type { CollectorInput } from "../src/domain/types.ts";
import { isEvidenceId } from "../src/domain/types.ts";

const FILES: readonly unknown[] = [failingRoutine, connectorNeedsAuth, pausedRoutine, botUnused, staleTasks, duplicateRoutines];

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
  { signal: "usage", seen: true, why: "Read from the usage view." },
  { signal: "otherBots", seen: true, why: "Listed with the bot list." },
  { signal: "auditLog", seen: false, why: "The account does not share the audit log." },
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
    schemaVersion: 1,
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
    bots: [{ id: "bot-1", name: "Helper", lastActiveAt: null, routineCount: 2, usage: { credits7d: null } }],
    routines: [
      { id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", state: "failing", lastRunAt: "2026-11-01T00:00:00Z" },
      { id: "routine-2", botId: "bot-1", schedule: "every day at 08:00", state: "paused", lastRunAt: "2026-11-01T00:00:00Z" },
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

test("a suppressed fingerprint is dropped and an unknown one is kept", () => {
  const rule = parseRule(failingRoutine);
  const snapshot = snapshotFor({
    name: "failing",
    expect: "hit",
    routines: [{ id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", state: "failing", lastRunAt: "2026-11-14T08:00:00Z" }],
  });
  const hits = evaluateRules(snapshot, [rule]);
  const fingerprint = hits[0]?.fingerprint;
  assert.ok(fingerprint !== undefined);
  assert.equal(recommendationsFrom(hits, new Set([fingerprint])).length, 0);
  assert.equal(recommendationsFrom(hits, new Set()).length, 1);
});
