import { isRecord } from "@ambitious/kit/domain/json";
import botUnused from "../../rules/bot-unused.json" with { type: "json" };
import connectorNeedsAuth from "../../rules/connector-needs-auth.json" with { type: "json" };
import duplicateRoutines from "../../rules/duplicate-routines.json" with { type: "json" };
import failingRoutine from "../../rules/failing-routine.json" with { type: "json" };
import pausedRoutine from "../../rules/paused-routine.json" with { type: "json" };
import settingsFile from "../../rules/settings.json" with { type: "json" };
import staleTasks from "../../rules/stale-tasks.json" with { type: "json" };
import { parseRule, type RuleDefinition } from "./rules.ts";

const FILES: readonly unknown[] = [failingRoutine, connectorNeedsAuth, pausedRoutine, botUnused, staleTasks, duplicateRoutines];

export const RULES: readonly RuleDefinition[] = FILES.map(parseRule);

const days = isRecord(settingsFile) ? settingsFile.suppressionDays : undefined;

if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
  throw new Error("rules/settings.json needs an integer suppressionDays of 1 or more.");
}

export const SUPPRESSION_DAYS = days;
