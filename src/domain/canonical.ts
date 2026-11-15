import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import type { CollectorInput, VisibilityEntry, VisibilityMap, VisibilitySignal } from "./types.ts";
import type { CollectorV1Bot, CollectorV1Connector, CollectorV1Evidence, CollectorV1Routine } from "./wire.generated.ts";

const SIGNAL_ORDER: readonly VisibilitySignal[] = ["transcripts", "usage", "otherBots", "auditLog"];

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const unique = (values: readonly string[], label: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw failure("E_INPUT_SCHEMA", `The ${label} "${value}" is repeated.`, `Give every ${label} its own value.`);
    }
    seen.add(value);
  }
};

const copyRoutine = (routine: CollectorV1Routine): CollectorV1Routine => ({
  id: routine.id,
  botId: routine.botId,
  schedule: routine.schedule,
  state: routine.state,
  lastRunAt: routine.lastRunAt,
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

export const visibilityOf = (input: CollectorInput): VisibilityMap => {
  const ordered = SIGNAL_ORDER.map((signal) => input.visibility.find((entry) => entry.signal === signal));
  const at = (index: number): VisibilityEntry => {
    const entry = ordered[index];
    if (entry === undefined) {
      throw failure("E_INPUT_SCHEMA", "Visibility must list every signal once.", "Add the missing signal and say whether it was seen and why.");
    }
    return entry;
  };
  return [at(0), at(1), at(2), at(3)];
};

export const normalizeCollector = (input: CollectorInput): CollectorInput => {
  unique(input.bots.map((bot) => bot.id), "bot id");
  unique(input.routines.map((routine) => routine.id), "routine id");
  unique(input.connectors.map((connector) => connector.name), "connector name");
  unique(input.evidence.map((item) => item.id), "evidence id");
  unique(input.visibility.map((entry) => entry.signal), "visibility signal");
  const visibility = visibilityOf(input);
  const bots: readonly CollectorV1Bot[] = input.bots
    .map((bot) => ({ id: bot.id, name: bot.name, lastActiveAt: bot.lastActiveAt, routineCount: bot.routineCount, usage: { credits7d: bot.usage.credits7d } }))
    .sort((left, right) => compareText(left.id, right.id));
  const routines = input.routines.map(copyRoutine).sort((left, right) => compareText(left.id, right.id));
  const connectors: readonly CollectorV1Connector[] = input.connectors
    .map((connector) => ({ name: connector.name, status: connector.status }))
    .sort((left, right) => compareText(left.name, right.name));
  const evidence: readonly CollectorV1Evidence[] = input.evidence
    .map((item) => ({ id: item.id, kind: item.kind, text: item.text, source: item.source }))
    .sort((left, right) => compareText(left.id, right.id));
  return {
    schemaVersion: 1,
    collectedAt: input.collectedAt,
    account: { kind: input.account.kind, label: input.account.label },
    bots,
    routines,
    connectors,
    tasks: { open: input.tasks.open, stale7d: input.tasks.stale7d, blocked: input.tasks.blocked },
    pages: { count: input.pages.count, updated7d: input.pages.updated7d },
    visibility,
    evidence,
  };
};
