import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import weekly from "../schemas/examples/collector.v2/valid/weekly-activity.json" with { type: "json" };
import unobserved from "../schemas/examples/collector.v2/valid/unobserved.json" with { type: "json" };
import legacy from "./fixtures/shares.json" with { type: "json" };
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/domain/canonical.ts";
import { MCP_ENVELOPE_BYTES, RECEIVER_BYTE_LIMIT, REQUEST_BYTE_LIMIT } from "../src/domain/report-size.ts";
import type { CollectorV2BotUsage } from "../src/domain/wire.generated.ts";
import { parseCollector } from "../src/domain/input.ts";
import { assembleReport, findingsFrom, recommendationsFrom } from "../src/domain/report.ts";
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

test("cited bot observations describe the supplied usage interval", () => {
  const periodStart = "2026-10-01T00:00:00Z";
  const periodEnd = "2026-10-08T00:00:00Z";
  for (const dates of [{ periodStart, periodEnd }, { periodStart }, { periodEnd }]) {
    for (const reading of [{ share: 0.004 }, { shareBelow: 0.01 }, { share: 0 }, { share: 0.3 }]) {
      const bots = [{ id: "queue", name: "Work queue", lastActiveAt: "never", routineCount: 0,
        usage: { unit: "share", period: "last_7_days", ...reading, ...dates } }];
      const evidence = [{ id: "ev-24", kind: "count", sourceKind: "bot", source: "queue" }];
      const payload = report({ ...weekly, bots, routines: [], evidence });
      const observation = payload.evidence[0];
      assert.ok(observation);
      assert.deepEqual(payload.findings.find((item) => item.ruleId === "bot-unused")?.evidenceIds, [observation.id]);
      for (const boundary of Object.values(dates)) assert.ok(observation.text.includes(boundary), observation.text);
      assert.doesNotMatch(observation.text, /last 7 days/u);
    }
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
    for (const seen of [false, "partial", true]) {
      const payload = report({ ...readings, visibility: readings.visibility.map((entry) =>
        ["tasks", "pages"].includes(entry.signal) ? { ...entry, seen, scope: "shared_only", why: "No counts were returned." } : entry) });
      for (const signal of ["tasks", "pages"]) {
        const visibility = payload.visibility.find((entry) => entry.signal === signal);
        assert.equal(visibility?.seen, "partial");
        assert.match(visibility?.why ?? "", /Observed .*tasks|Observed page count/u);
        assert.match(visibility?.why ?? "", /limited to shared folders/u);
        assert.ok(payload.findings.some((item) => item.ruleId === `visibility-${signal}`));
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
  const fullySeen = weekly.visibility.map((entry) => entry.signal === "usage" ? { ...entry, seen: true, scope: "all" } : entry);
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

test("only gated display names reach the assembled report from collector text", () => {
  const withheld = [
    "glpat-abcdefghijklmnopqrst", "glpat-abcdefgh", "casey(at)example.invalid", "PIN 1234", "casey[dot]test", "Access Code",
    "Maker's Co-op (North), Ltd.", "Team 12 and 34",
    "desk@example.invalid", "https://sample:fixture@example.invalid/path", "https://example.invalid/items?q=sample",
    "sk-test-syntheticcredential", "a7B9c1D3e5F7g9H1i3J5k7L9", "client_secret=sample-value",
    '{"refresh_token":"sample-value"}', "path?option=one&userPassword=sample", "prefix-PASSWD-end: sample",
    "my_pwd_hint sample", "proxyAuthHeader sample", "'toolCredentials': 'sample'", "API key=sample",
    "nestedAPIKeyValue sample", '“private-key-file”：“sample”', "sessionId=sample", "cookieJar: sample",
    "currentBearerHeader sample", "ｔｏｋｅｎ＝sample", "accessToken sample", "`auth` = sample",
    '{"nested.token.setting":"sample"}', "auth[session]=sample", '"token" "sample"', "api_key: sample", "password sample",
    "Bearer sample.sample.sample", "Basic YWJjZA==",
    "+1 (202) 555-0148", "555-0182", "020/7946/0958", "２０２－５５５－０１４８", "202\u202f555\u20090148",
    "202−555—0148", "202\u00ad555\u00a00148", "٥٥٥.٠١٨٢", "1+(23)/45.67", "555⁄01·82",
    "Bearer dev_test-42", "OTP: 123456", "1-800-EXAMPLE", "202‑555‑0148", '{"token":"sample-value"}',
    "refresh-token", "refresh-token sample", "access_token", "Token", "Bearer", "key 42", "key12", "API-Key",
    "Repair Desk (123) 456", "Studio 7 / Suite 42", "Device AB12", "Fullwidth ＠ sample",
    "Scope {sample}", "Quoted \"sample\"", "Mixed🔒name", "Tab\tName", "Trailing newline\n",
    "Basic Yjplcmlj", "Yjplcmlj", "Desk-Yjplcmlj", "YTpzYW1wbGU", "YTpzYW1wbGVzIQ",
    ...["Basic", "bEaReR", "Digest", "Token"].flatMap((scheme) =>
      ["Og", "YTo", "Yjpw", "YWI6Yw", "YWI6Y2Q"].map((word) => `${scheme} ${word}`)),
    "desk at example dot invalid", "desk AT DOT invalid", "desk at example dot", "desk (at) example (dot) invalid",
    "desk dot mail at example", "Desk B2B", "3D B2B", "3DAB Printing", "12D Printing",
  ];
  const keep = [
    "Authentic Catering", "Author Services", "Cookie Bakery", "Basic Bookkeeping", "Basic Operations", "Digest Printing",
    "Basic Plan", "Token Services", "Bearer Services", "Token Studio", "Basic QUJD", "Digest deadbeef",
    "Token Ab3x", "basic abcdefghijklmnop", "Basic A", "Basic YjpwA", "Basic OiAB", "Yjpw",
    "Dental Care", "Tool & Die", "Market 24", "Food Pantry", "Software Support", "Neighborhood Salon", "Café Services",
    "O’Brien Plumbing", "हिन्दी सेवा", "Maker's Co-op",
    "3D Printing", "B2B Services", "Dot Matrix", "Service at Home",
    btoa("sample"), btoa("b:sub\x01"), btoa("abc\x98:d"), "YjplcmljA",
  ];
  const build = (value: string) => report({
    ...weekly, bots: weekly.bots.map((bot) => ({ ...bot, name: value })),
    connectors: [{ name: value, status: "needsAuth" }],
    evidence: [{ id: "ev-482913", sourceKind: "connector", kind: "excerpt", text: `Reading from ${value}`, source: value }],
    visibility: weekly.visibility.map((entry) => ({ ...entry, why: `Observed via ${value}` })),
  });
  const { bots: _bots, connectors: _connectors, ...baseline } = build("Sample");
  for (const value of [...withheld, ...keep]) {
    const { bots, connectors, ...rest } = build(value);
    const reject = withheld.includes(value);
    for (const [i, bot] of bots.entries()) {
      assert.equal(bot.name, reject ? `Bot ${i + 1}` : value.replaceAll("’", "'"), value);
      assert.equal(bot.nameWithheld, reject ? true : undefined, value);
    }
    assert.deepEqual(connectors, [reject ? { name: "Connector 1", nameWithheld: true, status: "needsAuth" }
      : { name: value.replaceAll("’", "'"), status: "needsAuth" }], value);
    assert.deepEqual(rest, baseline, value);
    assert.deepEqual(rest.evidence, [{ id: "ev-1", source: "Connector 1", text: "The connector reported status needsAuth." }]);
    assert.deepEqual(rest.recommendations[0]?.evidenceIds, ["ev-1"]);
    assert.doesNotMatch(JSON.stringify(rest), /Reading from|Observed via|482913/u);
  }
});

test("a v1 snapshot retains local prose and IDs while its new report uses task readings and report IDs", () => {
  const note = "Local observation";
  const { usageOther: _aggregate, ...base } = legacy;
  const input = { ...base, account: { ...legacy.account, label: note },
    bots: ["tasks", "b", "c"].map((id) => ({ id, name: "Queue", lastActiveAt: null, routineCount: 0, usage: { unit: "percent", amount7d: 0.5 } })),
    routines: [], tasks: { open: 12, stale7d: 12, blocked: 0 },
    visibility: legacy.visibility.map((entry) => ({ ...entry, why: note })),
    evidence: [{ id: "ev-482913", kind: "count", source: "tasks", text: note }] };
  const snapshot = parseCollector(input);
  assert.deepEqual(snapshot.evidence, input.evidence);
  assert.ok(snapshot.visibility.every((entry) => entry.why === note));
  const payload = report(snapshot);
  assert.doesNotMatch(JSON.stringify(payload), /Local observation|482913/u);
  assert.deepEqual(payload.recommendations.map((item) => [item.id, item.evidenceIds]), [["stale-tasks", ["ev-1"]]]);
  assert.deepEqual(payload.evidence, [{ id: "ev-1", source: "Task counts", text: "Open tasks stale for seven days: 12." }]);
});

test("name limits count normalized code points, letters, words and ASCII digits", () => {
  const atLimit = ["𠀀".repeat(16), "𠀀".repeat(16), "𠀀".repeat(6)].join(" ");
  for (const [value, allowed] of [
    [atLimit, true], [atLimit + "𠀀", false], ["𠀀".repeat(17), false], ["One two three four five", true],
    ["One two three four five six", false], ["Area a2", true], ["Studio 12", true], ["Desk 1 and 23", false],
    ["Ｑｕｅｕｅ ７", true], ["Desḱ", true], ["Desk ́", false], ["Key Desk", false], ["AccessPin", false],
  ] as const) {
    const payload = report({ ...weekly, connectors: [{ name: value, status: "ok" }] });
    assert.deepEqual(payload.connectors[0], allowed ? { name: value.normalize("NFKC"), status: "ok" }
      : { name: "Connector 1", nameWithheld: true, status: "ok" }, value);
  }
});

test("withheld labels use positions in the sorted inventories", () => {
  const bots = ["z", "a", "m"].map((id) => ({ id, name: id === "m" ? "Queue" : "Queue @ Intake", usage: null, lastActiveAt: null, routineCount: null }));
  const connectors = ["Z / Queue", "Mail", "A / Queue"].map((name) => ({ name, status: "ok" }));
  const payload = report({ ...unobserved, bots, connectors });
  assert.deepEqual(payload.bots.map(({ name }) => name), ["Bot 1", "Queue", "Bot 3"]);
  assert.deepEqual(payload.connectors.map(({ name }) => name), ["Connector 1", "Mail", "Connector 3"]);
  assert.deepEqual(report({ ...unobserved, bots: bots.toReversed(), connectors: connectors.toReversed() }), payload);
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
    visibility: weekly.visibility.map((entry) => entry.signal === "usage" ? { ...entry, seen: true, scope: "all" } : entry),
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

test("aggregate bots need listed routine counts before the inventory can be complete", () => {
  const named = { id: "named", name: "Queue", routineCount: 0, lastActiveAt: "never",
    usage: { unit: "share", period: "last_7_days", share: 0.8 } };
  const other = { ...named, id: "other", usage: null };
  const visibility = weekly.visibility.map((entry) => entry.signal === "routines" ? { ...entry, seen: "partial", scope: "shared_only" } : entry);
  const base = { ...weekly, visibility, routines: [], usageOther: { share: 0.2, botCount: 1 } };
  for (const input of [
    { ...base, bots: [named], usageOther: { share: 0.2, botCount: 3 } },
    { ...base, bots: [named], visibility: weekly.visibility },
    { ...base, bots: [named, { ...other, routineCount: null }] },
  ]) {
    const payload = report(input);
    assert.deepEqual(payload.counts.routines, { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null });
    for (const signal of ["otherBots", "routines"]) assert.equal(payload.visibility.find((entry) => entry.signal === signal)?.seen, "partial");
    assert.match(payload.visibility.find((entry) => entry.signal === "otherBots")?.why ?? "", /Missing full bot inventory/u);
  }
  const accounted = report({ ...base, bots: [named, other] });
  assert.equal(accounted.visibility.find((entry) => entry.signal === "otherBots")?.seen, true);
  assert.deepEqual(accounted.counts.routines, { active: 0, paused: 0, failing: 0, runs7d: 0, failedRuns7d: 0 });
});

test("a routine owned by an unlisted bot makes both inventories partial", () => {
  const bots = weekly.bots.slice(0, 1).map((bot) => ({ ...bot, routineCount: 0 }));
  const routines = weekly.routines.map((routine) => ({ ...routine, botId: "unlisted" }));
  for (const seen of [true, false]) {
    const visibility = weekly.visibility.map((entry) => entry.signal === "otherBots" ? { ...entry, seen } : entry);
    const payload = report({ ...weekly, bots, routines, visibility });
    assert.deepEqual(payload.counts.routines, { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null });
    for (const signal of ["otherBots", "routines"]) assert.equal(payload.visibility.find((entry) => entry.signal === signal)?.seen, "partial");
  }
});

test("all findings and recommendations retain evidence when four rules compete for 30 rows", () => {
  const bots = Array.from({ length: 10 }, (_, i) => ({ id: `bot-${i}`, name: "Work queue", routineCount: 1, lastActiveAt: null,
    usage: { unit: "share", period: "last_7_days", shareBelow: 0.01 } }));
  const routines = bots.map((bot, i) => ({ ...weekly.routines[0], id: `routine-${i}`, botId: bot.id, state: "failing" }));
  const connectors = ["needsAuth", "needsGrant"].flatMap((status) => bots.map((_, i) => ({ name: `${status} ${i}`, status })));
  const evidence = [
    ...bots.map(({ id }) => ({ source: id, sourceKind: "bot" })),
    ...routines.map(({ id }) => ({ source: id, sourceKind: "routine" })),
    ...connectors.map(({ name }) => ({ source: name, sourceKind: "connector" })),
  ].map((row, i) => ({ ...row, id: `ev-${i + 1}`, kind: "count" }));
  const payload = report({ ...weekly, bots, connectors, evidence, routines });
  const kept = new Set(payload.evidence.map((row) => row.id));
  assert.equal(kept.size, 30);
  assert.equal(payload.recommendations.length, 3);
  assert.ok(payload.findings.some((row) => row.ruleId === "bots-barely-used" && row.evidenceIds.length > 0));
  for (const row of [...payload.findings, ...payload.recommendations]) {
    if (!("kind" in row) || row.kind === "rule") assert.ok(row.evidenceIds.length > 0);
    for (const id of row.evidenceIds) assert.ok(kept.has(id), id);
  }
});

test("coverage uses readings even when seen stays partial, and retains the explicit access scope", () => {
  const input = { ...unobserved, pages: { count: 3, updated7d: null },
    visibility: unobserved.visibility.map((entry) => entry.signal === "pages"
      ? { ...entry, seen: "partial", why: "No page counts were observed.", scope: "shared_only" } : entry) };
  const pages = report(input).visibility.find((entry) => entry.signal === "pages");
  assert.deepEqual(pages, { signal: "pages", seen: "partial", why: "Observed page count. Missing seven-day page updates. Access limited to shared folders." });
  for (const [scope, phrase] of [["all", "Account-wide access."], ["limited", "Access limited to part of the account."]] as const) {
    const scoped = report({ ...input, visibility: input.visibility.map((entry) => ({ ...entry, scope })) });
    assert.ok(scoped.visibility.every(({ why }) => why.endsWith(phrase)));
    assert.equal(scoped.visibility.find(({ signal }) => signal === "accountRole")?.seen, true);
  }
  const mixed = { ...weekly, usageOther: { share: 0.1 }, bots: [...weekly.bots, {
    id: "credits", name: "Credits", lastActiveAt: null, routineCount: null, usage: { unit: "credits", amount7d: 1 },
  }], visibility: weekly.visibility.map((entry) => ["usage", "routines"].includes(entry.signal) ? { ...entry, seen: false } : entry) };
  const usage = report(parseCollector(mixed)).visibility.find((entry) => entry.signal === "usage");
  assert.match(usage?.why ?? "", /bounds.*bot credits.*weekly limit/u);
  assert.match(usage?.why ?? "", /Access limited to shared folders/u);
});

test("a combined other-bot share establishes partial visibility with one listed bot", () => {
  const payload = report({ ...unobserved, bots: weekly.bots.slice(0, 1), usageOther: { share: 0.4, botCount: 3 } });
  const other = payload.visibility.find((entry) => entry.signal === "otherBots");
  assert.equal(other?.seen, "partial");
  assert.match(other.why, /combined other-bot share/);
});

test("an all-null plan has the same readings and visibility as an omitted plan", () => {
  const empty = { weeklyLimitUsedPercent: null, extraCreditsLeftUsdCents: null, observedAt: null, period: null };
  for (const base of [unobserved, { ...unobserved, weeklyLimitUsed: legacy.weeklyLimitUsed }]) {
    assert.deepEqual(parseCollector({ ...base, planUsage: empty }), parseCollector(base));
    assert.deepEqual(report({ ...base, planUsage: empty }), report(base));
  }
});

test("weekly plan readings merge only for the same week and observation instant", () => {
  const weeklyLimitUsed = { percent: 37, asOf: "2026-11-15T00:00:00Z" };
  const plan = { ...weekly.planUsage, weeklyLimitUsedPercent: null };
  const from = (planUsage: unknown) => report({ ...weekly, weeklyLimitUsed, planUsage }).planUsage;
  assert.deepEqual(from(plan), { weeklyLimitUsedPercent: 37, extraCreditsLeftUsd: 0.29, observedAt: plan.observedAt, period: "this_week" });
  assert.equal(from({ ...plan, observedAt: "2026-11-14T00:00:00Z" })?.weeklyLimitUsedPercent, null);
  assert.equal(from({ ...plan, period: "last_7_days" })?.weeklyLimitUsedPercent, null);
  assert.equal(from({ ...plan, weeklyLimitUsedPercent: 0 })?.weeklyLimitUsedPercent, 0);
});

test("the low-usage recommendation requires evidence for an exact qualifying bot ID", () => {
  const bots = ["queue", "Queue", "desk", "work"].map((id) => ({
    id, name: "Work queue", lastActiveAt: null, routineCount: 0,
    usage: { unit: "share", period: "last_7_days", share: id === "Queue" ? 0.985 : 0.005 },
  }));
  const build = (source: string) => report({ ...unobserved, bots,
    evidence: [{ id: "ev-1", kind: "count", sourceKind: "bot", source, text: "Weekly usage reading." }] });
  const wrong = build("Queue");
  assert.deepEqual(wrong.findings.find((row) => row.ruleId === "bots-barely-used")?.evidenceIds, []);
  assert.deepEqual(wrong.recommendations, []);
  const right = build("queue").recommendations[0];
  assert.equal(right?.id, "bots-barely-used");
  assert.deepEqual(right.evidenceIds, ["ev-1"]);
  assert.equal(right.why, "Check whether the measured usage is expected for each bot's work.");
});

test("repeated local evidence for one bot leaves a citation for each qualifying bot", () => {
  const bots = weekly.bots.slice(0, 3).map((bot) => ({ ...bot, usage: { unit: "share", period: "last_7_days", shareBelow: 0.01 } }));
  const evidence = bots.flatMap((bot, i) => Array.from({ length: i === 0 ? 10 : 1 }, (_, j) => ({
    id: `ev-${100 + i * 10 + j}`, kind: "count", sourceKind: "bot", source: bot.id,
  })));
  const snapshot = parseCollector({ ...weekly, bots, evidence });
  const hits = evaluateRules(snapshot, RULES);
  const localIds = evidence.slice(0, 10).map((row) => row.id);
  assert.deepEqual(findingsFrom(snapshot, hits).find((item) => item.ruleId === "bots-barely-used")?.evidenceIds, localIds);
  assert.deepEqual(recommendationsFrom(hits, new Set()).find((item) => item.recommendation.id === "bots-barely-used")?.recommendation.evidenceIds, localIds);
  const payload = report(snapshot);
  assert.deepEqual(payload.evidence.map((row) => row.source), ["Bot 1", "Bot 2", "Bot 3"]);
  const ids = payload.evidence.map((row) => row.id);
  assert.deepEqual(payload.recommendations.find((item) => item.id === "bots-barely-used")?.evidenceIds, ids);
  assert.deepEqual(payload.findings.find((item) => item.ruleId === "bots-barely-used")?.evidenceIds, ids);
});

test("a bot named tasks and task counts can only cite evidence of their own kind", () => {
  const bots = ["tasks", "b", "c"].map((id) => ({ id, name: "Queue", usage: { unit: "percent", amount7d: 0.5 }, routineCount: 0, lastActiveAt: null }));
  const base = { ...unobserved, bots, tasks: { ...unobserved.tasks, open: 12, stale7d: 12 } };
  const row = { id: "ev-482913", kind: "count", source: "tasks", text: "A local note." };
  for (const sourceKind of ["tasks", "bot", undefined]) {
    const evidence = [sourceKind ? { ...row, sourceKind } : row];
    const payload = report({ ...base, evidence });
    const ids = payload.recommendations.map((item) => item.id);
    assert.deepEqual(ids, sourceKind === "tasks" ? ["stale-tasks"] : sourceKind === "bot" ? ["bots-barely-used"] : []);
    assert.deepEqual(payload.evidence.map((item) => item.source), sourceKind === "tasks" ? ["Task counts"] : sourceKind === "bot" ? ["Bot 3"] : []);
    assert.doesNotMatch(JSON.stringify(payload), /482913|A local note/u);
  }
});

const request = (payload: unknown, id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_report", arguments: payload } });

const asciiJson = (value: unknown): string => JSON.stringify(value, null, 1)
  .replace(/,\n */gu, ", ").replace(/\n */gu, "").replace(/[^\x20-\x7e]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));

const secondEncoder = (value: unknown): string => {
  const encoded = spawnSync("python3", ["-c", "import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin)))"],
    { input: JSON.stringify(value), encoding: "utf8" });
  if (encoded.error && "code" in encoded.error && encoded.error.code === "ENOENT") return asciiJson(value);
  assert.ifError(encoded.error);
  assert.equal(encoded.status, 0, encoded.stderr);
  return encoded.stdout;
};

test("tiny shares and percentages have bounded precision without turning positive usage into zero", () => {
  const readings = [
    { unit: "share", period: "last_7_days", share: 1e-7 }, { unit: "share", period: "last_7_days", shareBelow: 1e-7 },
    { unit: "share", period: "last_7_days", share: 0.23456 }, { unit: "share", period: "last_7_days", shareBelow: 0.23451 },
    { unit: "percent", amount7d: Number.MIN_VALUE }, { unit: "percent", amount7d: 31.234567 }, { unit: "percent", amount7d: 0 },
  ];
  const bots = readings.map((usage, i) => ({ id: String(i), name: "Queue", lastActiveAt: null, routineCount: null, usage }));
  const payload = report({ ...unobserved, bots, planUsage: { ...weekly.planUsage, weeklyLimitUsedPercent: 0.00010004 } });
  assert.deepEqual(payload.bots.map((row) => [row.usageShare, row.usageShareBelow]),
    [[null, 0.0001], [null, 0.0001], [0.2346, null], [null, 0.2346], [null, 0.0001], [0.3123, null], [0, null]]);
  assert.equal(payload.planUsage?.weeklyLimitUsedPercent, 0.0001);
  assert.doesNotMatch(secondEncoder(payload), /:\s*\d+(?:\.\d+)?e[+-]?\d/iu);
});

test("a full inventory fits the MCP body in UTF-8 and a second ASCII-escaping encoder", () => {
  const bots = Array.from({ length: 200 }, (_, i) => ({
    id: `bot-${i}`, name: String.fromCharCode(0x4e00 + i) + "𠀀".repeat(15) + " " + "𠀀".repeat(16) + " " + "𠀀".repeat(6),
    usage: { unit: "share", period: "last_7_days", share: i === 199 ? 0.9999801 : 1e-7,
      periodStart: "2026-11-08T00:00:00.000Z", periodEnd: "2026-11-15T00:00:00.000Z" },
    lastActiveAt: "2026-11-14T00:00:00.000Z", routineCount: 12,
  }));
  const connectors = bots.map(({ name }) => ({ name, status: "ok" }));
  const payload = report({ ...unobserved, bots, connectors });
  assert.equal(payload.truncated, true);
  assert.ok(payload.bots.length > 0 && payload.connectors.length > 0);
  assert.deepEqual([payload.counts.bots, payload.counts.connectors.ok], [200, 200]);
  assert.ok([...payload.bots, ...payload.connectors].every((row) => row.nameWithheld === undefined));
  assert.deepEqual(report({ ...unobserved, bots: bots.toReversed(), connectors: connectors.toReversed() }), payload);

  for (const [encode, limit] of [[JSON.stringify, REQUEST_BYTE_LIMIT], [secondEncoder, RECEIVER_BYTE_LIMIT]] as const) {
    const overhead = Buffer.byteLength(encode(request(null, ""))) - 4;
    const envelope = request(payload, "a".repeat(MCP_ENVELOPE_BYTES - overhead));
    const wire = encode(envelope);
    assert.deepEqual(JSON.parse(wire), envelope);
    assert.ok(Buffer.byteLength(wire) <= limit);
  }
  const prettyEnvelope = request(payload, "id");
  const prettyEscaped = (value: unknown) => JSON.stringify(value, null, 10).replaceAll("\n", "\r\n").replace(/"(?:[^"\\]|\\.)*"/gu, (literal: string) => {
    const units: string = JSON.parse(literal);
    return '"' + units.split("").map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0")).join("") + '"';
  });
  const fullyEscaped = prettyEscaped(prettyEnvelope);
  assert.deepEqual(JSON.parse(fullyEscaped), prettyEnvelope);
  assert.ok(Buffer.byteLength(fullyEscaped) + MCP_ENVELOPE_BYTES <= RECEIVER_BYTE_LIMIT);
  const uncapped = { ...payload, bots: bots.map(({ name }) => ({ ...payload.bots[0], name })), connectors };
  const bytes = Buffer.byteLength(prettyEscaped(uncapped)) + MCP_ENVELOPE_BYTES;
  assert.ok(bytes > RECEIVER_BYTE_LIMIT, String(bytes));
});
