import { isEvidenceId, type CollectorInput, type EvidenceId } from "./types.ts";
import type { CollectorV2BotUsage } from "./wire.generated.ts";

export type SourceKind = NonNullable<CollectorInput["evidence"][number]["sourceKind"]>;

type Subject = {
  kind: SourceKind;
  key: string;
  source: string;
  text: string;
};

const periods = { this_week: "this week", last_7_days: "the last 7 days", last_30_days: "the last 30 days" };

const measuredPeriod = (usage: Extract<CollectorV2BotUsage, { unit: "share" }>): string => {
  const { periodStart, periodEnd } = usage;
  if (periodStart && periodEnd) return `the period from ${periodStart} to ${periodEnd}`;
  if (periodStart) return `the period starting ${periodStart}`;
  if (periodEnd) return `the period ending ${periodEnd}`;
  return periods[usage.period];
};

const botReading = ({ lastActiveAt, usage }: CollectorInput["bots"][number]): string => {
  const statements = [];
  if (usage?.unit === "share") {
    const period = measuredPeriod(usage);
    if (usage.share === 0) statements.push(`The bot had zero usage over ${period}.`);
    else if ((usage.shareBelow ?? 1) <= 0.01 || (usage.share ?? 1) < 0.01) statements.push(`The bot accounted for less than 1% of usage over ${period}.`);
    else statements.push(`The usage report recorded ${usage.share === undefined ? "an upper bound" : "an exact share"} for ${period}.`);
  } else if (usage?.unit === "percent" && usage.amount7d < 1) {
    statements.push("The bot accounted for less than 1% of usage over the last 7 days.");
  } else if (usage) {
    statements.push("The usage report recorded seven-day usage.");
  }
  if (lastActiveAt === "never") statements.push("The bot has never been active.");
  else if (lastActiveAt !== null) statements.push(`Last active at ${lastActiveAt}.`);
  return statements.join(" ") || "The bot appeared in the inventory.";
};

export const evidenceSubjects = (snapshot: CollectorInput): ReadonlyMap<EvidenceId, Subject> => {
  const subjects: Subject[] = [
    ...snapshot.bots.map((bot, i) => ({ kind: "bot" as const, key: bot.id, source: `Bot ${i + 1}`, text: botReading(bot) })),
    ...snapshot.routines.map((row, i) => ({
      kind: "routine" as const, key: row.id, source: `Routine ${i + 1}`,
      text: row.state === "paused" && row.pausedAt ? `The routine has been paused since ${row.pausedAt}.` : `The routine is ${row.state}.`,
    })),
    ...snapshot.connectors.map((row, i) => ({
      kind: "connector" as const, key: row.name, source: `Connector ${i + 1}`, text: `The connector reported status ${row.status}.`,
    })),
    { kind: "tasks", key: "tasks", source: "Task counts", text: `Open tasks stale for seven days: ${snapshot.tasks.stale7d ?? "unknown"}.` },
  ];
  const index: Record<SourceKind, Map<string, Subject[]>> = {
    bot: new Map(), routine: new Map(), connector: new Map(), tasks: new Map(),
  };
  for (const subject of subjects) {
    const inventory = index[subject.kind];
    const key = subject.kind === "bot" ? subject.key : subject.key.toLowerCase();
    const group = inventory.get(key) ?? [];
    group.push(subject);
    inventory.set(key, group);
  }
  const lookup = (kind: SourceKind, key: string) => {
    const group = index[kind].get(kind === "bot" ? key : key.toLowerCase()) ?? [];
    return group.length === 1 ? group : group.filter((subject) => subject.key === key);
  };
  const legacyMatches = (key: string) => key.toLowerCase() === "tasks" ? lookup("tasks", key)
    : [...lookup("bot", key), ...lookup("routine", key), ...lookup("connector", key)];
  const resolved = new Map<EvidenceId, Subject>();
  for (const row of snapshot.evidence) {
    // WHY: V1 reserved "tasks" and supplied no kinds. A legacy reference needs one unambiguous subject.
    const matches = snapshot.schemaVersion === 1 ? legacyMatches(row.source) : row.sourceKind ? lookup(row.sourceKind, row.source) : [];
    const subject = matches[0];
    if (subject && matches.length === 1 && isEvidenceId(row.id)) resolved.set(row.id, subject);
  }
  return resolved;
};
