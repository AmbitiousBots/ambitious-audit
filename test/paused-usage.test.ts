import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { parseCollector } from "../src/domain/input.ts";
import { findingsFrom, recommendationsFrom } from "../src/domain/report.ts";
import { RULES } from "../src/domain/rule-pack.ts";
import { evaluateRules } from "../src/domain/rules.ts";

const readJson = (...parts: readonly string[]): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, ...parts), "utf8"));
  if (!isRecord(parsed)) throw new Error(parts.join("/"));
  return parsed;
};

const shares = (): Record<string, unknown> => readJson("fixtures", "shares.json");

const listOf = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord).map((item) => ({ ...item })) : []);

type Routine = { readonly lastRunAt: string | null; readonly pausedAt?: string; readonly createdAt?: string };

const withPausedRoutine = (routine: Routine): Record<string, unknown> => {
  const document = shares();
  document.routines = [{ id: "routine-9", botId: "bot-1", schedule: "every day at 08:00", state: "paused", usage: null, ...routine }];
  document.evidence = [{ id: "ev-1", kind: "excerpt", text: "The routine list shows it as paused.", source: "routine-9" }];
  return document;
};

const pausedFindings = (document: Record<string, unknown>): readonly { readonly ruleId: string; readonly severity: string; readonly summary: string }[] => {
  const snapshot = parseCollector(document);
  return findingsFrom(snapshot, evaluateRules(snapshot, RULES))
    .filter((finding) => finding.kind === "rule" && finding.ruleId.startsWith("paused-routine"))
    .map((finding) => ({ ruleId: String(finding.ruleId), severity: finding.severity, summary: finding.summary }));
};

const DURATION = /\d+\s*\+?\s*days|for more than|for \d/;

const refusal = (document: Record<string, unknown>): readonly string[] => {
  try {
    parseCollector(document);
  } catch (error) {
    if (error instanceof Failure) return error.errors.map((entry) => entry.message);
    throw error;
  }
  return [];
};

test("a routine paused 8 days before the snapshot, by its pause time, is reported as paused for more than 7 days", () => {
  assert.deepEqual(pausedFindings(withPausedRoutine({ lastRunAt: null, pausedAt: "2026-11-07T00:00:00Z" })), [
    { ruleId: "paused-routine", severity: "medium", summary: "1 routine has been paused for more than 7 days." },
  ]);
});

test("a paused routine with no pause time is never given a duration, whatever its last run says", () => {
  for (const lastRunAt of [null, "never", "2026-10-01T00:00:00Z"]) {
    const findings = pausedFindings(withPausedRoutine({ lastRunAt }));
    assert.deepEqual(findings.map((finding) => [finding.ruleId, finding.severity]), [["paused-routine-since-unknown", "low"]], String(lastRunAt));
    for (const finding of findings) assert.doesNotMatch(finding.summary, DURATION, String(lastRunAt));
  }
});

test("a routine created paused on the day of the snapshot gets no paused finding", () => {
  assert.deepEqual(pausedFindings(withPausedRoutine({ lastRunAt: "never", createdAt: "2026-11-14T15:00:00Z" })), []);
  assert.deepEqual(pausedFindings(withPausedRoutine({ lastRunAt: null, createdAt: "2026-11-14T15:00:00Z" })), []);
});

test("a routine paused 2 days before the snapshot, by its pause time, gets no paused finding even when its last run is old", () => {
  assert.deepEqual(pausedFindings(withPausedRoutine({ lastRunAt: "2026-09-01T00:00:00Z", pausedAt: "2026-11-13T00:00:00Z" })), []);
});

test("the advice for a routine paused since an unknown time makes no claim about how long", () => {
  const snapshot = parseCollector(withPausedRoutine({ lastRunAt: null }));
  const advice = recommendationsFrom(evaluateRules(snapshot, RULES), new Set()).map((item) => item.recommendation);
  assert.deepEqual(advice.map((item) => String(item.id)), ["paused-routine-since-unknown"]);
  for (const item of advice) {
    assert.doesNotMatch(item.title, DURATION);
    assert.doesNotMatch(item.why, DURATION);
  }
});

test("a document with usage as shares, a summed line for the other bots and the weekly limit is stored as written", () => {
  const snapshot = parseCollector(shares());
  assert.deepEqual(
    snapshot.bots.map((bot) => bot.usage),
    [
      { unit: "share", period: "this_week", periodStart: "2026-11-09T00:00:00Z", periodEnd: "2026-11-15T00:00:00Z", share: 0.62 },
      { unit: "share", period: "this_week", periodStart: "2026-11-09T00:00:00Z", periodEnd: "2026-11-15T00:00:00Z", share: 0.3 },
      null,
    ],
  );
  assert.deepEqual(snapshot.usageOther, { share: 0.08, botCount: 1 });
  assert.deepEqual(snapshot.weeklyLimitUsed, { percent: 37, asOf: "2026-11-15T00:00:00Z" });
  assert.deepEqual(
    snapshot.routines.map((routine) => [routine.id, routine.pausedAt, routine.createdAt]),
    [
      ["routine-1", undefined, undefined],
      ["routine-2", undefined, "2026-11-14T15:00:00Z"],
      ["routine-3", "2026-11-07T00:00:00Z", undefined],
      ["routine-4", undefined, undefined],
    ],
  );
  const findings = findingsFrom(snapshot, evaluateRules(snapshot, RULES));
  assert.deepEqual(
    findings.filter((finding) => finding.kind === "rule").map((finding) => String(finding.ruleId)),
    ["paused-routine", "paused-routine-since-unknown"],
  );
  assert.ok(findings.some((finding) => finding.ruleId === "visibility-usage"));
});

test("a bot the usage report did not list by name is unseen, and is never called unused because its usage is missing", () => {
  const claimed = shares();
  claimed.visibility = listOf(claimed.visibility).map((entry) => (entry.signal === "usage" ? { ...entry, seen: true } : entry));
  assert.match(refusal(claimed)[0] ?? "", /\/visibility\/1\/seen must be false, because \/bots\/2\/usage is null, which means not observed \(rule: null-needs-visibility-gap\)/);

  const snapshot = parseCollector(shares());
  assert.equal(snapshot.bots[2]?.lastActiveAt, null);
  assert.equal(snapshot.bots[2]?.usage, null);
  assert.equal(evaluateRules(snapshot, RULES).some((hit) => hit.rule.id === "bot-unused"), false);
});

const unusedBots = (change: (bot: Record<string, unknown>) => void): readonly string[] => {
  const document = shares();
  const bots = listOf(document.bots);
  for (const bot of bots) {
    if (isRecord(bot.usage)) bot.usage = { unit: "share", period: "last_30_days", share: bot.id === "bot-1" ? 0.7 : 0.3 };
  }
  const target = bots[1];
  if (target === undefined) throw new Error("fixture");
  change(target);
  document.bots = bots;
  const snapshot = parseCollector(document);
  return evaluateRules(snapshot, RULES).flatMap((hit) => (hit.rule.id === "bot-unused" ? hit.subjects : []));
};

test("a bot is called unused from usage only when the report lists it with a share of 0 for a period that covers the 14 days", () => {
  const zero = (period: string) => (bot: Record<string, unknown>) => {
    bot.lastActiveAt = null;
    bot.usage = { unit: "share", period, share: 0 };
  };
  assert.deepEqual(unusedBots(zero("last_30_days")), ["bot-2"]);
  assert.deepEqual(
    unusedBots((bot) => {
      bot.lastActiveAt = null;
      bot.usage = { unit: "share", period: "last_30_days", share: 0.01 };
    }),
    [],
  );
  assert.deepEqual(
    unusedBots((bot) => {
      bot.lastActiveAt = null;
    }),
    [],
  );
});

test("a share of 0 for a week does not prove 14 unused days, and a share above 0 for a week overrides a last-active time that says never", () => {
  const weekly = (lastActiveAt: string | null, share: number): readonly string[] => {
    const document = shares();
    const bots = listOf(document.bots);
    const target = bots[1];
    if (target === undefined || !isRecord(target.usage)) throw new Error("fixture");
    target.lastActiveAt = lastActiveAt;
    target.usage = { ...target.usage, share };
    document.bots = bots;
    const snapshot = parseCollector(document);
    return evaluateRules(snapshot, RULES).flatMap((hit) => (hit.rule.id === "bot-unused" ? hit.subjects : []));
  };
  assert.deepEqual(weekly(null, 0), []);
  assert.deepEqual(weekly("never", 0.3), []);
  assert.deepEqual(weekly("never", 0), ["bot-2"]);
});

test("shares in one document must come from one period, and the summed line needs a listed share to give it a period", () => {
  const mixed = shares();
  const bots = listOf(mixed.bots);
  const second = bots[1];
  if (second === undefined) throw new Error("fixture");
  second.usage = { unit: "share", period: "last_30_days", share: 0.3 };
  mixed.bots = bots;
  assert.match(refusal(mixed)[0] ?? "", /\/bots\/1\/usage\/period must name the same period, with the same periodStart and periodEnd, as \/bots\/0\/usage \(rule: usage-one-period\)/);

  const alone = shares();
  alone.bots = listOf(alone.bots).map((bot) => ({ ...bot, usage: null }));
  assert.match(refusal(alone)[0] ?? "", /\/usageOther must be left out, because no bot has a usage with unit share.*\(rule: usage-other-needs-a-share\)/);

  const backwards = shares();
  backwards.bots = listOf(backwards.bots).map((bot) => (isRecord(bot.usage) ? { ...bot, usage: { ...bot.usage, periodStart: "2026-11-16T00:00:00Z" } } : bot));
  assert.match(refusal(backwards)[0] ?? "", /\/bots\/0\/usage\/periodStart must not be after periodEnd \(rule: period-order\)/);
});

test("the two forms of usage cannot be mixed in one value, and each refusal names the field", () => {
  const both = shares();
  both.bots = listOf(both.bots).map((bot, index) => (index === 0 && isRecord(bot.usage) ? { ...bot, usage: { ...bot.usage, amount7d: 62 } } : bot));
  assert.deepEqual(refusal(both), ["The input field /bots/0/usage/amount7d must be left out, because it does not go with the other fields of this value (rule: false schema)."]);

  const noPeriod = shares();
  noPeriod.bots = listOf(noPeriod.bots).map((bot, index) => (index === 0 ? { ...bot, usage: { unit: "share", share: 0.62 } } : bot));
  assert.ok(refusal(noPeriod).includes("The input field /bots/0/usage/period is required and is missing (rule: required)."));

  const percent = shares();
  percent.bots = listOf(percent.bots).map((bot, index) => (index === 0 && isRecord(bot.usage) ? { ...bot, usage: { ...bot.usage, share: 62 } } : bot));
  assert.deepEqual(refusal(percent), ["The input field /bots/0/usage/share must be <= 1 (rule: maximum)."]);

  const routineShare = shares();
  routineShare.routines = listOf(routineShare.routines).map((routine, index) => (index === 0 ? { ...routine, usage: { unit: "share", period: "this_week", share: 0.2 } } : routine));
  assert.ok(refusal(routineShare).some((message) => message.startsWith('The input field /routines/0/usage/unit must be one of "credits", "percent"')));
});

const sortedCopy = (document: Record<string, unknown>): Record<string, unknown> => {
  const by = (key: string) => (left: Record<string, unknown>, right: Record<string, unknown>) => (String(left[key]) < String(right[key]) ? -1 : 1);
  return {
    ...document,
    bots: listOf(document.bots).sort(by("id")),
    routines: listOf(document.routines).sort(by("id")),
    connectors: listOf(document.connectors).sort(by("name")),
    evidence: listOf(document.evidence).sort(by("id")),
  };
};

test("every collector document written for 0.2.0 or 0.2.1 is still accepted and stored exactly as written", () => {
  const earlier = [
    ...["owner.json", "partial.json", "nothing-observed.json"].map((name) => ["fixtures", name]),
    ...readdirSync(join(import.meta.dirname, "..", "schemas", "examples", "collector.v1", "valid"))
      .filter((name) => name !== "usage-as-shares-and-pause-times.json")
      .map((name) => ["..", "schemas", "examples", "collector.v1", "valid", name]),
  ];
  assert.equal(earlier.length, 7);
  for (const parts of earlier) {
    const document = readJson(...parts);
    assert.deepEqual(JSON.parse(JSON.stringify(parseCollector(document))), sortedCopy(document), parts.join("/"));
  }
});

test("weekly exact shares and bounds need six days of overlap with the snapshot week", () => {
  const matches = (dates: { periodStart?: string; periodEnd?: string }) => {
    const document = shares();
    const bots = listOf(document.bots).map((bot, index) => ({
      ...bot, usage: { unit: "share", period: "last_7_days", ...dates, ...(index ? { share: 0.009 } : { shareBelow: 0.01 }) },
    }));
    const snapshot = parseCollector({ ...document, schemaVersion: 2, bots });
    return evaluateRules(snapshot, RULES).some((hit) => hit.rule.id === "bots-barely-used");
  };
  assert.equal(matches({ periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-08T00:00:00Z" }), false);
  assert.equal(matches({ periodStart: "2026-10-01T00:00:00Z" }), false);
  assert.equal(matches({ periodEnd: "2026-11-08T00:00:00Z" }), false);
  assert.equal(matches({ periodStart: "2026-11-16T00:00:00Z" }), false);
  assert.equal(matches({ periodEnd: "2026-11-08T00:00:01Z" }), false);
  assert.equal(matches({ periodStart: "2026-11-09T00:00:01Z" }), false);
  assert.equal(matches({ periodStart: "2026-11-09T00:00:00Z" }), true);
  assert.equal(matches({ periodEnd: "2026-11-14T00:00:00Z" }), true);
  assert.equal(matches({}), true);
});
