import { isRecord } from "@ambitious/kit/domain/json";
import { pointerOf, refuseProblems, type FieldProblem } from "./field-problems.ts";
import { VISIBILITY_SIGNALS, type CollectorInput, type VisibilityEntry, type VisibilityMap, type VisibilitySignal } from "./types.ts";
import { parseTimestamp } from "./time.ts";
import type { CollectorV2Bot, CollectorV2BotUsage, CollectorV2Connector, CollectorV2Evidence, CollectorV2Routine, CollectorV2Usage } from "./wire.generated.ts";

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const repeats = (values: readonly string[], pointer: (index: number) => string, label: string): readonly FieldProblem[] => {
  const seen = new Set<string>();
  const problems: FieldProblem[] = [];
  values.forEach((value, index) => {
    if (seen.has(value)) problems.push({ pointer: pointer(index), rule: "unique", must: `repeats the ${label} "${value}"`, help: `Give every ${label} its own value.` });
    seen.add(value);
  });
  return problems;
};

const copyUsage = (usage: CollectorV2Usage): CollectorV2Usage => (usage === null ? null : { unit: usage.unit, amount7d: usage.amount7d });

const copyBotUsage = (usage: CollectorV2BotUsage): CollectorV2BotUsage => {
  if (usage === null || usage.unit !== "share") return copyUsage(usage);
  return {
    unit: "share",
    period: usage.period,
    ...(usage.periodStart === undefined ? {} : { periodStart: usage.periodStart }),
    ...(usage.periodEnd === undefined ? {} : { periodEnd: usage.periodEnd }),
    ...("share" in usage ? { share: usage.share } : { shareBelow: usage.shareBelow }),
  };
};

const copyRoutine = (routine: CollectorV2Routine): CollectorV2Routine => ({
  id: routine.id,
  botId: routine.botId,
  schedule: routine.schedule,
  state: routine.state,
  lastRunAt: routine.lastRunAt,
  ...(routine.pausedAt === undefined ? {} : { pausedAt: routine.pausedAt }),
  ...(routine.createdAt === undefined ? {} : { createdAt: routine.createdAt }),
  ...(routine.runs7d === undefined ? {} : { runs7d: routine.runs7d }),
  ...(routine.failedRuns7d === undefined ? {} : { failedRuns7d: routine.failedRuns7d }),
  usage: copyUsage(routine.usage),
  ...(routine.lastError === undefined ? {} : { lastError: routine.lastError }),
});

export const canonicalJson = (value: unknown): string => {
  const ordered = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(ordered);
    if (!isRecord(node)) return node;
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, ordered(node[key])]));
  };
  return JSON.stringify(ordered(value));
};

const orderedVisibility = (input: CollectorInput): VisibilityMap =>
  VISIBILITY_SIGNALS.flatMap((signal) => input.visibility.filter((entry) => entry.signal === signal).slice(0, 1)).map(
    (entry): VisibilityEntry => ({ signal: entry.signal, seen: entry.seen, why: entry.why }),
  );

const usageCoverage = (input: CollectorInput, entry: VisibilityEntry): VisibilityEntry => {
  if (entry.seen === "partial") return entry;
  const bounded = input.bots.some((bot) => bot.usage !== null && "shareBelow" in bot.usage);
  if (bounded) return { ...entry, seen: "partial", why: "The usage report gives an upper bound for some bot shares." };
  const hasReading = input.bots.some((bot) => bot.usage !== null) || input.routines.some((routine) => routine.usage !== null) ||
    input.weeklyLimitUsed !== undefined || (input.planUsage !== undefined && Object.values(input.planUsage).some((value) => value !== null));
  if (!hasReading) return entry;
  if (entry.seen === false) return { ...entry, seen: "partial" };
  if (input.routines.length === 0 && input.visibility.some((item) => item.signal === "routines" && item.seen !== true)) {
    return { ...entry, seen: "partial", why: "Usage was reported, but routine usage coverage is unknown." };
  }
  return entry;
};

export const visibilityOf = (input: CollectorInput): VisibilityMap =>
  orderedVisibility(input).map((entry) => {
    if (entry.signal === "usage") {
      const coverage = usageCoverage(input, entry);
      if (coverage.seen !== true) return coverage;
      if (input.bots.some((bot) => bot.usage?.unit === "credits")) {
        return { ...entry, seen: "partial", why: "Some bots have credit readings without a share of account usage." };
      }
      if (input.weeklyLimitUsed !== undefined && input.planUsage === undefined) {
        return { ...entry, seen: "partial", why: "The legacy weekly reading omits the extra credit balance." };
      }
      return entry;
    }
    if (entry.seen !== true) return entry;
    if (entry.signal === "tasks" && input.tasks.closed7d === undefined) {
      return { ...entry, seen: "partial", why: "Task counts were reported without closures for the last seven days." };
    }
    if (entry.signal === "routines" && input.routines.some((routine) => routine.runs7d === undefined || routine.failedRuns7d === undefined)) {
      return { ...entry, seen: "partial", why: "The routine list was observed. Seven-day run or failure counts are missing." };
    }
    return entry;
  });

export const notObserved = (input: CollectorInput): Readonly<Record<Exclude<VisibilitySignal, "transcripts" | "otherBots" | "auditLog">, readonly string[]>> => {
  const where = (found: readonly (string | null)[]): readonly string[] => found.flatMap((pointer) => (pointer === null ? [] : [pointer]));
  const nullAt = (value: unknown, ...parts: readonly (string | number)[]): string | null => (value === null ? pointerOf(parts) : null);
  return {
    accountRole: where([input.account.kind === "unknown" ? "/account/kind" : null]),
    tasks: where([nullAt(input.tasks.open, "tasks", "open"), nullAt(input.tasks.stale7d, "tasks", "stale7d"), nullAt(input.tasks.blocked, "tasks", "blocked"), nullAt(input.tasks.closed7d, "tasks", "closed7d")]),
    pages: where([nullAt(input.pages.count, "pages", "count"), nullAt(input.pages.updated7d, "pages", "updated7d")]),
    botActivity: where(input.bots.map((bot, index) => nullAt(bot.lastActiveAt, "bots", index, "lastActiveAt"))),
    routines: where([
      ...input.bots.map((bot, index) => nullAt(bot.routineCount, "bots", index, "routineCount")),
      ...input.routines.flatMap((routine, index) => [nullAt(routine.lastRunAt, "routines", index, "lastRunAt"),
        nullAt(routine.runs7d, "routines", index, "runs7d"), nullAt(routine.failedRuns7d, "routines", index, "failedRuns7d")]),
    ]),
    usage: where([
      ...Object.entries(input.planUsage ?? {}).map(([key, value]) => nullAt(value, "planUsage", key)),
      ...input.bots.map((bot, index) => nullAt(bot.usage, "bots", index, "usage")),
      ...input.routines.map((routine, index) => nullAt(routine.usage, "routines", index, "usage")),
    ]),
  };
};

const gapProblems = (input: CollectorInput): readonly FieldProblem[] => {
  const unseen = notObserved(input);
  const problems: FieldProblem[] = [];
  input.visibility.forEach((entry, index) => {
    if (entry.signal === "transcripts" || entry.signal === "otherBots" || entry.signal === "auditLog") return;
    const first = unseen[entry.signal][0];
    if (entry.seen === true && first !== undefined) {
      const reason = entry.signal === "accountRole" ? `${first} is "unknown"` : `${first} is null, which means not observed`;
      const allowed = input.schemaVersion === 1 ? "false" : 'false or "partial"';
      problems.push({
        pointer: pointerOf(["visibility", index, "seen"]),
        rule: "null-needs-visibility-gap",
        must: `must be ${allowed}, because ${reason}`,
        help: `Set seen to ${allowed} for the signal "${entry.signal}" and say why, or give the value that was observed. Never write zero or a guess for a value that was not observed.`,
      });
    }
    if (entry.signal === "accountRole" && entry.seen !== true && first === undefined) {
      problems.push({
        pointer: "/account/kind",
        rule: "role-needs-a-source",
        must: `must be "unknown", because the visibility entry for "accountRole" says the role was not seen`,
        help: "Never infer the role. Use a role only when a tool reported it or the account holder stated it, and then set seen to true for accountRole.",
      });
    }
  });
  return problems;
};

type ShareUsage = Extract<CollectorV2BotUsage, { readonly unit: "share" }>;

const sharesOf = (input: CollectorInput): readonly { readonly index: number; readonly usage: ShareUsage }[] =>
  input.bots.flatMap((bot, index) => (bot.usage !== null && bot.usage.unit === "share" ? [{ index, usage: bot.usage }] : []));

const sharePeriodProblems = (input: CollectorInput): readonly FieldProblem[] => {
  const shares = sharesOf(input);
  const first = shares[0];
  const problems: FieldProblem[] = [];
  for (const { index, usage } of shares) {
    const start = usage.periodStart === undefined ? null : parseTimestamp(usage.periodStart);
    const end = usage.periodEnd === undefined ? null : parseTimestamp(usage.periodEnd);
    if (start !== null && end !== null && start > end) {
      problems.push({ pointer: pointerOf(["bots", index, "usage", "periodStart"]), rule: "period-order", must: "must not be after periodEnd", help: "Give the start and the end of the period as the usage report shows them." });
    }
    if (first !== undefined && (usage.period !== first.usage.period || usage.periodStart !== first.usage.periodStart || usage.periodEnd !== first.usage.periodEnd)) {
      problems.push({
        pointer: pointerOf(["bots", index, "usage", "period"]),
        rule: "usage-one-period",
        must: `must name the same period, with the same periodStart and periodEnd, as ${pointerOf(["bots", first.index, "usage"])}`,
        help: "Shares are parts of one total, so every share in a document comes from one usage report for one period. Use null for a bot that report did not list.",
      });
    }
  }
  if (input.usageOther !== undefined && first === undefined) {
    problems.push({
      pointer: "/usageOther",
      rule: "usage-other-needs-a-share",
      must: "must be left out, because no bot has a usage with unit share to say which period it covers",
      help: "usageOther is the summed share of the bots a usage report did not list by name. Add the bots the report did list, each with its share, or leave usageOther out.",
    });
  }
  return problems;
};

const usageProblems = (input: CollectorInput): readonly FieldProblem[] => {
  const tooHigh = (usage: CollectorV2BotUsage, ...parts: readonly (string | number)[]): readonly FieldProblem[] =>
    usage !== null && usage.unit === "percent" && usage.amount7d > 100
      ? [{ pointer: pointerOf([...parts, "usage", "amount7d"]), rule: "percent-range", must: "must be 100 or less when unit is percent", help: "A percentage is a share of the account's total usage, from 0 to 100." }]
      : [];
  return [
    ...input.bots.flatMap((bot, index) => tooHigh(bot.usage, "bots", index)),
    ...input.routines.flatMap((routine, index) => tooHigh(routine.usage, "routines", index)),
    ...sharePeriodProblems(input),
  ];
};

export const normalizeCollector = (input: CollectorInput, schemaCommand: string): CollectorInput => {
  refuseProblems(schemaCommand, [
    ...repeats(input.bots.map((bot) => bot.id), (index) => pointerOf(["bots", index, "id"]), "bot id"),
    ...repeats(input.routines.map((routine) => routine.id), (index) => pointerOf(["routines", index, "id"]), "routine id"),
    ...repeats(input.connectors.map((connector) => connector.name), (index) => pointerOf(["connectors", index, "name"]), "connector name"),
    ...repeats(input.evidence.map((item) => item.id), (index) => pointerOf(["evidence", index, "id"]), "evidence id"),
    ...repeats(input.visibility.map((entry) => entry.signal), (index) => pointerOf(["visibility", index, "signal"]), "visibility signal"),
    ...gapProblems(input),
    ...usageProblems(input),
  ]);
  const bots: readonly CollectorV2Bot[] = input.bots
    .map((bot) => ({ id: bot.id, name: bot.name, lastActiveAt: bot.lastActiveAt, routineCount: bot.routineCount, usage: copyBotUsage(bot.usage) }))
    .sort((left, right) => compareText(left.id, right.id));
  const routines = input.routines.map(copyRoutine).sort((left, right) => compareText(left.id, right.id));
  const connectors: readonly CollectorV2Connector[] = input.connectors
    .map((connector) => ({ name: connector.name, status: connector.status }))
    .sort((left, right) => compareText(left.name, right.name));
  const evidence: readonly CollectorV2Evidence[] = input.evidence
    .map((item) => ({ id: item.id, kind: item.kind, text: item.text, source: item.source }))
    .sort((left, right) => compareText(left.id, right.id));
  return {
    schemaVersion: input.schemaVersion,
    collectedAt: input.collectedAt,
    account: { kind: input.account.kind, label: input.account.label },
    bots,
    routines,
    connectors,
    tasks: {
      open: input.tasks.open, stale7d: input.tasks.stale7d, blocked: input.tasks.blocked,
      ...(input.tasks.closed7d === undefined ? {} : { closed7d: input.tasks.closed7d }),
    },
    pages: { count: input.pages.count, updated7d: input.pages.updated7d },
    ...(input.usageOther === undefined
      ? {}
      : { usageOther: { share: input.usageOther.share, ...(input.usageOther.botCount === undefined ? {} : { botCount: input.usageOther.botCount }) } }),
    ...(input.weeklyLimitUsed === undefined ? {} : { weeklyLimitUsed: { percent: input.weeklyLimitUsed.percent, asOf: input.weeklyLimitUsed.asOf } }),
    ...(input.planUsage === undefined ? {} : { planUsage: { ...input.planUsage } }),
    visibility: orderedVisibility(input).map((entry) => input.schemaVersion === 2 && entry.signal === "usage" ? usageCoverage(input, entry) : entry),
    evidence,
  };
};
