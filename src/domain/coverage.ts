import { addDays, observedInstant } from "./time.ts";
import type { CollectorInput, SendReportPayload, VisibilityEntry } from "./types.ts";

type CollectorVisibility = CollectorInput["visibility"][number];

export const observedPlan = (snapshot: CollectorInput) => {
  const plan = snapshot.planUsage;
  return plan && Object.values(plan).some((value) => value !== null) ? plan : undefined;
};

export const planUsageOf = (snapshot: CollectorInput): SendReportPayload["planUsage"] => {
  const legacy = snapshot.weeklyLimitUsed;
  const legacyPercent = legacy && legacy.percent <= 100 ? legacy.percent : null;
  const plan = observedPlan(snapshot);
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

const restricted = ({ scope }: CollectorVisibility): boolean => scope === "shared_only" || scope === "limited";

const scopeText = { shared_only: "Access limited to shared folders.", limited: "Access limited to part of the account.", all: "Account-wide access." };

const visibility = (entry: CollectorVisibility, seen: VisibilityEntry["seen"], statement: string): VisibilityEntry => ({
  signal: entry.signal, seen, why: entry.scope ? `${statement} ${scopeText[entry.scope]}` : statement,
});

const botInventory = (input: CollectorInput): "complete" | "incomplete" | "unconfirmed" => {
  const { usageOther } = input;
  if (usageOther?.botCount === 0 && usageOther.share > 0) return "incomplete";
  const otherCount = usageOther?.botCount ?? (usageOther && usageOther.share > 0 ? 1 : 0);
  if (otherCount > 0) {
    const others = input.bots.filter((bot) => bot.usage === null);
    if (otherCount > others.length || others.some((bot) => bot.routineCount === null)) return "incomplete";
  }
  const ids = new Set(input.bots.map((bot) => bot.id));
  if (input.routines.some((routine) => !ids.has(routine.botId))) return "incomplete";
  const entry = input.visibility.find((entry) => entry.signal === "otherBots");
  return entry?.seen === true && !restricted(entry) ? "complete" : "unconfirmed";
};

export const completeRoutineList = (input: CollectorInput, inventory = botInventory(input)): boolean => {
  if (inventory === "incomplete") return false;
  const listed = new Map<string, number>();
  for (const routine of input.routines) listed.set(routine.botId, (listed.get(routine.botId) ?? 0) + 1);
  for (const bot of input.bots) {
    if (bot.routineCount !== null && bot.routineCount !== (listed.get(bot.id) ?? 0)) return false;
  }

  const entry = input.visibility.find((item) => item.signal === "routines");
  const seen = entry?.seen;
  if (entry && seen === true && !restricted(entry)) return true;
  if (seen === false && input.routines.length === 0) return false;
  return inventory === "complete" && input.bots.every((bot) => bot.routineCount !== null);
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

const coverage = (entry: CollectorVisibility, observed: boolean, complete: boolean, measures: readonly Measure[]): VisibilityEntry => {
  const seen = entry.seen === true && complete && !restricted(entry) ? true : observed ? "partial" : false;

  const names = (items: readonly Measure[]) => items.map(({ label }) => label).join(", ");
  const known = names(measures.filter((item) => item.observed && item.complete));
  const partial = names(measures.filter((item) => item.observed && !item.complete));
  const missing = names(measures.filter((item) => !item.observed && !item.complete));
  const sentences = [];
  if (known) sentences.push(`Observed ${known}.`);
  if (partial) sentences.push(`Partially observed ${partial}.`);
  if (missing) sentences.push(`Missing ${missing}.`);
  if (seen === "partial" && !entry.scope && !partial && !missing) sentences.push("Account-wide coverage is unknown.");
  return visibility(entry, seen, sentences.join(" ") || (complete ? "The inventory was empty." : "No readings were reported."));
};

const usageCoverage = (input: CollectorInput, entry: CollectorVisibility): VisibilityEntry => {
  const plan = planUsageOf(input);
  const planObserved = plan !== null && (plan.weeklyLimitUsedPercent !== null || plan.extraCreditsLeftUsd !== null);
  const planComplete = plan !== null && Object.values(plan).every((value) => value !== null);
  const botObserved = input.bots.some((bot) => bot.usage !== null);
  const routineObserved = input.routines.some((routine) => routine.usage !== null);
  const exactShare = ({ usage }: CollectorInput["bots"][number]) =>
    usage?.unit === "percent" || (usage?.unit === "share" && usage.share !== undefined);
  const inventory = botInventory(input);
  const botsComplete = !input.usageOther && inventory === "complete" && input.bots.every(exactShare);
  const routinesComplete = completeRoutineList(input, inventory) && input.routines.every((routine) => routine.usage !== null);
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

export const reportCoverage = (input: CollectorInput, entry: CollectorVisibility): VisibilityEntry => {
  if (entry.signal === "otherBots") {
    const inventory = botInventory(input);
    const observed = input.bots.length > 1 || input.usageOther !== undefined || entry.seen !== false || inventory === "incomplete";
    if (observed) return coverage(entry, true, inventory === "complete", [
      ...(input.bots.length > 0 ? [measure("listed bots", true)] : []),
      ...(input.usageOther ? [measure("combined other-bot share", true)] : []),
      measure("full bot inventory", inventory === "complete"),
    ]);
  }
  if (entry.signal === "accountRole") {
    const known = input.account.kind !== "unknown";
    return visibility(entry, known, known ? "Observed account role." : "Missing account role.");
  }
  if (entry.signal === "usage") return usageCoverage(input, entry);
  if (entry.signal === "botActivity") {
    const activity = inventoryMeasure("last activity", input.bots, (bot) => bot.lastActiveAt !== null, botInventory(input) === "complete");
    return coverage(entry, activity.observed, activity.complete, [activity]);
  }
  if (entry.signal === "routines") {
    const inventory = botInventory(input);
    const listed = completeRoutineList(input, inventory);
    const collected = Date.parse(input.collectedAt);
    const measures = [
      measure("routine inventory", input.routines.length > 0, listed),
      inventoryMeasure("routine counts", input.bots, (bot) => bot.routineCount !== null, inventory !== "incomplete"),
      inventoryMeasure("last runs", input.routines, (row) => row.lastRunAt !== null, listed),
      inventoryMeasure("weekly runs", input.routines, (row) => routineRunCount(row, "runs7d", collected) !== null, listed),
      inventoryMeasure("weekly failures", input.routines, (row) => routineRunCount(row, "failedRuns7d", collected) !== null, listed),
    ];
    return coverage(entry, inventory === "incomplete" || (listed && input.routines.length === 0) || measures.some((item) => item.observed), measures.every((item) => item.complete), measures);
  }
  if (entry.signal === "tasks" || entry.signal === "pages") {
    const { open, stale7d, blocked, closed7d } = input.tasks;
    const measures = entry.signal === "tasks" ? [
      measure("open tasks", open !== null), measure("stale tasks", stale7d !== null),
      measure("blocked tasks", blocked !== null), measure("seven-day closures", closed7d != null),
    ] : [measure("page count", input.pages.count !== null), measure("seven-day page updates", input.pages.updated7d !== null)];
    return coverage(entry, measures.some((item) => item.observed), measures.every((item) => item.complete), measures);
  }
  const seen = entry.seen === true && restricted(entry) ? "partial" : entry.seen;
  const status = seen === true ? "complete" : seen === "partial" ? "partial" : "unobserved";
  return visibility(entry, seen, `The collector marked this signal as ${status}.`);
};
