import { addDays, observedInstant } from "./time.ts";
import type { CollectorInput, SendReportPayload, VisibilityEntry } from "./types.ts";

export const planUsageOf = (snapshot: CollectorInput): SendReportPayload["planUsage"] => {
  if (snapshot.planUsage !== undefined) {
    const { weeklyLimitUsedPercent, extraCreditsLeftUsdCents, observedAt, period } = snapshot.planUsage;
    return { weeklyLimitUsedPercent, extraCreditsLeftUsd: extraCreditsLeftUsdCents === null ? null : extraCreditsLeftUsdCents / 100, observedAt, period };
  }
  const legacy = snapshot.weeklyLimitUsed;
  if (!legacy || legacy.percent > 100) return null;
  return { weeklyLimitUsedPercent: legacy.percent, extraCreditsLeftUsd: null, observedAt: legacy.asOf, period: "this_week" };
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

const coverage = (
  entry: VisibilityEntry, observed: boolean, complete: boolean,
  why: { readonly partial: string; readonly unseen: string },
): VisibilityEntry => {
  if (entry.seen === true && complete) return entry;
  const seen = observed ? "partial" : false;
  if (entry.seen !== true) return { ...entry, seen };
  return { ...entry, seen, why: observed ? why.partial : why.unseen };
};

const usageCoverage = (input: CollectorInput, entry: VisibilityEntry): VisibilityEntry => {
  const plan = planUsageOf(input);
  const planObserved = plan !== null && (plan.weeklyLimitUsedPercent !== null || plan.extraCreditsLeftUsd !== null);
  const planComplete = plan !== null && Object.values(plan).every((value) => value !== null);
  const observed = planObserved || input.usageOther !== undefined ||
    input.bots.some((bot) => bot.usage !== null) || input.routines.some((routine) => routine.usage !== null);
  const botsComplete = !input.usageOther && allBotsListed(input) && input.bots.every(({ usage }) =>
    usage?.unit === "percent" || (usage?.unit === "share" && usage.share !== undefined));
  const routinesComplete = completeRoutineList(input) && input.routines.every((routine) => routine.usage !== null);
  return coverage(entry, observed, botsComplete && routinesComplete && planComplete, {
    partial: [
      ...(botsComplete ? [] : ["Some bot shares are missing or bounded."]),
      ...(input.usageOther === undefined ? [] : ["The usage report includes one summed line for the rest."]),
      ...(routinesComplete ? [] : ["Routine usage is incomplete."]),
      ...(planComplete ? [] : ["Plan readings are incomplete."]),
    ].join(" "),
    unseen: "No bot, routine or plan usage reading was reported.",
  });
};

export const reportCoverage = (input: CollectorInput, entry: VisibilityEntry): VisibilityEntry => {
  if (entry.signal === "otherBots" && entry.seen === false && input.bots.some((bot) => bot.id !== input.bots[0]?.id)) return { ...entry, seen: "partial" };
  if (entry.signal === "usage") return usageCoverage(input, entry);
  if (entry.signal === "botActivity") {
    const observed = input.bots.some((bot) => bot.lastActiveAt !== null);
    const complete = (observed || entry.seen === true) && allBotsListed(input) && input.bots.every((bot) => bot.lastActiveAt !== null);
    return coverage(entry, observed, complete, {
      partial: "Activity was reported for part of the bot inventory.",
      unseen: "No bot activity reading was reported.",
    });
  }
  if (entry.signal === "routines") {
    const observed = input.routines.length > 0 || input.bots.some((bot) => bot.routineCount !== null);
    const collected = Date.parse(input.collectedAt);
    const complete = completeRoutineList(input) && input.bots.every((bot) => bot.routineCount !== null) &&
      input.routines.every((routine) => routine.lastRunAt !== null &&
        routineRunCount(routine, "runs7d", collected) !== null && routineRunCount(routine, "failedRuns7d", collected) !== null);
    return coverage(entry, observed, complete, {
      partial: "The routine inventory or its run history is incomplete.",
      unseen: "No routine inventory or run history was reported.",
    });
  }
  if (entry.signal === "tasks" || entry.signal === "pages") {
    const tasks = input.tasks;
    const label = entry.signal === "tasks" ? "task" : "page";
    const counts = entry.signal === "tasks" ? [tasks.open, tasks.stale7d, tasks.blocked, tasks.closed7d] : [input.pages.count, input.pages.updated7d];
    return coverage(entry, counts.some((count) => count != null), counts.every((count) => count != null), {
      partial: `Some ${label} counts were unavailable.`,
      unseen: `No ${label} counts were reported.`,
    });
  }
  return entry;
};
