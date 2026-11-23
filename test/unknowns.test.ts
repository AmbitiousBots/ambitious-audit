import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { parseCollector } from "../src/domain/input.ts";
import { findingsFrom, recommendationsFrom } from "../src/domain/report.ts";
import { OWN_CONNECTOR_RULE_IDS, RULES } from "../src/domain/rule-pack.ts";
import { evaluateRules } from "../src/domain/rules.ts";
import type { VisibilitySignal } from "../src/domain/types.ts";

const base: unknown = JSON.parse(
  JSON.stringify({
    schemaVersion: 2,
    collectedAt: "2026-11-15T00:00:00Z",
    account: { kind: "owner", label: "Main" },
    bots: [
      { id: "bot-1", name: "Queue", lastActiveAt: "2026-11-14T08:00:00Z", routineCount: 2, usage: { unit: "percent", amount7d: 1 } },
      { id: "bot-2", name: "Desk", lastActiveAt: "never", routineCount: 0, usage: { unit: "percent", amount7d: 0 } },
    ],
    routines: [
      { id: "routine-1", botId: "bot-1", schedule: "every day at 08:00", runs7d: 0, failedRuns7d: 0, state: "paused", lastRunAt: "2026-11-01T00:00:00Z", pausedAt: "2026-11-02T00:00:00Z", usage: { unit: "percent", amount7d: 0 } },
      { id: "routine-2", botId: "bot-1", schedule: "every day at 08:00", runs7d: 1, failedRuns7d: 1, state: "failing", lastRunAt: "2026-11-14T08:00:00Z", usage: { unit: "percent", amount7d: 0 } },
    ],
    connectors: [
      { name: "calendar", status: "needsAuth" },
      { name: "documents", status: "needsGrant" },
    ],
    tasks: { closed7d: 0, open: 4, stale7d: 2, blocked: 1 },
    pages: { count: 3, updated7d: 1 },
    planUsage: { weeklyLimitUsedPercent: 0, extraCreditsLeftUsdCents: 0, observedAt: "2026-11-15T00:00:00Z", period: "this_week" },
    visibility: ["transcripts", "usage", "otherBots", "auditLog", "accountRole", "tasks", "pages", "botActivity", "routines"].map((signal) => ({ signal, seen: true, why: "Read with the bot's own tools." })),
    evidence: [
      { id: "ev-1", kind: "excerpt", text: "Never active.", sourceKind: "bot", source: "bot-2" },
      { id: "ev-2", kind: "excerpt", text: "Paused since the start of the month.", sourceKind: "routine", source: "routine-1" },
      { id: "ev-3", kind: "excerpt", text: "Failing.", sourceKind: "routine", source: "routine-2" },
      { id: "ev-4", kind: "excerpt", text: "Needs a sign-in.", sourceKind: "connector", source: "calendar" },
      { id: "ev-5", kind: "excerpt", text: "Not shared with this bot.", sourceKind: "connector", source: "documents" },
      { id: "ev-6", kind: "count", text: "2 stale tasks.", sourceKind: "tasks", source: "tasks" },
    ],
  }),
);

type Group = { readonly signal: VisibilitySignal; readonly rules: readonly string[]; readonly hide: (document: Record<string, unknown>) => void };

const each = (value: unknown, change: (item: Record<string, unknown>) => Record<string, unknown>): unknown => (Array.isArray(value) ? value.map((item) => (isRecord(item) ? change({ ...item }) : item)) : value);

const GROUPS: readonly Group[] = [
  { signal: "accountRole", rules: [], hide: (document) => (document.account = { kind: "unknown", label: "Main" }) },
  { signal: "tasks", rules: ["stale-tasks"], hide: (document) => (document.tasks = { open: null, stale7d: null, blocked: null }) },
  { signal: "pages", rules: [], hide: (document) => (document.pages = { count: null, updated7d: null }) },
  { signal: "botActivity", rules: ["bot-unused"], hide: (document) => (document.bots = each(document.bots, (bot) => ({ ...bot, lastActiveAt: null }))) },
  {
    signal: "routines",
    rules: [],
    hide: (document) => {
      document.bots = each(document.bots, (bot) => ({ ...bot, routineCount: null }));
      document.routines = each(document.routines, (routine) => ({ ...routine, lastRunAt: null }));
    },
  },
  {
    signal: "usage",
    rules: [],
    hide: (document) => {
      delete document.planUsage;
      document.bots = each(document.bots, (bot) => ({ ...bot, usage: null }));
      document.routines = each(document.routines, (routine) => ({ ...routine, usage: null }));
    },
  },
];

const GIVEN_IN_ANY_MODE = [...OWN_CONNECTOR_RULE_IDS, "stale-tasks"];

const ALWAYS = ["failing-routine", "connector-needs-auth", "connector-needs-grant", "paused-routine", "duplicate-routines"];

const documentWith = (hidden: readonly Group[], admitted: readonly Group[]): Record<string, unknown> => {
  const document: unknown = JSON.parse(JSON.stringify(base));
  if (!isRecord(document)) throw new Error("base");
  const copy = { ...document };
  for (const group of hidden) group.hide(copy);
  const unseen = new Set<unknown>(admitted.map((group) => group.signal));
  copy.visibility = each(copy.visibility, (entry) => (unseen.has(entry.signal) ? { ...entry, seen: false, why: "No tool showed this." } : entry));
  return copy;
};

const subsets = GROUPS.reduce<readonly (readonly Group[])[]>((found, group) => [...found, ...found.map((subset) => [...subset, group])], [[]]);

test("for every combination of unobserved groups, rules fire only on observed values and each gap becomes a visibility finding", () => {
  assert.equal(subsets.length, 64);
  for (const hidden of subsets) {
    const label = hidden.map((group) => group.signal).join("+") || "everything observed";
    const snapshot = parseCollector(documentWith(hidden, hidden));
    const hits = evaluateRules(snapshot, RULES);
    const findings = findingsFrom(snapshot, hits);
    const blind = new Set(hidden.flatMap((group) => group.rules));
    const expected = [...ALWAYS, ...GROUPS.flatMap((group) => group.rules)].filter((rule) => !blind.has(rule)).sort();
    assert.deepEqual(findings.filter((finding) => finding.kind === "rule").map((finding) => String(finding.ruleId)).sort(), expected, label);
    const gaps = new Set(hidden.map((group) => group.signal));
    if (gaps.has("routines")) gaps.add("usage");
    assert.equal(findings.filter((finding) => finding.kind === "visibility").length, gaps.size, label);
    const roleUnknown = hidden.some((group) => group.signal === "accountRole");
    for (const finding of findings.filter((item) => item.kind === "rule")) {
      assert.equal(finding.withheld, roleUnknown && !GIVEN_IN_ANY_MODE.includes(String(finding.ruleId)) ? "roleUnknown" : undefined, `${label}: ${finding.ruleId}`);
    }
    const recommended = recommendationsFrom(hits, new Set()).map((item) => String(item.recommendation.id));
    assert.ok(recommended.length <= 3, label);
    if (roleUnknown) assert.deepEqual(recommended, GIVEN_IN_ANY_MODE.filter((rule) => !blind.has(rule)), label);
  }
});

test("the rules given when the role is unknown are the two connector rules and stale-tasks, and a connector rule cites only evidence about a listed connector", () => {
  assert.deepEqual(OWN_CONNECTOR_RULE_IDS, ["connector-needs-auth", "connector-needs-grant"]);
  assert.deepEqual(RULES.filter((rule) => !rule.dependsOnRole).map((rule) => String(rule.id)).sort(), [...GIVEN_IN_ANY_MODE].sort());
  const roleGroup = GROUPS.filter((group) => group.signal === "accountRole");
  const document = documentWith(roleGroup, roleGroup);
  document.evidence = [
    ...(Array.isArray(document.evidence) ? document.evidence : []),
    { id: "ev-7", kind: "excerpt", text: "A second line about the calendar connector.", sourceKind: "connector", source: "Calendar" },
    { id: "ev-8", kind: "excerpt", text: "A line that only mentions the calendar connector.", sourceKind: "connector", source: "calendar tool" },
  ];
  const snapshot = parseCollector(document);
  const connectorNames = new Set(snapshot.connectors.map((connector) => connector.name.toLowerCase()));
  const sourceOf = new Map(snapshot.evidence.map((item) => [String(item.id), item.source.toLowerCase()]));
  const connectorHits = evaluateRules(snapshot, RULES).filter((hit) => OWN_CONNECTOR_RULE_IDS.includes(hit.rule.id));
  assert.deepEqual(connectorHits.map((hit) => [String(hit.rule.id), hit.withheld, hit.evidenceIds.map(String)]), [
    ["connector-needs-auth", false, ["ev-4", "ev-7"]],
    ["connector-needs-grant", false, ["ev-5"]],
  ]);
  for (const hit of connectorHits) {
    for (const id of hit.evidenceIds) assert.equal(connectorNames.has(sourceOf.get(id) ?? ""), true, id);
  }
});

test("a null whose visibility entry still says seen is refused, naming that entry, for every group", () => {
  for (const group of GROUPS) {
    assert.throws(
      () => parseCollector(documentWith([group], [])),
      (error) => error instanceof Failure && error.errors.some((entry) => entry.code === "E_INPUT_SCHEMA" && /\/visibility\/\d\/seen must be false/.test(entry.message) && entry.message.includes("rule: null-needs-visibility-gap")),
      group.signal,
    );
  }
});

test("the same collector document always normalises to the same bytes, whatever order its lists are in", () => {
  const partial: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "partial.json"), "utf8"));
  if (!isRecord(partial)) throw new Error("fixture");
  const reversed = Object.fromEntries(Object.entries(partial).map(([key, value]) => [key, Array.isArray(value) ? [...value].reverse() : value]));
  assert.equal(JSON.stringify(parseCollector(reversed)), JSON.stringify(parseCollector(partial)));
});
