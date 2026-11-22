import type { Rng } from "@ambitious/kit/domain/clock";
import { canonicalJson, visibilityOf } from "./canonical.ts";
import { completeRoutineList, planUsageOf } from "./coverage.ts";
import { fitReportLists } from "./report-size.ts";
import { reportText } from "./report-text.ts";
import type { RuleHit } from "./rules.ts";
import { isReportPayload } from "./schema.ts";
import { addDays, formatTimestamp, parseTimestamp } from "./time.ts";
import type {
  Announcement,
  CollectorInput,
  EvidenceId,
  Finding,
  Priority,
  Recommendation,
  Recommendations,
  ReportEvidence,
  ReportId,
  RuleId,
  SendReportPayload,
  Severity,
  Sha256Hex,
  VisibilityMap,
  VisibilitySignal,
} from "./types.ts";
import { isRecommendationId, isRuleId, isSemVer, WIRE_LIMITS } from "./types.ts";
import { entropyHex, reportIdFrom } from "./uuid.ts";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const priorityOf = (severity: Severity): Priority => severity === "high" ? "high" : "low";

export const selectAnnouncements = (items: readonly Announcement[]): readonly Announcement[] => {
  const byId = new Map<string, Announcement>();
  for (const { id, priority, title } of items) {
    if (!byId.has(id)) byId.set(id, { id, priority, title });
  }
  return [...byId.values()]
    .sort((left, right) => Number(right.priority === "high") - Number(left.priority === "high"))
    .slice(0, WIRE_LIMITS.announcements);
};

const SIGNALS: Readonly<Record<VisibilitySignal, { readonly id: string; readonly name: string }>> = {
  transcripts: { id: "visibility-transcripts", name: "conversation text" },
  usage: { id: "visibility-usage", name: "bot, routine and plan usage" },
  otherBots: { id: "visibility-other-bots", name: "other bots" },
  auditLog: { id: "visibility-audit-log", name: "the audit log" },
  accountRole: { id: "visibility-account-role", name: "the account role" },
  tasks: { id: "visibility-tasks", name: "task counts" },
  pages: { id: "visibility-pages", name: "page counts" },
  botActivity: { id: "visibility-bot-activity", name: "when each bot was last active" },
  routines: { id: "visibility-routines", name: "routine counts and run times" },
};

const visibilityRuleId = (signal: VisibilitySignal): RuleId => {
  const id = SIGNALS[signal].id;
  if (!isRuleId(id)) throw new Error(`The visibility finding id for ${signal} is not a rule id.`);
  return id;
};

export type RankedRecommendation = { readonly recommendation: Recommendation; readonly fingerprint: RuleHit["fingerprint"] };

const cited = (ids: readonly EvidenceId[]): Recommendation["evidenceIds"] | null => {
  const [first, ...rest] = ids;
  if (first === undefined) return null;
  return [first, ...rest];
};

export const capRecommendations = (items: readonly Recommendation[]): Recommendations => {
  const first = items[0];
  const second = items[1];
  const third = items[2];
  if (first === undefined) return [];
  if (second === undefined) return [first];
  if (third === undefined) return [first, second];
  return [first, second, third];
};

const orderedHits = (hits: readonly RuleHit[]): readonly RuleHit[] =>
  [...hits].sort((left, right) => SEVERITY_ORDER[left.rule.severity] - SEVERITY_ORDER[right.rule.severity] || left.rule.rank - right.rule.rank || (left.rule.id < right.rule.id ? -1 : 1));

export const ruleFinding = (item: RuleHit): Finding => ({
  kind: "rule",
  ruleId: item.rule.id,
  severity: item.rule.severity,
  priority: priorityOf(item.rule.severity),
  evidenceIds: item.evidenceIds,
  summary: item.summary,
  ...(item.withheld ? { withheld: "roleUnknown" as const } : {}),
});

const visibilityFindings = (visibility: VisibilityMap): readonly Finding[] =>
  visibility
    .filter((entry) => entry.seen !== true)
    .map((entry) => ({
      kind: "visibility" as const,
      ruleId: visibilityRuleId(entry.signal),
      severity: "low" as const,
      priority: "low" as const,
      evidenceIds: [],
      summary: entry.seen === "partial" ? `Partially observed: ${SIGNALS[entry.signal].name}.` : `Not observed: ${SIGNALS[entry.signal].name}. Findings cover only what the bot could see.`,
    }));

export const findingsFrom = (snapshot: CollectorInput, hits: readonly RuleHit[], visibility = visibilityOf(snapshot)): readonly Finding[] =>
  [...orderedHits(hits).map(ruleFinding), ...visibilityFindings(visibility)].slice(0, 20);

export const withheldRules = (hits: readonly RuleHit[]): readonly RuleId[] =>
  orderedHits(hits)
    .filter((item) => item.withheld)
    .map((item) => item.rule.id);

export const recommendationsFrom = (hits: readonly RuleHit[], suppressed: ReadonlySet<string>): readonly RankedRecommendation[] => {
  const ranked: RankedRecommendation[] = [];
  for (const item of orderedHits(hits)) {
    if (item.withheld || suppressed.has(item.fingerprint)) continue;
    const evidenceIds = cited(item.evidenceIds);
    if (evidenceIds === null || !isRecommendationId(item.rule.id)) continue;
    ranked.push({
      fingerprint: item.fingerprint,
      recommendation: { id: item.rule.id, priority: priorityOf(item.rule.severity), title: item.rule.title, why: item.rule.why, evidenceIds, effort: item.rule.effort },
    });
  }
  return ranked.slice(0, WIRE_LIMITS.recommendations);
};

const summaryOf = (findings: readonly Finding[], visibility: VisibilityMap, withheld: number): string => {
  const partial = visibility.filter((entry) => entry.seen === "partial").map((entry) => SIGNALS[entry.signal].name);
  const unseen = visibility.filter((entry) => entry.seen === false).map((entry) => SIGNALS[entry.signal].name);
  const fromRules = findings.filter((finding) => finding.kind === "rule");
  const body = fromRules.length === 0 ? "No rule matched what the bot could observe." : fromRules.map((finding) => finding.summary).join(" ");
  const role = visibility.some((entry) => entry.signal === "accountRole" && entry.seen !== true)
    ? ` The account role is unknown, so recommendations that depend on it are withheld (${withheld} in this report).`
    : "";
  const gaps = [
    ...(unseen.length ? [`Not observed: ${unseen.join(", ")}.`] : []),
    ...(partial.length ? [`Partially observed: ${partial.join(", ")}.`] : []),
  ];
  const tail = gaps.length ? gaps.join(" ") : "Every listed signal was visible.";
  const summary = `${body}${role} ${tail}`;
  return summary.length <= WIRE_LIMITS.summaryCharacters ? summary : `${summary.slice(0, WIRE_LIMITS.summaryCharacters - 1)}…`;
};

const allocateEvidence = (snapshot: CollectorInput, findings: readonly Finding[], ranked: readonly RankedRecommendation[]) => {
  const available = new Map<string, CollectorInput["evidence"][number]>(snapshot.evidence.map((row) => [row.id, row]));
  const selected = new Set<EvidenceId>();
  const items = [...ranked.map((item) => item.recommendation), ...findings];
  const references = items.map((item) => item.evidenceIds.filter((id) => available.has(id)));
  // WHY: Reserve one row per cited item before filling the remaining slots in rank order.
  for (const ids of references) {
    const first = ids[0];
    if (first !== undefined) selected.add(first);
  }
  for (const ids of references) {
    for (const id of ids) {
      if (selected.size < 30) selected.add(id);
    }
  }

  const evidence: ReportEvidence[] = [];
  for (const id of selected) {
    const row = available.get(id);
    if (row) evidence.push({ id, text: reportText(row.text), source: reportText(row.source) });
  }
  const retained = (ids: readonly EvidenceId[]) => ids.filter((id) => selected.has(id));
  return {
    findings: findings.map((finding) => ({ ...finding, evidenceIds: retained(finding.evidenceIds) })),
    ranked: ranked.flatMap(({ fingerprint, recommendation }) => {
      const evidenceIds = cited(retained(recommendation.evidenceIds));
      return evidenceIds ? [{ fingerprint, recommendation: { ...recommendation, evidenceIds } }] : [];
    }),
    evidence,
  };
};

const reportBot = (bot: CollectorInput["bots"][number]): SendReportPayload["bots"][number] => {
  const row = { name: reportText(bot.name), lastActiveAt: bot.lastActiveAt, routineCount: bot.routineCount };
  const usage = bot.usage;
  if (usage?.unit === "share") {
    return "share" in usage
      ? { ...row, usageShare: usage.share, usageShareBelow: null, usagePeriod: usage.period }
      : { ...row, usageShare: null, usageShareBelow: usage.shareBelow, usagePeriod: usage.period };
  }
  if (usage?.unit === "percent") return { ...row, usageShare: usage.amount7d / 100, usageShareBelow: null, usagePeriod: "last_7_days" };
  return { ...row, usageShare: null, usageShareBelow: null, usagePeriod: null };
};

const routineCounts = (snapshot: CollectorInput): SendReportPayload["counts"]["routines"] => {
  if (!completeRoutineList(snapshot)) return { active: null, paused: null, failing: null, runs7d: null, failedRuns7d: null };
  const states = { active: 0, paused: 0, failing: 0 };
  for (const routine of snapshot.routines) states[routine.state]++;
  const sum = (field: "runs7d" | "failedRuns7d"): number | null => {
    let total = 0;
    for (const routine of snapshot.routines) {
      const count = routine[field];
      if (count === null || count === undefined) return null;
      total += count;
    }
    return total;
  };
  return { ...states, runs7d: sum("runs7d"), failedRuns7d: sum("failedRuns7d") };
};

const countsOf = (snapshot: CollectorInput): SendReportPayload["counts"] => ({
  bots: snapshot.bots.length,
  routines: routineCounts(snapshot),
  connectors: {
    ok: snapshot.connectors.filter((connector) => connector.status === "ok").length,
    needsAuth: snapshot.connectors.filter((connector) => connector.status === "needsAuth").length,
    needsGrant: snapshot.connectors.filter((connector) => connector.status === "needsGrant").length,
    initializing: snapshot.connectors.filter((connector) => connector.status === "initializing").length,
    error: snapshot.connectors.filter((connector) => connector.status === "error").length,
  },
  tasks: { open: snapshot.tasks.open, stale7d: snapshot.tasks.stale7d, blocked: snapshot.tasks.blocked, closed7d: snapshot.tasks.closed7d ?? null },
  pages: { count: snapshot.pages.count, updated7d: snapshot.pages.updated7d },
});

export const deriveReportId = (snapshotId: string, rng: Rng, instantMs: number, digest: (text: string) => Sha256Hex): ReportId =>
  reportIdFrom(instantMs, digest(`${snapshotId}:${entropyHex(rng)}`));

export const assembleReport = (
  snapshot: CollectorInput,
  hits: readonly RuleHit[],
  suppressed: ReadonlySet<string>,
  reportId: ReportId,
  version: string,
  announcements: readonly Announcement[] = [],
): { readonly payload: SendReportPayload; readonly ranked: readonly RankedRecommendation[] } => {
  if (!isSemVer(version)) throw new Error("The module version is not a semantic version.");
  const collected = parseTimestamp(snapshot.collectedAt);
  if (collected === null) throw new Error("The snapshot collectedAt is not a UTC timestamp.");
  const visibility = visibilityOf(snapshot);
  const { findings, ranked, evidence } = allocateEvidence(snapshot, findingsFrom(snapshot, hits, visibility), recommendationsFrom(hits, suppressed));
  const recommendations = capRecommendations(ranked.map((item) => item.recommendation));
  const payload = fitReportLists({
    schemaVersion: 4,
    reportId,
    period: { from: formatTimestamp(addDays(collected, -7)), to: formatTimestamp(collected) },
    accountKind: snapshot.account.kind,
    summary: summaryOf(findings, visibility, withheldRules(hits).length),
    counts: countsOf(snapshot),
    bots: snapshot.bots.map(reportBot),
    connectors: snapshot.connectors.map(({ name, status }) => ({ name: reportText(name), status })),
    planUsage: planUsageOf(snapshot),
    findings,
    recommendations,
    announcements: selectAnnouncements(announcements),
    evidence,
    visibility: visibility.map((entry) => ({ ...entry, why: reportText(entry.why) })),
    moduleVersions: { audit: version },
  });
  if (!isReportPayload(payload)) throw new Error("The report payload does not match send_report.");
  return { payload, ranked };
};

export const payloadSha256 = (payload: SendReportPayload, digest: (text: string) => Sha256Hex): Sha256Hex => digest(canonicalJson(payload));
