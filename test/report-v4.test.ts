import assert from "node:assert/strict";
import { test } from "node:test";
import weekly from "../schemas/examples/collector.v2/valid/weekly-activity.json" with { type: "json" };
import unobserved from "../schemas/examples/collector.v2/valid/unobserved.json" with { type: "json" };
import legacy from "./fixtures/shares.json" with { type: "json" };
import { parseCollector } from "../src/domain/input.ts";
import { assembleReport } from "../src/domain/report.ts";
import { RULES } from "../src/domain/rule-pack.ts";
import { evaluateRules } from "../src/domain/rules.ts";
import { isReportId } from "../src/domain/types.ts";

const report = (raw: unknown) => {
  const snapshot = parseCollector(raw);
  const id = "018f0000-0000-7000-8000-000000000001";
  if (!isReportId(id)) throw new Error("Invalid fixture report id");
  return assembleReport(snapshot, evaluateRules(snapshot, RULES), new Set(), id, "0.4.0").payload;
};

test("nine exact shares and eight bounds survive missing routine access", () => {
  const bots = Array.from({ length: 17 }, (_, index) => ({
    id: `bot-${index}`, name: `Work queue ${index}`, lastActiveAt: null, routineCount: null,
    usage: { unit: "share", period: "last_7_days", ...(index < 9 ? { share: 0.11 } : { shareBelow: 0.01 }) },
  }));
  const snapshot = parseCollector({ ...unobserved, bots });
  assert.equal(snapshot.visibility.find((entry) => entry.signal === "usage")?.seen, "partial");
  const payload = report(snapshot);
  assert.equal(payload.bots.filter((bot) => bot.usageShare === 0.11 && bot.usageShareBelow === null).length, 9);
  assert.equal(payload.bots.filter((bot) => bot.usageShareBelow === 0.01 && bot.usageShare === null).length, 8);
  assert.ok(payload.bots.every((bot) => bot.usagePeriod === "last_7_days"));
  assert.deepEqual(payload.counts.routines, { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null });
  assert.ok(payload.findings.some((item) => item.ruleId === "bots-barely-used"));
  assert.ok(payload.findings.some((item) => item.ruleId === "visibility-usage" && item.summary.includes("Partially observed")));
  assert.ok(!payload.findings.some((item) => item.ruleId === "bot-unused"));
});

test("a thirty-day bound cannot establish zero usage, even across a full bot inventory", () => {
  const bots = Array.from({ length: 200 }, (_, index) => ({
    id: `${"b".repeat(125)}${String(index).padStart(3, "0")}`, name: "b".repeat(120),
    lastActiveAt: null, routineCount: null, usage: { unit: "share", period: "last_30_days", shareBelow: 0.01 },
  }));
  const bounded = report({ ...unobserved, bots });
  assert.equal(bounded.bots.length, 200);
  assert.ok(!bounded.findings.some((item) => item.kind === "rule"));
  const week = bots.map((bot) => ({ ...bot, usage: { ...bot.usage, period: "last_7_days" } }));
  assert.ok(report({ ...unobserved, bots: week }).findings.some((item) => item.ruleId === "bots-barely-used"));
  const idle = report({ ...unobserved, bots: bots.map((bot) => ({ ...bot, lastActiveAt: "never" })) });
  assert.ok(idle.findings.some((item) => item.ruleId === "bot-unused"));
});

test("each routine total requires its own complete observations", () => {
  const first = weekly.routines[0];
  if (!first) throw new Error("Missing routine fixture");
  const routines = [first, { ...first, id: "routine-2", state: "paused", runs7d: 2, failedRuns7d: null }];
  const partial = {
    ...weekly, routines, bots: weekly.bots.map((bot) => ({ ...bot, routineCount: bot.id === first.botId ? 2 : 0 })),
    visibility: weekly.visibility.map((entry) => entry.signal === "routines" ? { ...entry, seen: "partial", why: "One failure count is missing." } : entry),
  };
  const counts = report(partial).counts.routines;
  assert.deepEqual(counts, { active: 1, paused: 1, failing: 0, runs7d: 8, failedRuns7d: null });
  const missingRow = report({ ...partial, routines: [first] });
  assert.deepEqual(missingRow.counts.routines, { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null });
  const emptyList = { ...weekly, routines: [], bots: weekly.bots.map((bot) => ({ ...bot, routineCount: 0 })) };
  const unseenList = report({ ...emptyList, visibility: weekly.visibility.map((entry) => entry.signal === "routines" ? { ...entry, seen: false, why: "Routine inventory was unavailable." } : entry) });
  assert.equal(unseenList.counts.routines.active, null);
  const empty = report(emptyList);
  assert.deepEqual(empty.counts.routines, { active: 0, paused: 0, failing: 0, runs7d: 0, failedRuns7d: 0 });
});

test("plan credits accept whole cents, reject fractions and preserve missing values", () => {
  for (const balance of [0, 0.29, 4.99, 999999999.99, 1000000000, null]) {
    const planUsage = { ...weekly.planUsage, extraCreditsLeftUsd: balance };
    assert.deepEqual(report({ ...weekly, planUsage }).planUsage, planUsage);
  }
  for (const balance of [-0.01, 0.00000000001, 0.291, 1000000000.01]) {
    assert.throws(() => parseCollector({ ...weekly, planUsage: { ...weekly.planUsage, extraCreditsLeftUsd: balance } }));
  }
  assert.equal(report(unobserved).planUsage, null);
  assert.deepEqual(report(legacy).planUsage, { weeklyLimitUsedPercent: 37, extraCreditsLeftUsd: null, observedAt: legacy.weeklyLimitUsed.asOf, period: "this_week" });
  assert.equal(report({ ...legacy, weeklyLimitUsed: { ...legacy.weeklyLimitUsed, percent: 125 } }).planUsage, null);
});

test("explicit null plan, task and run values require a matching visibility gap", () => {
  const fullySeen = weekly.visibility.map((entry) => entry.signal === "usage" ? { ...entry, seen: true } : entry);
  assert.throws(() => parseCollector({ ...weekly, bots: [], routines: [], visibility: fullySeen, planUsage: { ...weekly.planUsage, period: null } }), /null-needs-visibility-gap/);
  assert.throws(() => parseCollector({ ...weekly, tasks: { ...weekly.tasks, closed7d: null } }), /null-needs-visibility-gap/);
  assert.throws(() => parseCollector({ ...weekly, routines: weekly.routines.map((routine) => ({ ...routine, runs7d: null })) }), /null-needs-visibility-gap/);
});
