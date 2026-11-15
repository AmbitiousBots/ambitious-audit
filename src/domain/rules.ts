import { isRecord } from "@ambitious/kit/domain/json";
import { observedInstant, olderThanDays, parseTimestamp } from "./time.ts";
import type { CollectorInput, Effort, EvidenceId, EvidenceIds, Fingerprint, RuleId, Severity } from "./types.ts";
import { isEvidenceId, isFingerprint, isRecommendationId, isRuleId } from "./types.ts";

type CountText = { readonly one: string; readonly many: string };

type RuleWhen =
  | { readonly kind: "routine-state"; readonly state: "paused" | "failing"; readonly olderThanDays?: number }
  | { readonly kind: "connector-status"; readonly status: "needsAuth" | "needsGrant" }
  | { readonly kind: "bot-unused"; readonly olderThanDays: number }
  | { readonly kind: "stale-tasks"; readonly moreThan: number }
  | { readonly kind: "duplicate-routines" };

export type RuleDefinition = {
  readonly id: RuleId;
  readonly severity: Severity;
  readonly effort: Effort;
  readonly rank: number;
  readonly dependsOnRole: boolean;
  readonly title: string;
  readonly why: string;
  readonly summary: CountText;
  readonly when: RuleWhen;
};

export type RuleHit = {
  readonly rule: RuleDefinition;
  readonly subjects: readonly string[];
  readonly withheld: boolean;
  readonly evidenceIds: EvidenceIds;
  readonly summary: string;
  readonly fingerprint: Fingerprint;
};

const brokenRule = (detail: string): never => {
  throw new Error(`A rule file is not valid: ${detail}.`);
};

const textPair = (value: unknown, label: string): CountText => {
  if (!isRecord(value)) return brokenRule(label);
  const one = value.one;
  const many = value.many;
  if (typeof one !== "string" || typeof many !== "string" || one.length < 1 || many.length < 1 || one.length > 280 || many.length > 280) return brokenRule(label);
  return { one, many };
};

const wholeNumber = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return brokenRule(label);
};

const parseWhen = (value: unknown): RuleWhen => {
  if (!isRecord(value)) return brokenRule("when");
  const kind = value.kind;
  if (kind === "routine-state") {
    const state = value.state;
    if (state !== "paused" && state !== "failing") return brokenRule("when.state");
    const olderThanDays = value.olderThanDays;
    if (olderThanDays === undefined) return { kind: "routine-state", state };
    return { kind: "routine-state", state, olderThanDays: wholeNumber(olderThanDays, "when.olderThanDays") };
  }
  if (kind === "connector-status") {
    const status = value.status;
    if (status !== "needsAuth" && status !== "needsGrant") return brokenRule("when.status");
    return { kind: "connector-status", status };
  }
  if (kind === "bot-unused") return { kind: "bot-unused", olderThanDays: wholeNumber(value.olderThanDays, "when.olderThanDays") };
  if (kind === "stale-tasks") return { kind: "stale-tasks", moreThan: wholeNumber(value.moreThan, "when.moreThan") };
  if (kind === "duplicate-routines") return { kind: "duplicate-routines" };
  return brokenRule("when.kind");
};

const isSeverity = (value: string): value is Severity => value === "low" || value === "medium" || value === "high";
const isEffort = (value: string): value is Effort => value === "small" || value === "medium" || value === "large";

export const parseRule = (value: unknown): RuleDefinition => {
  if (!isRecord(value)) return brokenRule("rule");
  const id = value.id;
  const severity = value.severity;
  const effort = value.effort;
  const title = value.title;
  const why = value.why;
  if (typeof id !== "string" || !isRuleId(id) || !isRecommendationId(id)) return brokenRule("id");
  if (typeof severity !== "string" || !isSeverity(severity)) return brokenRule("severity");
  if (typeof effort !== "string" || !isEffort(effort)) return brokenRule("effort");
  if (typeof title !== "string" || title.length < 1 || title.length > 120) return brokenRule("title");
  if (typeof why !== "string" || why.length < 1 || why.length > 600) return brokenRule("why");
  const dependsOnRole = value.dependsOnRole;
  if (typeof dependsOnRole !== "boolean") return brokenRule("dependsOnRole");
  return { id, severity, effort, rank: wholeNumber(value.rank, "rank"), dependsOnRole, title, why, summary: textPair(value.summary, "summary"), when: parseWhen(value.when) };
};

const referenceMs = (snapshot: CollectorInput): number => {
  const parsed = parseTimestamp(snapshot.collectedAt);
  if (parsed === null) throw new Error("The snapshot collectedAt is not a UTC timestamp.");
  return parsed;
};

const evidenceFor = (snapshot: CollectorInput, keys: readonly string[]): EvidenceId[] => {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const ids: EvidenceId[] = [];
  for (const item of snapshot.evidence) {
    if (!wanted.has(item.source.toLowerCase())) continue;
    if (isEvidenceId(item.id) && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids.slice(0, 10);
};

const sentence = (summary: CountText, count: number): string => (count === 1 ? summary.one : summary.many.replaceAll("{count}", String(count)));

const fingerprintFor = (id: RuleId, subjects: readonly string[]): Fingerprint => {
  const text = `${id}:${[...subjects].sort().join(",")}`;
  if (!isFingerprint(text)) throw new Error("A recommendation fingerprint is empty or too long.");
  return text;
};

const hit = (rule: RuleDefinition, snapshot: CollectorInput, subjects: readonly string[], evidenceKeys: readonly string[]): RuleHit | null => {
  if (subjects.length === 0) return null;
  return {
    rule,
    subjects,
    withheld: rule.dependsOnRole && snapshot.account.kind === "unknown",
    evidenceIds: evidenceFor(snapshot, evidenceKeys),
    summary: sentence(rule.summary, subjects.length),
    fingerprint: fingerprintFor(rule.id, subjects),
  };
};

const subjectsOf = (rule: RuleDefinition, snapshot: CollectorInput): { readonly subjects: readonly string[]; readonly evidenceKeys: readonly string[] } | null => {
  const when = rule.when;
  const collected = referenceMs(snapshot);
  if (when.kind === "routine-state") {
    const matched = snapshot.routines.filter((routine) => {
      if (routine.state !== when.state) return false;
      if (when.olderThanDays === undefined) return true;
      return olderThanDays(collected, observedInstant(routine.lastRunAt), when.olderThanDays);
    });
    const subjects = matched.map((routine) => routine.id);
    return { subjects, evidenceKeys: subjects };
  }
  if (when.kind === "connector-status") {
    const subjects = snapshot.connectors.filter((connector) => connector.status === when.status).map((connector) => connector.name);
    return { subjects, evidenceKeys: subjects };
  }
  if (when.kind === "bot-unused") {
    const subjects = snapshot.bots
      .filter((bot) => olderThanDays(collected, observedInstant(bot.lastActiveAt), when.olderThanDays))
      .map((bot) => bot.id);
    return { subjects, evidenceKeys: subjects };
  }
  if (when.kind === "stale-tasks") {
    const stale = snapshot.tasks.stale7d;
    return stale !== null && stale > when.moreThan ? { subjects: ["tasks"], evidenceKeys: ["tasks"] } : { subjects: [], evidenceKeys: [] };
  }
  const groups = new Map<string, string[]>();
  for (const routine of snapshot.routines) {
    const key = `${routine.botId}\t${routine.schedule}`;
    const list = groups.get(key) ?? [];
    list.push(routine.id);
    groups.set(key, list);
  }
  const subjects = [...groups.values()].filter((ids) => ids.length > 1).flat();
  return { subjects, evidenceKeys: subjects };
};

export const evaluateRules = (snapshot: CollectorInput, rules: readonly RuleDefinition[]): readonly RuleHit[] => {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const matched = subjectsOf(rule, snapshot);
    if (matched === null) continue;
    const next = hit(rule, snapshot, matched.subjects, matched.evidenceKeys);
    if (next !== null) hits.push(next);
  }
  return hits;
};
