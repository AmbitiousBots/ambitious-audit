import { isRecord } from "@ambitious/kit/domain/json";
import { evidenceSubjects, type SourceKind } from "./evidence.ts";
import { addDays, observedInstant, olderThanDays, parseTimestamp, withinDays } from "./time.ts";
import type { CollectorInput, Effort, EvidenceId, EvidenceIds, Fingerprint, RuleId, Severity } from "./types.ts";
import type { CollectorV2Bot, CollectorV2BotUsage, CollectorV2Routine } from "./wire.generated.ts";
import { isFingerprint, isRecommendationId, isRuleId } from "./types.ts";

type CountText = { readonly one: string; readonly many: string };

type RuleWhen =
  | { readonly kind: "routine-state"; readonly state: "paused" | "failing" }
  | { readonly kind: "routine-paused-for"; readonly olderThanDays: number }
  | { readonly kind: "routine-paused-since-unknown"; readonly unlessCreatedOrRunWithinDays: number }
  | { readonly kind: "connector-status"; readonly status: "needsAuth" | "needsGrant" }
  | { readonly kind: "bot-unused"; readonly olderThanDays: number }
  | { readonly kind: "bots-barely-used"; readonly minimumBots: number }
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
    if (value.olderThanDays !== undefined) return brokenRule("when.olderThanDays, which a routine-state rule does not take; use routine-paused-for");
    return { kind: "routine-state", state };
  }
  if (kind === "routine-paused-for") return { kind: "routine-paused-for", olderThanDays: wholeNumber(value.olderThanDays, "when.olderThanDays") };
  if (kind === "routine-paused-since-unknown") {
    return { kind: "routine-paused-since-unknown", unlessCreatedOrRunWithinDays: wholeNumber(value.unlessCreatedOrRunWithinDays, "when.unlessCreatedOrRunWithinDays") };
  }
  if (kind === "connector-status") {
    const status = value.status;
    if (status !== "needsAuth" && status !== "needsGrant") return brokenRule("when.status");
    return { kind: "connector-status", status };
  }
  if (kind === "bot-unused") return { kind: "bot-unused", olderThanDays: wholeNumber(value.olderThanDays, "when.olderThanDays") };
  if (kind === "bots-barely-used") return { kind, minimumBots: wholeNumber(value.minimumBots, "when.minimumBots") };
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

const evidenceFor = (evidence: ReturnType<typeof evidenceSubjects>, kind: SourceKind, subjects: readonly string[]): EvidenceId[] => {
  const wanted = new Set(subjects);
  return [...evidence].filter(([, subject]) => subject.kind === kind && wanted.has(subject.key)).map(([id]) => id);
};

const sentence = (summary: CountText, count: number): string => (count === 1 ? summary.one : summary.many.replaceAll("{count}", String(count)));

const fingerprintFor = (id: RuleId, subjects: readonly string[]): Fingerprint => {
  const text = `${id}:${[...subjects].sort().join(",")}`;
  if (!isFingerprint(text)) throw new Error("A recommendation fingerprint is empty or too long.");
  return text;
};

const hit = (rule: RuleDefinition, snapshot: CollectorInput, subjects: readonly string[], evidenceIds: EvidenceIds): RuleHit | null => {
  if (subjects.length === 0) return null;
  return {
    rule,
    subjects,
    withheld: rule.dependsOnRole && snapshot.account.kind === "unknown",
    evidenceIds,
    summary: sentence(rule.summary, subjects.length),
    fingerprint: fingerprintFor(rule.id, subjects),
  };
};

const pausedLongerThan = (routine: CollectorV2Routine, collected: number, days: number): boolean =>
  routine.state === "paused" && routine.pausedAt !== undefined && olderThanDays(collected, observedInstant(routine.pausedAt), days);

const pausedSinceUnknown = (routine: CollectorV2Routine, collected: number, days: number): boolean =>
  routine.state === "paused" &&
  routine.pausedAt === undefined &&
  !withinDays(collected, observedInstant(routine.createdAt ?? null), days) &&
  !withinDays(collected, observedInstant(routine.lastRunAt), days);

type ShareUsage = Extract<CollectorV2BotUsage, { readonly unit: "share" }>;

const shareInterval = (usage: ShareUsage, collected: number): { start: number; end: number } | null => {
  const start = usage.periodStart === undefined ? null : parseTimestamp(usage.periodStart);
  const end = usage.periodEnd === undefined ? null : parseTimestamp(usage.periodEnd);
  if ((usage.periodStart !== undefined && start === null) || (usage.periodEnd !== undefined && end === null)) return null;
  const days = usage.period === "last_30_days" ? 30 : 7;
  const inferredEnd = start === null ? collected : addDays(start, days);
  const periodEnd = end ?? (usage.period === "this_week" ? Math.min(inferredEnd, collected) : inferredEnd);
  return { start: start ?? addDays(periodEnd, -days), end: periodEnd };
};

const botUnused = (bot: CollectorV2Bot, collected: number, days: number): boolean => {
  const { usage } = bot;
  const cutoff = addDays(collected, -days);
  const lastActive = observedInstant(bot.lastActiveAt);
  if (usage?.unit === "share" && usage.share !== undefined) {
    const interval = shareInterval(usage, collected);
    if (interval !== null) {
      if (usage.share > 0 && interval.start >= cutoff && interval.start <= Math.min(interval.end, collected)) return false;
      if (!lastActive.known) return usage.share === 0 && usage.period === "last_30_days" && interval.start < cutoff && interval.end >= collected;
    }
  } else if (usage && usage.unit !== "share" && usage.amount7d > 0 && days >= 7) {
    return false;
  }
  return olderThanDays(collected, lastActive, days);
};

const belowOnePercentLastWeek = ({ usage }: CollectorV2Bot, collected: number): boolean => {
  if (usage?.unit === "percent") return usage.amount7d < 1;
  if (usage?.unit !== "share" || usage.period !== "last_7_days") return false;
  const interval = shareInterval(usage, collected);
  if (interval === null || interval.end < addDays(interval.start, 6) || interval.end > addDays(interval.start, 8)) return false;
  const overlapStart = Math.max(interval.start, addDays(collected, -7));
  const overlapEnd = Math.min(interval.end, collected);
  if (addDays(overlapStart, 6) > overlapEnd) return false;
  return "share" in usage ? usage.share < 0.01 : usage.shareBelow <= 0.01;
};

const subjectsOf = (rule: RuleDefinition, snapshot: CollectorInput): { readonly subjects: readonly string[]; readonly kind: SourceKind } | null => {
  const when = rule.when;
  const collected = referenceMs(snapshot);
  if (when.kind === "routine-state") {
    const subjects = snapshot.routines.filter((routine) => routine.state === when.state).map((routine) => routine.id);
    return { subjects, kind: "routine" };
  }
  if (when.kind === "routine-paused-for") {
    const subjects = snapshot.routines.filter((routine) => pausedLongerThan(routine, collected, when.olderThanDays)).map((routine) => routine.id);
    return { subjects, kind: "routine" };
  }
  if (when.kind === "routine-paused-since-unknown") {
    const subjects = snapshot.routines.filter((routine) => pausedSinceUnknown(routine, collected, when.unlessCreatedOrRunWithinDays)).map((routine) => routine.id);
    return { subjects, kind: "routine" };
  }
  if (when.kind === "connector-status") {
    const subjects = snapshot.connectors.filter((connector) => connector.status === when.status).map((connector) => connector.name);
    return { subjects, kind: "connector" };
  }
  if (when.kind === "bot-unused") {
    const subjects = snapshot.bots.filter((bot) => botUnused(bot, collected, when.olderThanDays)).map((bot) => bot.id);
    return { subjects, kind: "bot" };
  }
  if (when.kind === "bots-barely-used") {
    const subjects = snapshot.bots.filter((bot) => belowOnePercentLastWeek(bot, collected)).map((bot) => bot.id);
    return subjects.length >= when.minimumBots ? { subjects, kind: "bot" } : null;
  }
  if (when.kind === "stale-tasks") {
    const stale = snapshot.tasks.stale7d;
    return stale !== null && stale > when.moreThan ? { subjects: ["tasks"], kind: "tasks" } : null;
  }
  const groups = new Map<string, string[]>();
  for (const routine of snapshot.routines) {
    const key = JSON.stringify([routine.botId, routine.schedule]);
    const list = groups.get(key) ?? [];
    list.push(routine.id);
    groups.set(key, list);
  }
  const subjects = [...groups.values()].filter((ids) => ids.length > 1).flat();
  return { subjects, kind: "routine" };
};

export const evaluateRules = (snapshot: CollectorInput, rules: readonly RuleDefinition[]): readonly RuleHit[] => {
  const evidence = evidenceSubjects(snapshot);
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    const matched = subjectsOf(rule, snapshot);
    if (matched === null) continue;
    const next = hit(rule, snapshot, matched.subjects, evidenceFor(evidence, matched.kind, matched.subjects));
    if (next !== null) hits.push(next);
  }
  return hits;
};
