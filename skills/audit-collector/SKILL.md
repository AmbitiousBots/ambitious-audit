---
name: audit-collector
description: "Gather a collector document for ambitious-audit from the account the bot can see, and say honestly what it could not see."
---

# Audit collector

Build the JSON document that `ambitious-audit snapshot` stores. Use only the bot's own tools. Do not read another program's private files, and do not put a conversation transcript in any field. Every text field is short: evidence text is at most 280 characters.

When unsure about a field, run `ambitious-audit schema`. It prints the full schema with a description of every field. If `snapshot` refuses the document, each error names the field as a JSON pointer and the rule it broke; fix those fields and run it again.

## Write what was observed, and null for the rest

Include `schemaVersion` 1, `collectedAt` as UTC, the account, then the bots, routines, connectors, task counts and page counts that the tools actually returned.

A value no tool returned is `null`. Never write 0 for it, and never estimate.

- `account.kind` is `owner`, `guest` or `team` only when a tool reported the role or the account holder stated it. Otherwise write `unknown`. Do not work the role out from what the bot can or cannot do. The audit still runs with `unknown`.
- `tasks.open`, `tasks.stale7d` and `tasks.blocked` come from the output of the ambitious-tasks module. If it is not installed or was not run, all three are `null`.
- `pages.count` and `pages.updated7d` are `null` when the page tool did not return them.
- `lastActiveAt` on a bot and `lastRunAt` on a routine are a UTC time, the word `never` when the account shows it has not happened yet, or `null` when the account does not show it.
- `routineCount` on a bot is `null` when it was not shown.
- `pausedAt` on a paused routine is the UTC time the account shows for when it was paused. `createdAt` is the UTC time the account shows for when the routine was created. Leave each one out when the account does not show it; do not write `null`, and do not work a pause time out from the last run or from anything else. Without `pausedAt` the audit says only that the routine is paused, with no number of days.
- `usage` on each routine is `{ "unit": "credits", "amount7d": 412.5 }` or `{ "unit": "percent", "amount7d": 82.5 }` when the account reports the routine's usage for the last 7 days, or `null` when it does not.
- `usage` on each bot takes the same two forms, or the share form described next, or `null`.

## Usage reported as shares

Some accounts report usage only as each bot's share of all bot usage in a period, list the bots that used the most, and sum the rest as one line such as "Other bots". Ask the usage tool for one period and write what it returns:

- For each bot the report lists by name: `"usage": { "unit": "share", "period": "this_week", "share": 0.42 }`. `period` is `this_week` (the current week so far), `last_7_days` or `last_30_days`, whichever was asked for. A share shown as 42% is written `0.42`. Add `periodStart` and `periodEnd` when the report gives them. Use the same period for every bot.
- For the summed line: `"usageOther": { "share": 0.08, "botCount": 3 }` at the top of the document. Leave `botCount` out when the report does not say how many bots the line sums.
- For every bot the report did not list by name, including each bot inside the summed line: `"usage": null`. Its own share was not observed. Never write 0 for it, and never split the summed share between bots.
- When the report gives the percentage of the weekly limit used, which it does only for the current week: `"weeklyLimitUsed": { "percent": 37, "asOf": "2026-11-15T00:00:00Z" }` at the top of the document. Leave it out for other periods.
- A report that gives shares by bot gives nothing per routine, so each routine's `usage` is `null`.

When any bot or routine has `usage: null`, the `usage` signal is `seen: false`. Say in its `why` what the report did give, which bots are only inside the summed line, and that it gives nothing per routine.
- `connectors` holds this bot's own connectors, as its connector list shows them. A connector's `status` is `ok`, `needsAuth`, `needsGrant`, `initializing` or `error`, as the list shows it.

## Visibility

`visibility` must contain exactly one entry for each of `transcripts`, `usage`, `otherBots`, `auditLog`, `accountRole`, `tasks`, `pages`, `botActivity` and `routines`. Set `seen` from what the tool call did, and `why` in one sentence. If a tool was missing or refused, `seen` is false and `why` says so. Do not leave a signal out.

Every `null` needs its signal set to `seen: false`: `accountRole` for an unknown role, `tasks` and `pages` for their counts, `botActivity` for `lastActiveAt`, `routines` for `routineCount` and `lastRunAt`, and `usage` for usage. `usage` is seen only when usage was read for every listed bot and every listed routine.

## Evidence

`evidence` entries use ids `ev-1`, `ev-2`, and so on. Point `source` at the bot id, routine id or connector name the line is about, or `tasks` for task counts, so a finding about that thing can cite it. A recommendation is only made when its finding has evidence.

Write one evidence line for each connector whose status is `needsAuth` or `needsGrant`, with `source` set to exactly the connector's `name`. Advice about the bot's own connectors is given even when the role is `unknown`, but only for connectors that have such a line.

Write the document to a file outside the bot's private data directory and pass it with `--in`.
