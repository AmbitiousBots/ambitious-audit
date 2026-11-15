import { isRecord } from "@ambitious/kit/domain/json";
import botUnused from "../../rules/bot-unused.json" with { type: "json" };
import connectorNeedsAuth from "../../rules/connector-needs-auth.json" with { type: "json" };
import connectorNeedsGrant from "../../rules/connector-needs-grant.json" with { type: "json" };
import duplicateRoutines from "../../rules/duplicate-routines.json" with { type: "json" };
import failingRoutine from "../../rules/failing-routine.json" with { type: "json" };
import pausedRoutine from "../../rules/paused-routine.json" with { type: "json" };
import settingsFile from "../../rules/settings.json" with { type: "json" };
import staleTasks from "../../rules/stale-tasks.json" with { type: "json" };
import { parseRule, type RuleDefinition } from "./rules.ts";

const FILES: readonly unknown[] = [failingRoutine, connectorNeedsAuth, connectorNeedsGrant, pausedRoutine, botUnused, staleTasks, duplicateRoutines];

export const RULES: readonly RuleDefinition[] = FILES.map(parseRule);

export const OWN_CONNECTOR_RULE_IDS: readonly string[] = ["connector-needs-auth", "connector-needs-grant"];

for (const rule of RULES) {
  const citesOnlyOwnConnectors = rule.when.kind === "connector-status";
  if (citesOnlyOwnConnectors !== OWN_CONNECTOR_RULE_IDS.includes(rule.id)) {
    throw new Error(`OWN_CONNECTOR_RULE_IDS must list exactly the rules that fire on a connector status, and it disagrees about ${rule.id}.`);
  }
  if (citesOnlyOwnConnectors && rule.dependsOnRole) {
    throw new Error(`rules/${rule.id}.json cites only this bot's own connectors, so its dependsOnRole must be false.`);
  }
}

const unlisted = OWN_CONNECTOR_RULE_IDS.filter((id) => !RULES.some((rule) => rule.id === id));
if (unlisted.length > 0) throw new Error(`OWN_CONNECTOR_RULE_IDS names a rule that has no file: ${unlisted.join(", ")}.`);

const days = isRecord(settingsFile) ? settingsFile.suppressionDays : undefined;

if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
  throw new Error("rules/settings.json needs an integer suppressionDays of 1 or more.");
}

export const SUPPRESSION_DAYS = days;
