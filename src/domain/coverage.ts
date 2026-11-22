import { reportObservation } from "./report-text.ts";
import { addDays, observedInstant } from "./time.ts";
import type { CollectorInput, SendReportPayload, VisibilityEntry } from "./types.ts";

export const planUsageOf = (snapshot: CollectorInput): SendReportPayload["planUsage"] => {
  const legacy = snapshot.weeklyLimitUsed;
  const legacyPercent = legacy && legacy.percent <= 100 ? legacy.percent : null;
  const plan = snapshot.planUsage;
  const compatible = plan?.period === "this_week" && plan.observedAt !== null && legacy !== undefined &&
    Date.parse(plan.observedAt) === Date.parse(legacy.asOf);
  if (!plan && legacyPercent === null) return null;
  const percent = plan ? plan.weeklyLimitUsedPercent ?? (compatible ? legacyPercent : null) : legacyPercent;
  return {
    weeklyLimitUsedPercent: percent === null ? null : Number(percent.toFixed(4)),
    extraCreditsLeftUsd: plan?.extraCreditsLeftUsdCents == null ? null : plan.extraCreditsLeftUsdCents / 100,
    observedAt: plan ? plan.observedAt : legacy?.asOf ?? null,
    period: plan ? plan.period : "this_week",
  };
};

const allBotsListed = (input: CollectorInput): boolean =>
  input.visibility.some((entry) => entry.signal === "otherBots" && entry.seen === true);

export const completeRoutineList = (input: CollectorInput): boolean => {
  const listed = new Map<string, number>();
  for (const routine of input.routines) listed.set(routine.botId, (listed.get(routine.botId) ?? 0) + 1);
  for (const bot of input.bots) {
    if (bot.routineCount !== null && bot.routineCount !== (listed.get(bot.id) ?? 0)) return false;
    listed.delete(bot.id);
  }

  const seen = input.visibility.find((entry) => entry.signal === "routines")?.seen;
  if (listed.size > 0 && allBotsListed(input)) return false;
  if (seen === true) return true;
  if (seen === false && input.routines.length === 0) return false;
  return allBotsListed(input) && input.bots.length > 0 && listed.size === 0 && input.bots.every((bot) => bot.routineCount !== null);
};

export const routineRunCount = (
  routine: CollectorInput["routines"][number], field: "runs7d" | "failedRuns7d", collected: number,
): number | null => {
  const count = routine[field] ?? null;
  const last = observedInstant(routine.lastRunAt);
  if (!last.known || count === null) return count;
  if (last.at === "never" || last.at < addDays(collected, -7)) return count === 0 ? 0 : null;
  if (last.at > collected || (field === "runs7d" && count === 0)) return null;
  return count;
};

type Measure = { label: string; observed: boolean; complete: boolean };

const measure = (label: string, observed: boolean, complete = observed): Measure => ({ label, observed, complete });

const coverage = (entry: VisibilityEntry, observed: boolean, complete: boolean, measures: readonly Measure[]): VisibilityEntry => {
  const seen = entry.seen === true && complete ? true : observed ? "partial" : false;
  const explanation = reportObservation(entry.why);
  if (seen === entry.seen && explanation !== null) return { ...entry, why: explanation };

  const names = (items: readonly Measure[]) => items.map(({ label }) => label).join(", ");
  const known = names(measures.filter((item) => item.observed && item.complete));
  const partial = names(measures.filter((item) => item.observed && !item.complete));
  const missing = names(measures.filter((item) => !item.observed && !item.complete));
  const sentences = [];
  if (known) sentences.push(`Observed ${known}.`);
  if (partial) sentences.push(`Partially observed ${partial}.`);
  if (missing) sentences.push(`Missing ${missing}.`);
  if (seen === "partial" && !partial && !missing) sentences.push("Account-wide coverage is unknown.");
  if (seen !== entry.seen && explanation) {
    const sharedOnly = /\b(?:only|limited to|restricted to) (?:the |a )?shared[- ]folders?\b|\bshared[- ]folders? only\b/iu;
    const scopeStatement = /\b(?:access|scope|view) (?:was |is )?(?:limited|restricted) to\b|\b(?:read|see|view|access) only\b|^only .+ (?:visible|accessible)\b/iu;
    if (sharedOnly.test(explanation)) sentences.push("Access limited to shared folders.");
    else if (scopeStatement.test(explanation) && !/[.!?].+\S/u.test(explanation) && sentences.join(" ").length + explanation.length < 200) {
      sentences.push(explanation);
    }
  }
  return { ...entry, seen, why: sentences.join(" ") || (seen === true ? "The collector reported complete coverage." : "No readings were reported.") };
};

const usageCoverage = (input: CollectorInput, entry: VisibilityEntry): VisibilityEntry => {
  const plan = planUsageOf(input);
  const planObserved = plan !== null && (plan.weeklyLimitUsedPercent !== null || plan.extraCreditsLeftUsd !== null);
  const planComplete = plan !== null && Object.values(plan).every((value) => value !== null);
  const botObserved = input.bots.some((bot) => bot.usage !== null);
  const routineObserved = input.routines.some((routine) => routine.usage !== null);
  const exactShare = ({ usage }: CollectorInput["bots"][number]) =>
    usage?.unit === "percent" || (usage?.unit === "share" && usage.share !== undefined);
  const botsComplete = !input.usageOther && allBotsListed(input) && input.bots.every(exactShare);
  const routinesComplete = completeRoutineList(input) && input.routines.every((routine) => routine.usage !== null);
  return coverage(entry, planObserved || input.usageOther !== undefined || botObserved || routineObserved, botsComplete && routinesComplete && planComplete, [
    measure("exact shares", input.bots.some(exactShare), botsComplete), measure("routine usage", routineObserved, routinesComplete),
    ...(input.bots.some(({ usage }) => usage?.unit === "share" && usage.shareBelow !== undefined) ? [measure("bounds", true)] : []),
    ...(input.bots.some(({ usage }) => usage?.unit === "credits") ? [measure("bot credits", true)] : []),
    ...(input.usageOther ? [measure("one summed line for the rest", true)] : []),
    measure("weekly limit", plan?.weeklyLimitUsedPercent != null), measure("credit balance", plan?.extraCreditsLeftUsd != null),
    measure("plan time", plan?.observedAt != null), measure("plan period", plan?.period != null),
  ]);
};

const inventoryMeasure = <T>(label: string, rows: readonly T[], present: (row: T) => boolean, listed: boolean) =>
  measure(label, rows.some(present), listed && rows.every(present));

export const reportCoverage = (input: CollectorInput, entry: VisibilityEntry): VisibilityEntry => {
  if (entry.signal === "otherBots" && entry.seen === false && input.bots.length > 1) {
    return coverage(entry, true, false, [measure("listed bots", true), measure("full bot inventory", false)]);
  }
  if (entry.signal === "usage") return usageCoverage(input, entry);
  if (entry.signal === "botActivity") {
    const activity = inventoryMeasure("last activity", input.bots, (bot) => bot.lastActiveAt !== null, allBotsListed(input));
    return coverage(entry, activity.observed, activity.complete, [activity]);
  }
  if (entry.signal === "routines") {
    const listed = completeRoutineList(input);
    const collected = Date.parse(input.collectedAt);
    const measures = [
      measure("routine inventory", input.routines.length > 0, listed),
      inventoryMeasure("routine counts", input.bots, (bot) => bot.routineCount !== null, true),
      inventoryMeasure("last runs", input.routines, (row) => row.lastRunAt !== null, listed),
      inventoryMeasure("weekly runs", input.routines, (row) => routineRunCount(row, "runs7d", collected) !== null, listed),
      inventoryMeasure("weekly failures", input.routines, (row) => routineRunCount(row, "failedRuns7d", collected) !== null, listed),
    ];
    return coverage(entry, measures.some((item) => item.observed), measures.every((item) => item.complete), measures);
  }
  if (entry.signal === "tasks" || entry.signal === "pages") {
    const { open, stale7d, blocked, closed7d } = input.tasks;
    const measures = entry.signal === "tasks" ? [
      measure("open tasks", open !== null), measure("stale tasks", stale7d !== null),
      measure("blocked tasks", blocked !== null), measure("seven-day closures", closed7d != null),
    ] : [measure("page count", input.pages.count !== null), measure("seven-day page updates", input.pages.updated7d !== null)];
    return coverage(entry, measures.some((item) => item.observed), measures.every((item) => item.complete), measures);
  }
  const status = entry.seen === true ? "complete" : entry.seen === "partial" ? "partial" : "unobserved";
  return { ...entry, why: reportObservation(entry.why) ?? `The collector marked this signal as ${status}.` };
};
