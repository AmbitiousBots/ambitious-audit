import assert from "node:assert/strict";
import { test } from "node:test";
import weekly from "../schemas/examples/collector.v2/valid/weekly-activity.json" with { type: "json" };
import unobserved from "../schemas/examples/collector.v2/valid/unobserved.json" with { type: "json" };
import legacy from "./fixtures/shares.json" with { type: "json" };
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/domain/canonical.ts";
import { MCP_ENVELOPE_BYTES, REQUEST_BYTE_LIMIT } from "../src/domain/report-size.ts";
import type { CollectorV2BotUsage } from "../src/domain/wire.generated.ts";
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

test("exact and bounded shares exclude each other in the wire type", () => {
  const reading = { unit: "share", period: "last_7_days", share: 0, shareBelow: 0.01 } as const;
  // @ts-expect-error A value with both fields cannot be assigned to either share variant.
  const invalid: CollectorV2BotUsage = reading;
  assert.throws(() => parseCollector({ ...weekly, bots: weekly.bots.map((bot) => ({ ...bot, usage: invalid })) }));
});

test("the report redacts private fields after matching evidence and retains each record", () => {
  const privateValues = [
    "desk@example.invalid", "+1 (202) 555-0148", "555-0182", "https://sample:fixture@example.invalid/path",
    "https://example.invalid/items?q=sample", "token=fixture", "Bearer sample.sample.sample",
    "sk-test-syntheticcredential", "a7B9c1D3e5F7g9H1i3J5k7L9",
  ];
  for (const value of privateValues) {
    const source = `Queue ${value}`;
    const payload = report({
      ...weekly, bots: weekly.bots.map((bot) => ({ ...bot, name: source })),
      connectors: [{ name: source, status: "needsAuth" }, { name: value, status: "ok" }],
      evidence: [{ id: "ev-1", kind: "excerpt", text: `From ${value}`, source }],
      visibility: weekly.visibility.map((entry) => ({ ...entry, why: `Observed via ${value}` })),
    });
    assert.equal(JSON.stringify(payload).includes(value), false);
    assert.equal(payload.bots.length, weekly.bots.length);
    assert.ok(payload.bots.every((row) => row.name === "[redacted]"));
    assert.deepEqual(payload.connectors.map((row) => row.name), ["[redacted]", "[redacted]"]);
    assert.deepEqual(payload.evidence, [{ id: "ev-1", source: "[redacted]", text: "[redacted]" }]);
    assert.deepEqual(payload.recommendations[0]?.evidenceIds, ["ev-1"]);
    assert.ok(payload.visibility.every((entry) => entry.why === "[redacted]"));
  }
  const clean = report(weekly);
  assert.deepEqual(clean.bots.map((row) => row.name), weekly.bots.map((row) => row.name));
});

test("legacy activity and routine readings produce partial v4 coverage and preserve the stored snapshot hash", () => {
  const snapshot = parseCollector(legacy);
  const bytes = canonicalJson(snapshot);
  const payload = report(snapshot);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7f159840bd02289eeca7f11eaa412aa73ab96cc2233fb5fc719c17ec077ca15a");
  assert.deepEqual(payload.counts.routines, { active: 1, paused: 3, failing: 0, runs7d: null, failedRuns7d: null });
  for (const signal of ["botActivity", "routines", "usage"]) {
    assert.equal(payload.visibility.find((entry) => entry.signal === signal)?.seen, "partial");
  }
});

test("activity and routine coverage reflect complete, mixed and absent v2 readings", () => {
  const observed = {
    ...weekly, bots: weekly.bots.map((bot) => ({ ...bot, lastActiveAt: "never" })),
    visibility: weekly.visibility.map((entry) => ["botActivity", "routines"].includes(entry.signal) ? { ...entry, seen: false } : entry),
  };
  const activity = (raw: unknown) => report(raw).visibility
    .filter((entry) => entry.signal === "botActivity" || entry.signal === "routines").map((entry) => entry.seen);
  assert.deepEqual(activity(observed), [true, true]);
  assert.deepEqual(activity({ ...observed, bots: weekly.bots, routines: [] }), ["partial", "partial"]);
  assert.deepEqual(activity(unobserved), [false, false]);
});

test("usage coverage requires plan measurements and reflects missing fields", () => {
  const inventory = {
    ...weekly, routines: [], bots: weekly.bots.map((bot) => ({ ...bot, routineCount: 0, usage: { unit: "percent", amount7d: 0 } })),
    visibility: weekly.visibility.map((entry) => entry.signal === "usage" ? { ...entry, seen: true } : entry),
  };
  const seen = (raw: unknown) => report(raw).visibility.find((entry) => entry.signal === "usage")?.seen;
  assert.equal(seen(inventory), true);
  const { planUsage, ...withoutPlan } = inventory;
  assert.equal(seen(withoutPlan), "partial");
  assert.equal(seen({ ...withoutPlan, bots: [] }), false);
  const metadataOnly = { ...planUsage, weeklyLimitUsedPercent: null, extraCreditsLeftUsd: null };
  assert.equal(seen({ ...unobserved, planUsage: metadataOnly }), false);
  assert.equal(seen({ ...unobserved, planUsage: { ...metadataOnly, extraCreditsLeftUsd: 0 } }), "partial");
});

test("known per-bot counts override a claimed complete routine inventory", () => {
  const empty = report({ ...weekly, routines: [] });
  const wrongBot = report({ ...weekly, routines: weekly.routines.map((routine) => ({ ...routine, botId: "bot-2" })) });
  for (const payload of [empty, wrongBot]) {
    assert.deepEqual(payload.counts.routines, { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null });
    assert.equal(payload.visibility.find((entry) => entry.signal === "routines")?.seen, "partial");
  }
});

test("all findings and recommendations retain evidence when four rules compete for 30 rows", () => {
  const bots = weekly.bots.slice(0, 3).map((bot) => ({ ...bot, usage: { unit: "share", period: "last_7_days", shareBelow: 0.01 } }));
  const connectors = [{ name: "Connector 1", status: "needsAuth" }, { name: "Connector 2", status: "needsGrant" }];
  const sources = ["Connector 1", "Connector 2", "routine-1", "bot-1"];
  const evidence = sources.flatMap((source, group) => Array.from({ length: 10 }, (_, index) => ({
    source, id: `ev-${group * 10 + index + 1}`, kind: "count", text: `Observation ${index + 1}`,
  })));
  const payload = report({ ...weekly, bots, connectors, evidence, routines: weekly.routines.map((row) => ({ ...row, state: "failing" })) });
  const kept = new Set(payload.evidence.map((row) => row.id));
  assert.equal(kept.size, 30);
  assert.equal(payload.recommendations.length, 3);
  assert.ok(payload.findings.some((row) => row.ruleId === "bots-barely-used" && row.evidenceIds.length > 0));
  for (const row of [...payload.findings, ...payload.recommendations]) {
    if (!("kind" in row) || row.kind === "rule") assert.ok(row.evidenceIds.length > 0);
    for (const id of row.evidenceIds) assert.ok(kept.has(id), id);
  }
});

test("the serialized UTF-8 send_report request fits at the byte limit and truncates one byte over", () => {
  const wireBytes = (payload: unknown, id: string) => Buffer.byteLength(JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_report", arguments: payload },
  }), "utf8");
  const envelopeBytes = wireBytes(null, "") - Buffer.byteLength("null");
  const requestId = "1".repeat(MCP_ENVELOPE_BYTES - envelopeBytes);
  const bots = Array.from({ length: 200 }, (_, index) => ({
    id: `bot-${index}`, name: `Work queue ${index}`, usage: null, lastActiveAt: null, routineCount: null,
  }));
  const connectors = Array.from({ length: 200 }, (_, index) => ({ name: `Connector ${index}`, status: "ok" }));
  const baseline = report({ ...unobserved, bots, connectors });
  const space = REQUEST_BYTE_LIMIT - wireBytes(baseline, requestId);
  const pad = (name: string, index: number): string => {
    const bytes = Math.floor(space / 400) + Number(index < space % 400);
    return name + "𠀀".repeat(Math.floor(bytes / 4)) + " ".repeat(bytes % 4);
  };
  const input = {
    ...unobserved, bots: bots.map((row, index) => ({ ...row, name: pad(row.name, index) })),
    connectors: connectors.map((row, index) => ({ ...row, name: pad(row.name, index + bots.length) })),
  };
  const exact = report(input);
  assert.equal(wireBytes(exact, requestId), REQUEST_BYTE_LIMIT);
  assert.equal(exact.truncated, undefined);
  assert.equal(exact.bots.length + exact.connectors.length, 400);

  const over = { ...input, connectors: input.connectors.map((row, index) => index === 0 ? { ...row, name: row.name + " " } : row) };
  const cut = report(over);
  assert.equal(cut.truncated, true);
  assert.ok(wireBytes(cut, requestId) <= REQUEST_BYTE_LIMIT);
  assert.ok(cut.bots.length + cut.connectors.length < 400);
  assert.deepEqual(cut.counts, exact.counts);
  assert.deepEqual(report({ ...over, bots: over.bots.toReversed(), connectors: over.connectors.toReversed() }), cut);

  const fullName = (index: number) => "𠀀".repeat(117) + String(index).padStart(3, "0");
  const largest = report({ ...unobserved, bots: bots.map((row, i) => ({ ...row, name: fullName(i) })),
    connectors: connectors.map((row, i) => ({ ...row, name: fullName(i) })) });
  assert.ok(largest.truncated && largest.bots.length > 0 && largest.connectors.length > 0);
  assert.ok(wireBytes(largest, requestId) <= REQUEST_BYTE_LIMIT);
});
