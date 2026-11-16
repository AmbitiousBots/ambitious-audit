# ambitious-audit

The audit module turns what a bot can see in an account into a snapshot, diffs it against a stored baseline, applies rule-based findings and returns at most three recommendations, each citing its evidence, plus a map of what the bot could not see. A value the bot could not observe is recorded as unknown, never as zero, and no finding is made from it. It is a command-line tool with JSON in and JSON out, one SQLite file and no user interface. The bot shows results in its own pages. A report leaves the computer only when the owner has approved the tool that sends it and the platform confirms that approval covers the call.

The module follows the shared module contract in [ambitious-kit](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.2.6/MODULE_CONTRACT.md): one binary, a JSON envelope on stdout, one SQLite file, deterministic with `--now` and `--seed`, and no network. Version 0.3.0 uses kit 0.2.6, kept under `vendor/` so a build does not download it.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md). The [code of conduct](CODE_OF_CONDUCT.md) covers how people treat each other here. Report a vulnerability in private, as [SECURITY.md](SECURITY.md) describes.

## Commands

```text
ambitious-audit <command> [--in file] [--db path] [--now ISO8601] [--seed int] [--json]
```

| Command | Access | Input | What `data` holds |
|---|---|---|---|
| `commands` | none | no | Every command, including this one and `selfcheck`. |
| `selfcheck` | write | no | Runtime, binary checksum, database integrity and schema version. |
| `snapshot` | write | collector document | `{ snapshotId, normalized }` |
| `baseline set` | write | `{ snapshotId }` | `{ baselineId }` |
| `diff` | read | `{ from?: baselineId, to: snapshotId }` | `{ changes: [{ path, before, after }] }` |
| `findings` | read | `{ snapshotId }` | `{ mode, findings: [{ kind, ruleId, severity, priority, evidenceIds, summary, withheld? }] }` |
| `recommend` | read | `{ snapshotId }` | `{ mode, recommendations, withheld }` with at most 3 recommendations |
| `report build` | write | `{ snapshotId, reviewRequired, announcements? }` | `{ reportId, payload, next }` |
| `report mark` | write | `{ reportId, state, at }` | `{ report, next }` |
| `feedback build` | none | `{ reportId?, text, from }` | `{ payload }` |
| `schema` | none | no | `{ input, commands, schema }`: the JSON Schema of the collector document, which is the input of `snapshot`. |
| `schema <command>` | none | no | The same for another command's input, for example `schema report mark`. `commands` lists every name that works here. |

`read` commands open the database with `mode=ro` and never create or change it. A newly built `payload` is the `send_report` document in [schemas/send_report.v3.json](schemas/send_report.v3.json). Stored version 1 and version 2 reports remain readable and are returned unchanged. `next` tells the bot what to do with the report: wait for review, send, confirm, or stop.

A report id comes from the snapshot, `--seed` and `--now`. Building the same snapshot again with the same seed and time returns the same id and the stored payload, including its original announcements even if a later build supplies a different list. A report is marked `sent` at most once. When a review is required, `sent` and `failed` are refused until the report is marked `reviewed`. After 3 failed attempts the report stays failed.

`diff` with no `from` uses the latest baseline. `diff` of a snapshot with itself is an empty list. `before` or `after` is JSON `null` when that side has no value.

## Priorities and service announcements

Reports have three item kinds: finding, recommendation and announcement, in the `findings`, `recommendations` and `announcements` arrays. Every item has a `priority` of `high` or `low`. The module decides finding and recommendation priorities in code from the rule's severity; the bot does not choose them:

| Source | Finding priority | Recommendation priority |
|---|---|---|
| A rule with severity `high` | `high` | `high` |
| A rule with severity `medium` or `low` | `low` | `low` |
| A visibility gap | `low` | No recommendation |

There are no rule-specific exceptions. Currently `failing-routine` and `connector-needs-auth` have high priority; all other rules have low priority. The existing finding `severity`, evidence requirements, role-based withholding and limit of three recommendations still apply. The `findings` and `recommend` commands return the same priorities as the report.

Pass the `announcements` array saved from the service's `check_updates` result as the optional `announcements` field of `report build` input. Each service object has `{ id, publishedAt, priority, title, body, url }`. The module copies only `id`, `priority` and `title`; all other fields of each object are ignored. It validates every retained field: `id` is 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit; `priority` is `high` or `low`; `title` is 1 to 120 characters. A malformed entry rejects the input, including an entry that would otherwise be removed as a duplicate or exceed the output limit.

The module keeps the first occurrence of each id, sorts high priority before low while preserving input order within each priority, and then keeps at most ten announcements. Those three fields are copied verbatim, without trimming or rewriting. An absent field produces `announcements: []`. The module never writes announcement text, never calls `check_updates`, and checks shape rather than authenticating the source. The bot must supply only announcements saved from that service result.

## Daily reports and delivery

Run the snapshot routine daily by default; the owner can pause it. The bot passes saved service announcements to `report build` and shows the three item kinds with their high or low priorities using the audit page skill.

An owner can pre-approve `send_report` once for the daily routine. Before every send, the platform must confirm that approval covers the call; otherwise nothing is sent. `reviewRequired` is a separate choice about whether a person must review each report. When it is true, the bot waits for that review and marks `reviewed` before sending, even if the tool call was pre-approved. Use the stored payload and the same report id for every retry.

`feedback build` accepts feedback with or without a `reportId`. Leave the id out for feedback about the service or organization generally. The bot sends the returned payload through `send_feedback` only with approval that covers that call; a `send_report` approval does not cover feedback.

## What the bot could not observe

The collector document is described by [schemas/collector.v1.json](schemas/collector.v1.json); `ambitious-audit schema` prints it. A bot often cannot see everything, and the document has a way to say so for each value:

| Value | When it was not observed | Visibility signal that must then say `seen: false` |
|---|---|---|
| `account.kind` | `"unknown"` | `accountRole` |
| `tasks.open`, `tasks.stale7d`, `tasks.blocked` | `null` | `tasks` |
| `pages.count`, `pages.updated7d` | `null` | `pages` |
| `bots[].lastActiveAt` | `null` | `botActivity` |
| `routines[].pausedAt`, `routines[].createdAt` | left out | none; a paused routine with no `pausedAt` is reported without a duration |
| `bots[].routineCount`, `routines[].lastRunAt` | `null` | `routines` |
| `bots[].usage`, `routines[].usage` | `null` | `usage` |

`null` means not observed. It never means zero, and the module never turns it into zero. `snapshot` refuses a document in which a value is `null` while its signal says `seen: true`, so every gap shows up in the visibility map, in the findings and in the report. `lastActiveAt` and `lastRunAt` take the word `"never"` when the account shows that the thing has not happened yet, which is different from not knowing.

Task counts come from the output of the ambitious-tasks module, which keeps the bot's task list. When that module is not installed, or its output was not read, all three counts are `null`.

### Usage

Usage on a bot or a routine is `null` when it was not observed. Otherwise it takes one of two forms, chosen by `unit`:

| Form | Where | Meaning |
|---|---|---|
| `{ "unit": "credits" \| "percent", "amount7d": number }` | bots and routines | An amount for the 7 days before `collectedAt`: credits used, or a percentage from 0 to 100. |
| `{ "unit": "share", "period": "this_week" \| "last_7_days" \| "last_30_days", "share": number, "periodStart"?, "periodEnd"? }` | bots only | The bot's share, from 0 to 1, of all the account's bot usage in the named period. `this_week` is the current week so far. |

The share form is for an account whose usage report gives each bot's share of a period, lists only the bots that used the most, and sums the rest as one line. Such a report fills three things:

- Each bot it lists by name gets a `usage` in share form. Every share in one document names the same period.
- `usageOther: { "share": number, "botCount"?: number }` at the top of the document holds the summed line for the bots it did not list. It needs at least one listed share, which says what period it covers.
- `weeklyLimitUsed: { "percent": number, "asOf": time }` at the top of the document holds how much of the weekly limit is used, when the account reports it. Reports give it for the current week only; leave it out otherwise.

A bot counted only in the summed line has `usage: null`. Its own share was not observed, so the `usage` signal says `seen: false` and its `why` says that the bot is inside the summed line. The same holds for routines when the report gives nothing per routine. The `usage` signal counts as seen only when usage was observed for every listed bot and every listed routine. A share is never turned into credits or into a percentage of the limit.

The visibility map has exactly one entry for each of nine signals: `transcripts`, `usage`, `otherBots`, `auditLog`, `accountRole`, `tasks`, `pages`, `botActivity` and `routines`. Each entry with `seen: false` becomes a finding of kind `visibility`, so the list of findings always says what the audit does not cover. Those findings never become recommendations.

### When the role is unknown

`account.kind` is `owner`, `guest`, `team` or `unknown`. Use `unknown` when no tool reported the role and the account holder has not stated it. The module never infers a role: a document that names a role while `accountRole` says `seen: false` is refused.

With `unknown` the audit still runs, in partial mode (`mode: "partial"` in the output of `findings` and `recommend`):

- Rules still fire on what was observed.
- A finding from a rule that depends on the role carries `withheld: "roleUnknown"`, and its recommendation is not returned. `recommend` lists those rule ids in `withheld`. A bot that does not know its role may be seeing only part of the account, and it cannot tell what the reader is allowed to change, so advice about routines and bots is held back.
- Advice about this bot's own connectors is still given. The `connectors` list is the bot's own connector list, so what it shows does not depend on how much of the account the bot can see. Two rules have this property: `connector-needs-auth` and `connector-needs-grant`. Their findings carry no `withheld` mark, and their recommendations are returned in any mode.
- `stale-tasks` is also given in any mode, because the task counts come from the bot's own task list.
- Every other rule is withheld. Whatever the mode, a recommendation still needs at least one evidence line, and a report still holds at most 3.
- The report has `accountKind: "unknown"`, and its summary says the role is unknown and how many recommendations were withheld.

## Rules

Rules live in `rules/*.json`. Each one has a positive fixture and a negative fixture.

| Rule | Fires when | Withheld when the role is unknown |
|---|---|---|
| `failing-routine` | A routine's state is `failing`. | yes |
| `connector-needs-auth` | A connector's status is `needsAuth`. | no |
| `connector-needs-grant` | A connector's status is `needsGrant`: it is connected, but this bot has no access to it. | no |
| `paused-routine` | A routine is paused, and its `pausedAt` is more than 7 days before the snapshot. | yes |
| `paused-routine-since-unknown` | A routine is paused, the document gives no `pausedAt`, and the routine was neither created nor run in the 7 days before the snapshot. Severity is low, and the finding names no duration. | yes |
| `bot-unused` | A bot's last activity is `"never"` or more than 14 days before the snapshot, or its last activity was not observed and it is listed with a share of 0 for the last 30 days. Never when its usage shows use within the last 14 days. | yes |
| `stale-tasks` | The count of tasks with no change in 7 days is greater than the threshold in the rule file. | no |
| `duplicate-routines` | Two routines on the same bot share a schedule. | yes |

A rule never fires on a value that is `null` or left out. A bot whose last activity and usage were not observed, and task counts that were not observed, produce no rule finding.

How long a routine has been paused is known only from `pausedAt`, the time the account shows for the pause. The last run does not show it: a routine that last ran a month ago, or never, may have been paused today. So a paused routine with no `pausedAt` is never reported as paused for a number of days. It gets the low finding `paused-routine-since-unknown`, which says only that it is paused and that the account did not show since when. It gets no finding at all when `createdAt` or `lastRunAt` falls in the 7 days before the snapshot, because it cannot have been idle for longer than that.

A bot is reported as unused from its usage only when the usage report lists it with a share of 0 for `last_30_days`, a period that covers the 14 days. A share of 0 for a week does not prove 14 unused days, and a missing usage proves nothing. Usage above 0 in a period that lies within the last 14 days (`amount7d`, `this_week` or `last_7_days`) means the bot was used, whatever `lastActiveAt` says. Connector statuses `ok`, `initializing` and `error` produce no finding. `dependsOnRole` in a rule file says whether its recommendation is withheld when the role is unknown. A rule that fires on a connector status cites only evidence whose `source` is the name of one of this bot's connectors, so it must have `dependsOnRole: false`. Those rules are listed by id in `OWN_CONNECTOR_RULE_IDS` in `src/domain/rule-pack.ts`, and the module refuses to start when that list, the rule files and the `dependsOnRole` values disagree.

Ages are measured from the snapshot's `collectedAt`, not from the clock. A recommendation is kept only when it cites at least one evidence id present in the snapshot. A recommendation whose fingerprint was marked `sent` is dropped for the number of days in `rules/settings.json` (21 by default).

## Data

The database is `$AMBITIOUS_HOME/audit/audit.sqlite`, or the file given by `--db`. `AMBITIOUS_HOME` defaults to the directory the contract names. `PRAGMA user_version` is the number of migrations in `migrations/`.

## Errors

Shared codes (`E_USAGE`, `E_INPUT_SCHEMA`, `E_FORBIDDEN_PATH`, `E_NO_KEY`, `E_DB`, `E_MIGRATION`, `E_INTERNAL`) are defined by the module contract.

When an input does not match its schema, `errors` holds one `E_INPUT_SCHEMA` entry for each failing field, up to 8. The `message` names the field as a JSON pointer and the rule it broke, and the `hint` explains the field and names the `schema` command that prints the full schema:

```json
{
  "code": "E_INPUT_SCHEMA",
  "message": "The input field /tasks/stale7d must be integer or null (rule: type).",
  "hint": "Open tasks with no change in 7 days, or null when not observed. Run \"ambitious-audit schema snapshot\" to print the schema for this input."
}
```

`data.fields` lists every failing pointer with its rule, up to 50. Rules named after JSON Schema keywords (`type`, `required`, `enum`, `pattern`, `additionalProperties` and so on) come from the schema. `false schema` means a field that does not go with the form the value takes, such as `amount7d` beside `"unit": "share"`. The module adds `unique` (a repeated id), `null-needs-visibility-gap`, `role-needs-a-source`, `percent-range` (a percentage above 100), `usage-one-period` (shares from different periods in one document), `period-order` (a period that starts after it ends) and `usage-other-needs-a-share` (`usageOther` with no listed share to give it a period).

This module adds:

| Code | Exit | Meaning | Typical hint |
|---|---|---|---|
| `E_NOT_FOUND` | 1 | No snapshot or baseline has the given id. | Run `snapshot` or `baseline set` and use the id it returns. |
| `E_SNAPSHOT_FORMAT` | 1 | A stored snapshot was written by an earlier version in a form this version does not read. | Collect the account again and run `snapshot`. Set a new baseline if that snapshot was the baseline. |
| `E_NO_BASELINE` | 1 | `diff` was given no `from` and no baseline is stored. | Run `baseline set`, or pass `from`. |
| `E_REPORT_NOT_FOUND` | 1 | No report has the given id. | Run `report build` and use the `reportId` it returns. |
| `E_TRANSITION` | 1 | The report cannot move from its current state to the requested one. | Mark it with a state this report can move to. |
| `E_REVIEW_REQUIRED` | 1 | A report that must be reviewed was marked `sent` or `failed` first, or it was rebuilt with a different review requirement. | Mark it `reviewed`, then mark the outcome. While it is still built, a rebuild may ask for a review. |
| `E_ATTEMPTS_EXHAUSTED` | 1 | The report has already failed the maximum number of times. | Leave it failed. Build a new report when there is something new to send. |

Detail such as the states in a refused transition is in `data`, not in the error object.

## Moving from 0.2.2 to 0.3.0

- New reports use `send_report.v3`: every finding and recommendation has a priority, and every report has an announcements array. `report build` accepts the optional saved service announcements described above.
- Stored version 1 and version 2 reports are read and returned unchanged, including on a rebuild of the same report id. Their schema files are unchanged. Collectors and database migrations are unchanged.
- Daily analysis is the default. The owner can pause the routine and can pre-approve report sends when the platform confirms that approval covers each call.

## Earlier changes: 0.2.1 to 0.2.2

- A collector document accepted by 0.2.0 or 0.2.1 is accepted unchanged and stored exactly as before. Stored snapshots and reports are read as they are, and the report payload is still version 2. Everything new in the collector document is optional.
- `paused-routine` no longer measures a pause from the last run. It fires only when the routine carries `pausedAt` and that time is more than 7 days before the snapshot. Before, a routine created paused on the day of the snapshot, with a last run of `"never"`, was reported as paused for more than 7 days. A collector that writes no `pausedAt` now gets `paused-routine-since-unknown` instead, at low severity and with no duration, or nothing when the routine was created or run in the last 7 days. To keep the 7-day finding, write `pausedAt` when the account shows it.
- Routines take two new optional times, `pausedAt` and `createdAt`. Leave each out when the account does not show it.
- Bot usage takes a second form, `{ "unit": "share", "period", "share" }`, and the document takes optional `usageOther` and `weeklyLimitUsed`; see [Usage](#usage). The `{ unit, amount7d }` form is unchanged.
- `bot-unused` now reads usage as well as `lastActiveAt`, as the rules section describes. One result changes for documents written before: a bot whose `lastActiveAt` is `"never"` or old while its `amount7d` is above 0 is no longer reported as unused.
- A rule file that used `"kind": "routine-state"` with `olderThanDays` is refused; use `"kind": "routine-paused-for"`.
- The vendored kit moves from 0.2.1 to 0.2.6.

## Earlier changes: 0.2.0 to 0.2.1

- When the role is unknown, `connector-needs-auth` and `connector-needs-grant` are no longer withheld: `recommend` and `report build` return their recommendations, their findings carry no `withheld` mark, and `recommend` no longer lists them in `withheld`. Before, a bot that did not know its role found connectors that needed a sign-in and gave no advice about them. Nothing changes when the role is known.
- A connector recommendation needs an evidence line whose `source` is the connector's name, as every recommendation does. A collector that wrote no such line still gets the finding and no recommendation.
- No schema changes shape. A collector document accepted by 0.2.0 is accepted by 0.2.1, stored snapshots and reports are read as they are, and the report payload is still version 2. One description in the collector schema now mentions the connector advice.

## Earlier changes: 0.1.0 to 0.2.0

- Collector documents change shape: `usage` is `{ unit, amount7d }` or `null` instead of `{ credits7d }`, routines carry `usage`, and `visibility` has nine entries. `null` in `lastActiveAt` or `lastRunAt` now means not observed; write `"never"` for something that has not happened. A snapshot stored by 0.1.0 is refused with `E_SNAPSHOT_FORMAT`; collect again.
- `report build` returns a version 2 payload ([schemas/send_report.v2.json](schemas/send_report.v2.json)). It adds `accountKind`, a `kind` on each finding, an optional `withheld` mark, an optional evidence `source`, nullable task and page counts, `needsGrant` and `initializing` connector counts, and the nine-signal visibility map. [schemas/send_report.v1.json](schemas/send_report.v1.json) is kept unchanged for receivers that still hold version 1 reports, and a report built by 0.1.0 is returned as it was stored.
- `findings` now also returns one finding of kind `visibility` for each signal that was not seen.

## Checks

```text
npm ci
npm audit --audit-level=moderate
npm run typecheck
npm run lint
npm run depcruise
npm test
npm run contract
npm run check:schemas
npm run tlc
npm run verify
```

`npm test` builds `dist/ambitious-audit.mjs` and runs the unit, migration and contract tests. `npm run tlc` checks the report-delivery model in `spec/`.
