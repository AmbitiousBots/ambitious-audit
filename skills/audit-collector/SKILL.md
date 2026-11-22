---
name: audit-collector
description: "Gather a version 2 audit snapshot from account tools and record which signals they covered."
---

# Audit collector

Run `ambitious-audit schema` for the collector schema. Set `schemaVersion` to 2 and `collectedAt` to the observation time in UTC. Copy bot and connector display names as the account shows them. The report checks each name and supplies a numbered label if it is withheld. Keep tokens, credentials and conversation transcripts out of every field. Read only data the account tools expose to this bot.

## Usage

Read the platform usage report for one period. Record each listed bot’s share with `unit: "share"` and the reported `period` of `this_week`, `last_7_days` or `last_30_days`. Copy the period start and end if supplied.

- For 42%, write `"share": 0.42`.
- For <1%, write `"shareBelow": 0.01`. Give exactly one of the two share fields.
- For a bot counted only in a combined row, write `"usage": null`. Record the combined row in `usageOther` with its `share` and, when reported, its `botCount`.
- When a tool returns seven-day credits or a percentage for a bot or routine, use `{ "unit": "credits", "amount7d": 3 }` or `{ "unit": "percent", "amount7d": 2.5 }`. If no tool returns routine usage, leave each routine’s `usage` null.
- When the usage report shows plan figures, record `planUsage` with `weeklyLimitUsedPercent` (0–100), `extraCreditsLeftUsdCents` (integer US cents, for example 29 for $0.29), `observedAt` (UTC) and `period`. Use null for each unavailable field. Omit the object when the report has no plan figures.

If the tool gives exact shares for some bots and bounds for others, or omits routine usage or plan readings, keep the readings and set usage visibility to `"partial"`. Explain the bounds and missing coverage in `why`.

## Account and activity

- Record `account.kind` as `owner`, `guest` or `team` when a tool or the account holder identifies the role. Otherwise use `unknown`.
- Copy each connector’s status from the connector list. The allowed values are `ok`, `needsAuth`, `needsGrant`, `initializing` and `error`.
- For `lastActiveAt` on a bot or `lastRunAt` on a routine, copy the reported UTC time. Use `"never"` only when the tool reports no activity since creation. Use null when the tool provides no reading.
- Record each bot’s reported `routineCount`. Compare it with the number of listed routines for that bot and describe any mismatch in routine visibility. For each routine, include seven-day `runs7d` and `failedRuns7d` when a tool reports them. Count failed runs within the total for the same period. Use null for unavailable counts. Copy the optional routine times `pausedAt` and `createdAt` when available and omit them otherwise.
- Read `tasks.open`, `tasks.stale7d`, `tasks.blocked` and `tasks.closed7d` from the task module. Read `pages.count` and `pages.updated7d` from the page tool. An unavailable count is null. A reported zero is 0.

## Visibility and evidence

Include one visibility entry for each of `transcripts`, `usage`, `otherBots`, `auditLog`, `accountRole`, `tasks`, `pages`, `botActivity` and `routines`. Set `seen` to true for complete coverage, false for no observation or `"partial"` for incomplete coverage. Describe the source or gap in `why`. Each null needs a false or partial entry for its signal. Plan readings belong to `usage`, last-active times to `botActivity`, and routine inventory and run counts to `routines`. If no routine tool was available, use an empty list and state that the inventory was unavailable.

Use evidence ids such as `ev-1`. Give a short observation of at most 200 characters for the report. Set `source` to the relevant bot id, routine id, connector name or `tasks`. Copy the exact case of each bot id. Include an evidence line for each connector that needs a sign-in or grant and for low-share readings that support a recommendation.

Write the collector document outside the bot’s private data directory and pass it to `snapshot --in`. Validation errors identify the field and rule.
