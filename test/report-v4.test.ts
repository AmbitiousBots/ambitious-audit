import assert from "node:assert/strict";
import { test } from "node:test";
import weekly from "../schemas/examples/collector.v2/valid/weekly-activity.json" with { type: "json" };
import unobserved from "../schemas/examples/collector.v2/valid/unobserved.json" with { type: "json" };
import legacy from "./fixtures/shares.json" with { type: "json" };
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/domain/canonical.ts";
import { MCP_ENVELOPE_BYTES, RECEIVER_BYTE_LIMIT, REQUEST_BYTE_LIMIT } from "../src/domain/report-size.ts";
import type { CollectorV2BotUsage } from "../src/domain/wire.generated.ts";
import { parseCollector } from "../src/domain/input.ts";
import { assembleReport } from "../src/domain/report.ts";
import { isReportPayload } from "../src/domain/schema.ts";
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
  assert.equal(payload.visibility.find((entry) => entry.signal === "otherBots")?.seen, "partial");
  assert.match(payload.findings.find((item) => item.ruleId === "visibility-other-bots")?.summary ?? "", /Partially observed/);
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

test("current-period usage overrides an old last-active reading through collection time in a v1 snapshot", () => {
  const snapshot = (share: number, periodStart: string, periodEnd: string) => {
    const bot = { id: "queue", name: "Work queue", routineCount: null, lastActiveAt: "2026-10-01T00:00:00Z",
      usage: { unit: "share", period: "this_week", share, periodStart, periodEnd } };
    return report({ ...legacy, bots: [bot], routines: [],
      visibility: legacy.visibility.map((entry) => entry.signal === "routines" ? { ...entry, seen: false } : entry),
      evidence: [{ id: "ev-1", kind: "excerpt", source: bot.id, text: "Activity history from the account." }] });
  };
  for (const [share, start, end, idle] of [
    [0.25, "2026-11-09", "2026-11-16", false], [0.25, "2026-11-01", "2026-11-16", false],
    [0, "2026-11-09", "2026-11-16", true], [0.25, "2026-11-16", "2026-11-23", true],
    [0.25, "2026-10-01", "2026-10-08", true],
  ] as const) {
    const payload = snapshot(share, start + "T00:00:00Z", end + "T00:00:00Z");
    assert.equal(payload.findings.some((row) => row.ruleId === "bot-unused"), idle);
    assert.equal(payload.recommendations.some((row) => row.id === "bot-unused"), idle);
  }
});

test("bot rows retain each supplied share boundary for both exact shares and bounds", () => {
  for (const dates of [
    { periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-08T00:00:00Z" },
    { periodStart: "2026-11-08T00:00:00Z" }, { periodEnd: "2026-11-15T00:00:00Z" }, {},
  ]) {
    const bots = weekly.bots.map((bot, i) => ({
      ...bot, usage: { unit: "share", period: "last_7_days", ...(i ? { shareBelow: 0.01 } : { share: 0.42 }), ...dates },
    }));
    const payload = report({ ...weekly, bots });
    for (const row of payload.bots) {
      assert.equal(row.usagePeriodStart, dates.periodStart);
      assert.equal(row.usagePeriodEnd, dates.periodEnd);
    }
    const finding = payload.findings.find((item) => item.ruleId === "bots-barely-used");
    if (dates.periodStart?.startsWith("2026-10")) assert.equal(finding, undefined);
    else assert.match(finding?.summary ?? "", /measured period/);
  }
});

test("task and page readings determine coverage and visibility findings, including observed zeros", () => {
  for (const count of [0, 7]) {
    const tasks = { ...unobserved.tasks, closed7d: count };
    const pages = { ...unobserved.pages, count };
    const partial = report({ ...unobserved, tasks, pages });
    assert.deepEqual(partial.counts.tasks, tasks);
    assert.deepEqual(partial.counts.pages, pages);
    const readings = { ...unobserved, tasks: { open: 0, stale7d: 0, blocked: 0, closed7d: count }, pages: { count, updated7d: 0 } };
    const why = "The tool could read only the shared folder.";
    for (const seen of [false, "partial", true]) {
      const payload = report({ ...readings, visibility: readings.visibility.map((entry) =>
        ["tasks", "pages"].includes(entry.signal) ? { ...entry, seen, why } : entry) });
      for (const signal of ["tasks", "pages"]) {
        assert.deepEqual(payload.visibility.find((entry) => entry.signal === signal), { signal, seen: seen === true ? true : "partial", why });
        assert.equal(payload.findings.some((item) => item.ruleId === `visibility-${signal}`), seen !== true);
      }
    }
    const unseen = report({ ...unobserved, visibility: unobserved.visibility.map((entry) =>
      ["tasks", "pages"].includes(entry.signal) ? { ...entry, seen: "partial" } : entry) });
    for (const signal of ["tasks", "pages"]) {
      assert.equal(partial.visibility.find((entry) => entry.signal === signal)?.seen, "partial");
      assert.match(partial.findings.find((item) => item.ruleId === `visibility-${signal}`)?.summary ?? "", /Partially observed/);
      assert.equal(unseen.visibility.find((entry) => entry.signal === signal)?.seen, false);
    }
  }
});

test("failed runs cannot exceed measured runs on a routine or report", () => {
  const withRuns = (runs7d: number | null, failedRuns7d: number | null) => ({
    ...weekly, routines: weekly.routines.map((row) => ({ ...row, runs7d, failedRuns7d, lastRunAt: runs7d === 0 ? "never" : row.lastRunAt })),
    visibility: weekly.visibility.map((entry) => entry.signal === "routines" ? { ...entry, seen: "partial" } : entry),
  });
  assert.throws(() => parseCollector(withRuns(0, 3)), /\/routines\/0\/failedRuns7d.*failed-runs-range/);
  for (const [runs, failed] of [[0, 0], [2, 2], [null, 3], [2, null]] as const) {
    const payload = report(withRuns(runs, failed));
    assert.equal(payload.counts.routines.runs7d, runs);
    assert.equal(payload.counts.routines.failedRuns7d, failed);
  }
  const payload = report(weekly);
  assert.equal(isReportPayload({ ...payload, counts: { ...payload.counts, routines: { ...payload.counts.routines, runs7d: 0, failedRuns7d: 3 } } }), false);
});

test("routine totals and coverage agree with lastRunAt over the seven days through collection", () => {
  for (const [lastRunAt, runs7d, failedRuns7d, runs, failed] of [
    ["never", 4, 2, null, null], ["never", 4, 0, null, 0], ["never", 0, 0, 0, 0],
    ["2026-11-07T23:59:59Z", 1, 1, null, null], ["2026-11-07T23:59:59Z", 0, 0, 0, 0],
    ["2026-11-08T00:00:00Z", 0, 0, null, 0], ["2026-11-14T00:00:00Z", 0, 0, null, 0],
    [weekly.collectedAt, 0, 0, null, 0], [weekly.collectedAt, 2, 0, 2, 0],
  ] as const) {
    const payload = report({ ...weekly, routines: weekly.routines.map((row) => ({ ...row, lastRunAt, runs7d, failedRuns7d })) });
    assert.deepEqual(payload.counts.routines, { active: 1, paused: 0, failing: 0, runs7d: runs, failedRuns7d: failed });
    assert.equal(payload.visibility.find((entry) => entry.signal === "routines")?.seen, runs === null || failed === null ? "partial" : true);
  }
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

test("plan credits convert whole cents to dollars and preserve missing values", () => {
  const { extraCreditsLeftUsdCents, ...plan } = weekly.planUsage;
  for (const cents of [0, extraCreditsLeftUsdCents, 499, 99_999_999_999, 100_000_000_000, null]) {
    const planUsage = { ...plan, extraCreditsLeftUsdCents: cents };
    assert.deepEqual(report({ ...weekly, planUsage }).planUsage, { ...plan, extraCreditsLeftUsd: cents === null ? null : cents / 100 });
  }
  for (const cents of [-1, 0.000000001, 29.1, 100_000_000_001]) {
    assert.throws(() => parseCollector({ ...weekly, planUsage: { ...plan, extraCreditsLeftUsdCents: cents } }));
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

test("the report filters private text and keeps ordinary names across all five free-text fields", () => {
  const redact = [
    "desk@example.invalid", "https://sample:fixture@example.invalid/path", "https://example.invalid/items?q=sample",
    "sk-test-syntheticcredential", "a7B9c1D3e5F7g9H1i3J5k7L9", "client_secret=sample-value",
    '{"refresh_token":"sample-value"}', "path?option=one&userPassword=sample", "prefix-PASSWD-end: sample",
    "my_pwd_hint sample", "proxyAuthHeader sample", "'toolCredentials': 'sample'", "API key=sample",
    "nestedAPIKeyValue sample", '“private-key-file”：“sample”', "sessionId=sample", "cookieJar: sample",
    "currentBearerHeader sample", "ｔｏｋｅｎ＝sample", "accessToken sample", "`auth` = sample",
    '{"nested.token.setting":"sample"}', "auth[session]=sample", '"token" "sample"', "api_key: sample", "password sample",
    "Bearer sample.sample.sample", "Basic YWJjZA==", "Basic QUJD", "Digest deadbeef", "Token Ab3x", "basic abcdefghijklmnop",
    "+1 (202) 555-0148", "555-0182", "020/7946/0958", "２０２－５５５－０１４８", "202\u202f555\u20090148",
    "202−555—0148", "202\u00ad555\u00a00148", "٥٥٥.٠١٨٢", "1+(23)/45.67", "555⁄01·82",
  ];
  const keep = [
    "Basic Bookkeeping", "Basic Operations", "Digest Printing", "Token Studio", "Bearer Services",
    "Dental Care", "Tool & Die", "Market 24", "Repair Desk (123) 456", "Studio 7 / Suite 42",
    "Food Pantry", "Software Support", "Neighborhood Salon", "Café Services",
  ];
  for (const [values, privateValue] of [[redact, true], [keep, false]] as const) {
    for (const value of values) {
      const payload = report({
        ...weekly, bots: weekly.bots.map((bot) => ({ ...bot, name: value })),
        connectors: [{ name: value, status: "needsAuth" }],
        evidence: [{ id: "ev-1", kind: "excerpt", text: `Reading from ${value}`, source: value }],
        visibility: weekly.visibility.map((entry) => ({ ...entry, why: `Observed via ${value}` })),
      });
      const expected = privateValue ? "[redacted]" : value;
      assert.deepEqual(payload.bots.map((row) => row.name), weekly.bots.map(() => expected), value);
      assert.deepEqual(payload.connectors.map((row) => row.name), [expected], value);
      assert.deepEqual(payload.evidence, [{ id: "ev-1", source: expected, text: privateValue ? expected : `Reading from ${value}` }], value);
      assert.deepEqual(payload.visibility.map((entry) => entry.why), weekly.visibility.map(() => privateValue ? expected : `Observed via ${value}`), value);
      assert.deepEqual(payload.recommendations[0]?.evidenceIds, ["ev-1"], value);
    }
  }
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
  assert.deepEqual(activity(observed), ["partial", "partial"]);
  assert.deepEqual(activity({ ...observed, visibility: weekly.visibility.map((entry) =>
    entry.signal === "botActivity" ? { ...entry, seen: true } : entry) }), [true, true]);
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
  const metadataOnly = { ...planUsage, weeklyLimitUsedPercent: null, extraCreditsLeftUsdCents: null };
  assert.equal(seen({ ...unobserved, planUsage: metadataOnly }), false);
  assert.equal(seen({ ...unobserved, planUsage: { ...metadataOnly, extraCreditsLeftUsdCents: 0 } }), "partial");
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
    return name + "界".repeat(Math.floor(bytes / 3)) + " ".repeat(bytes % 3);
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

test("the platform tools/call body fits when the client escapes Unicode and spaces JSON separators", () => {
  const request = (payload: unknown, id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_report", arguments: payload } });
  const asciiBody = (payload: unknown, id: string) => JSON.stringify(request(payload, id), null, 1)
    .replace(/,\n */gu, ", ").replace(/\n */gu, "").replace(/[^\x20-\x7e]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
  const id = "a".repeat(MCP_ENVELOPE_BYTES - asciiBody(null, "").length + 4);
  const name = (index: number) => `Queue "${index}" 𠀀`.padEnd(18, "界") + "𠀀".repeat(50);
  const bots = Array.from({ length: 200 }, (_, index) => ({
    id: `bot-${index}`, name: name(index), usage: null, lastActiveAt: null, routineCount: null,
  }));
  const connectors = bots.map((bot) => ({ name: bot.name, status: "ok" }));
  const payload = report({ ...unobserved, bots, connectors });
  const { truncated, ...full } = payload;
  const uncapped = { ...full, bots: bots.map(({ name }) => ({ name, routineCount: null, lastActiveAt: null, usagePeriod: null, usageShare: null, usageShareBelow: null })), connectors };
  assert.ok(Buffer.byteLength(JSON.stringify(request(uncapped, id))) <= REQUEST_BYTE_LIMIT);
  assert.ok(asciiBody(uncapped, id).length > RECEIVER_BYTE_LIMIT);
  assert.equal(truncated, true);
  assert.deepEqual([payload.counts.bots, payload.counts.connectors.ok], [200, 200]);
  const body = asciiBody(payload, id);
  assert.deepEqual(JSON.parse(body), request(payload, id));
  assert.ok(Buffer.byteLength(body) <= RECEIVER_BYTE_LIMIT);
  assert.deepEqual(report({ ...unobserved, bots: bots.toReversed(), connectors: connectors.toReversed() }), payload);
});
