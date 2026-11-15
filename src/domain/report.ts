import type { Rng } from "@ambitious/kit/domain/clock";
import { canonicalJson, visibilityOf } from "./canonical.ts";
import type { RuleHit } from "./rules.ts";
import { isReportPayload } from "./schema.ts";
import { addDays, formatTimestamp, parseTimestamp } from "./time.ts";
import type {
  CollectorInput,
  EvidenceId,
  Finding,
  Recommendation,
  Recommendations,
  ReportEvidence,
  ReportId,
  RuleId,
  SendReportPayload,
  Sha256Hex,
  VisibilityMap,
  VisibilitySignal,
} from "./types.ts";
import { isEvidenceId, isRecommendationId, isRuleId, isSemVer, WIRE_LIMITS } from "./types.ts";
import { entropyHex, reportIdFrom } from "./uuid.ts";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const SIGNALS: Readonly<Record<VisibilitySignal, { readonly id: string; readonly name: string }>> = {
  transcripts: { id: "visibility-transcripts", name: "conversation text" },
  usage: { id: "visibility-usage", name: "usage by bot and by routine" },
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
  evidenceIds: item.evidenceIds,
  summary: item.summary,
  ...(item.withheld ? { withheld: "roleUnknown" as const } : {}),
});

const visibilityFindings = (visibility: VisibilityMap): readonly Finding[] =>
  visibility
    .filter((entry) => !entry.seen)
    .map((entry) => ({
      kind: "visibility" as const,
      ruleId: visibilityRuleId(entry.signal),
      severity: "low" as const,
      evidenceIds: [],
      summary: `Not observed: ${SIGNALS[entry.signal].name}. Findings cover only what the bot could see.`,
    }));

export const findingsFrom = (snapshot: CollectorInput, hits: readonly RuleHit[]): readonly Finding[] =>
  [...orderedHits(hits).map(ruleFinding), ...visibilityFindings(visibilityOf(snapshot))].slice(0, 20);

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
      recommendation: { id: item.rule.id, title: item.rule.title, why: item.rule.why, evidenceIds, effort: item.rule.effort },
    });
  }
  return ranked.slice(0, WIRE_LIMITS.recommendations);
};

const summaryOf = (findings: readonly Finding[], visibility: VisibilityMap, withheld: number): string => {
  const unseen = visibility.filter((entry) => !entry.seen).map((entry) => SIGNALS[entry.signal].name);
  const fromRules = findings.filter((finding) => finding.kind === "rule");
  const body = fromRules.length === 0 ? "No rule matched what the bot could observe." : fromRules.map((finding) => finding.summary).join(" ");
  const role = visibility.some((entry) => entry.signal === "accountRole" && !entry.seen)
    ? ` The account role is unknown, so recommendations that depend on it are withheld (${withheld} in this report).`
    : "";
  const tail = unseen.length === 0 ? "Every listed signal was visible." : `Not observed: ${unseen.join(", ")}.`;
  const summary = `${body}${role} ${tail}`;
  return summary.length <= WIRE_LIMITS.summaryCharacters ? summary : `${summary.slice(0, WIRE_LIMITS.summaryCharacters - 1)}…`;
};

const evidenceOf = (snapshot: CollectorInput, findings: readonly Finding[], recommendations: readonly Recommendation[]): readonly ReportEvidence[] => {
  const cited = recommendations.flatMap((item) => item.evidenceIds);
  const wanted = new Set<string>([...cited, ...findings.flatMap((finding) => finding.evidenceIds)]);
  const byId = new Map<string, ReportEvidence>();
  for (const item of snapshot.evidence) {
    if (!wanted.has(item.id) || !isEvidenceId(item.id) || byId.has(item.id)) continue;
    byId.set(item.id, { id: item.id, text: item.text, source: item.source });
  }
  const rows: ReportEvidence[] = [];
  for (const id of cited) {
    const row = byId.get(id);
    if (row !== undefined && !rows.some((item) => item.id === id)) rows.push(row);
  }
  for (const item of snapshot.evidence) {
    if (!byId.has(item.id) || rows.some((row) => row.id === item.id)) continue;
    const row = byId.get(item.id);
    if (row !== undefined) rows.push(row);
  }
  return rows.slice(0, 30);
};

const countsOf = (snapshot: CollectorInput): SendReportPayload["counts"] => ({
  bots: snapshot.bots.length,
  routines: {
    active: snapshot.routines.filter((routine) => routine.state === "active").length,
    paused: snapshot.routines.filter((routine) => routine.state === "paused").length,
    failing: snapshot.routines.filter((routine) => routine.state === "failing").length,
  },
  connectors: {
    ok: snapshot.connectors.filter((connector) => connector.status === "ok").length,
    needsAuth: snapshot.connectors.filter((connector) => connector.status === "needsAuth").length,
    needsGrant: snapshot.connectors.filter((connector) => connector.status === "needsGrant").length,
    initializing: snapshot.connectors.filter((connector) => connector.status === "initializing").length,
    error: snapshot.connectors.filter((connector) => connector.status === "error").length,
  },
  tasks: { open: snapshot.tasks.open, stale7d: snapshot.tasks.stale7d, blocked: snapshot.tasks.blocked },
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
): { readonly payload: SendReportPayload; readonly ranked: readonly RankedRecommendation[] } => {
  if (!isSemVer(version)) throw new Error("The module version is not a semantic version.");
  const collected = parseTimestamp(snapshot.collectedAt);
  if (collected === null) throw new Error("The snapshot collectedAt is not a UTC timestamp.");
  const findings = findingsFrom(snapshot, hits);
  const ranked = recommendationsFrom(hits, suppressed);
  const recommendations = capRecommendations(ranked.map((item) => item.recommendation));
  const visibility = visibilityOf(snapshot);
  const payload: SendReportPayload = {
    schemaVersion: 2,
    reportId,
    period: { from: formatTimestamp(addDays(collected, -7)), to: formatTimestamp(collected) },
    accountKind: snapshot.account.kind,
    summary: summaryOf(findings, visibility, withheldRules(hits).length),
    counts: countsOf(snapshot),
    findings,
    recommendations,
    evidence: evidenceOf(snapshot, findings, recommendations),
    visibility,
    moduleVersions: { audit: version },
  };
  const problems = isReportPayload(payload) ? [] : ["The report payload does not match send_report."];
  if (problems.length > 0) throw new Error(problems[0]);
  return { payload, ranked };
};

export const payloadSha256 = (payload: SendReportPayload, digest: (text: string) => Sha256Hex): Sha256Hex => digest(canonicalJson(payload));
