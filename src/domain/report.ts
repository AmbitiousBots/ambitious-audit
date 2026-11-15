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
  SendReportPayload,
  Sha256Hex,
  VisibilityMap,
} from "./types.ts";
import { isEvidenceId, isRecommendationId, isSemVer, WIRE_LIMITS } from "./types.ts";
import { entropyHex, reportIdFrom } from "./uuid.ts";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

const SIGNAL_WHY: Readonly<Record<VisibilityMap[number]["signal"], string>> = {
  transcripts: "transcripts",
  usage: "usage",
  otherBots: "other bots",
  auditLog: "the audit log",
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

export const findingsFrom = (hits: readonly RuleHit[]): readonly Finding[] =>
  orderedHits(hits)
    .slice(0, 20)
    .map((item) => ({ ruleId: item.rule.id, severity: item.rule.severity, evidenceIds: item.evidenceIds, summary: item.summary }));

export const recommendationsFrom = (hits: readonly RuleHit[], suppressed: ReadonlySet<string>): readonly RankedRecommendation[] => {
  const ranked: RankedRecommendation[] = [];
  for (const item of orderedHits(hits)) {
    if (suppressed.has(item.fingerprint)) continue;
    const evidenceIds = cited(item.evidenceIds);
    if (evidenceIds === null || !isRecommendationId(item.rule.id)) continue;
    ranked.push({
      fingerprint: item.fingerprint,
      recommendation: { id: item.rule.id, title: item.rule.title, why: item.rule.why, evidenceIds, effort: item.rule.effort },
    });
  }
  return ranked.slice(0, WIRE_LIMITS.recommendations);
};

const summaryOf = (findings: readonly Finding[], visibility: VisibilityMap): string => {
  const unseen = visibility.filter((entry) => !entry.seen).map((entry) => SIGNAL_WHY[entry.signal]);
  const body = findings.length === 0 ? "Nothing in this snapshot needs action." : findings.map((finding) => finding.summary).join(" ");
  const tail = unseen.length === 0 ? "Every listed signal was visible." : `Not visible: ${unseen.join(", ")}.`;
  const summary = `${body} ${tail}`;
  return summary.length <= WIRE_LIMITS.summaryCharacters ? summary : `${summary.slice(0, WIRE_LIMITS.summaryCharacters - 1)}…`;
};

const evidenceOf = (snapshot: CollectorInput, findings: readonly Finding[], recommendations: readonly Recommendation[]): readonly ReportEvidence[] => {
  const cited = recommendations.flatMap((item) => item.evidenceIds);
  const wanted = new Set<string>([...cited, ...findings.flatMap((finding) => finding.evidenceIds)]);
  const byId = new Map<string, ReportEvidence>();
  for (const item of snapshot.evidence) {
    if (!wanted.has(item.id) || !isEvidenceId(item.id) || byId.has(item.id)) continue;
    byId.set(item.id, { id: item.id, text: item.text });
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
  const findings = findingsFrom(hits);
  const ranked = recommendationsFrom(hits, suppressed);
  const recommendations = capRecommendations(ranked.map((item) => item.recommendation));
  const visibility = visibilityOf(snapshot);
  const payload: SendReportPayload = {
    schemaVersion: 1,
    reportId,
    period: { from: formatTimestamp(addDays(collected, -7)), to: formatTimestamp(collected) },
    summary: summaryOf(findings, visibility),
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
