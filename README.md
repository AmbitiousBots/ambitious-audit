# ambitious-audit

The audit module turns what a bot can see in an account into a snapshot, diffs it against a stored baseline, applies rule-based findings and returns at most three recommendations, each citing its evidence, plus a map of what the bot could not see. A value the bot could not observe is recorded as unknown, never as zero, and no finding is made from it. It is a command-line tool with JSON in and JSON out, one SQLite file and no user interface. The bot shows results in its own pages. A report leaves the computer only when the owner has approved the tool that sends it and the platform confirms that approval covers the call.

The module follows the shared module contract in [ambitious-kit](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.4.9/MODULE_CONTRACT.md): one binary, a JSON envelope on stdout, one SQLite file, deterministic with `--now` and `--seed`, and no network. Version 0.4.1 uses kit 0.4.9, kept under `vendor/` so a build does not download it. The release file is `ambitious-audit-0.4.1.mjs`.

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
| `schema` | none | no | `{ input, commands, schema }`: the collector v2 schema for `snapshot`. |
| `schema send report` | none | no | `{ output, schema }` for the v4 report payload. |
| `schema <command>` | none | no | The same for another command's input, for example `schema report mark`. `commands` lists every name that works here. |

`read` commands open the database with `mode=ro` and never create or change it. A newly built `payload` is the `send_report` document in [schemas/send_report.v4.json](schemas/send_report.v4.json). A same-id rebuild returns the stored payload for every report version. `next` tells the bot what to do with the report: wait for review, send, confirm, or stop.

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

Use collector v2 for new snapshots. Keep credentials and transcripts out of collector input. Copy bot and connector display names as the platform shows them. The report forwards each name after normalization and a 40-character display-name check. The check withholds credential-like strings and spelled-out addresses. A withheld name appears as `Bot N` or `Connector N` with `nameWithheld: true`. Display names are the only collector free text the report forwards. The remaining disclosure risk is what an owner types into a name that passes the check. [Collector schema](schemas/collector.v2.json) · [Display name rules](schemas/README.md#collector-text-in-reports)

Each visibility entry has a `signal` and a `seen` value. Use `true` for complete coverage, `false` for no observation and `"partial"` for incomplete coverage. Set `scope` to `all`, `shared_only` or `limited` when the tool identifies its access scope. Include one entry for each of `transcripts`, `usage`, `otherBots`, `auditLog`, `accountRole`, `tasks`, `pages`, `botActivity` and `routines`. Gaps produce visibility findings. The report explains coverage using readings and scope.

Give each v2 evidence row a `sourceKind` of `bot`, `routine`, `connector` or `tasks` to support a recommendation. Set `source` to the matching bot ID, routine ID, connector name or the literal `tasks`. A row without a source kind stays local. The collector’s evidence IDs, sources, evidence text and optional visibility notes stay in the snapshot. The module writes one observation per cited subject and assigns IDs such as `ev-1`. Usage observations include each UTC period boundary the tool supplies.

| Observation | When unavailable | Visibility signal |
|---|---|---|
| Account role | `account.kind: "unknown"` | `accountRole` |
| Open, stale, blocked and seven-day closed task counts from the task module | `null` | `tasks` |
| Page count and pages updated in seven days | `null` | `pages` |
| Each bot’s last activity | `null` | `botActivity` |
| Per-bot routine count, last routine run, runs and failed runs in seven days | `null` | `routines` |
| Bot, routine or plan readings | `null` for each missing value | `usage` |

A null value requires a false or partial visibility entry. For last activity and last run, use a UTC timestamp when reported, or `"never"` when the tool reports no activity since creation. Omit the optional routine times `pausedAt` and `createdAt` when unavailable.

### Usage and activity

Read bot shares from the platform usage report. Use one period for all bot shares in a snapshot. Add `periodStart` and `periodEnd` when the report supplies them.

| Platform reading | Collector v2 | Report v4 |
|---|---|---|
| 42% of bot usage over the last seven days | `{"unit":"share","period":"last_7_days","share":0.42}` | `usageShare: 0.42` |
| <1% over that period | `{"unit":"share","period":"last_7_days","shareBelow":0.01}` | `usageShareBelow: 0.01` |
| A named bot share and a combined “other” row in the same period | Store the named share and `usageOther.share`. Leave each bot covered only by the aggregate at `usage: null` | Both individual share fields are null |

Omit `usageOther` when the tool supplies only an aggregate. At least one listed bot share must establish the period.

Each share carries its `usagePeriod`, one of `this_week`, `last_7_days` or `last_30_days`. The bot row includes `usagePeriodStart` and `usagePeriodEnd` for each UTC boundary the tool supplies. Seven-day percentage readings in the legacy `{unit, amount7d}` form also yield a share. Report fractions use four decimal places at most. A positive share below 0.0001 becomes `usageShareBelow: 0.0001`. Larger measured shares round to the nearest increment and strict bounds round upward. Rules use the collected readings at their original precision. Credit amounts alone leave both share fields and the period null. If the report gives bot shares and omits routine usage, mark usage partial and retain every bot reading.

When the platform provides plan figures, collect `planUsage` with `weeklyLimitUsedPercent` (0–100), `extraCreditsLeftUsdCents` (integer US cents), `observedAt` (UTC) and `period`. For a balance of $0.29, collect 29 cents. The report carries `extraCreditsLeftUsd: 0.29`. Use null for each missing value. Omit the object when the tool provides no plan reading. An all-null object is equivalent to omission. For older snapshots, a `weeklyLimitUsed` percentage within 0–100 supplies the percentage, observation time and current-week period. When both plan formats identify the same current week and observation instant, the legacy reading fills a missing percentage. The report rounds the percentage to four decimal places.

Full usage coverage requires exact shares across the bot inventory, usage for every routine, and both plan figures with their observation time and period.

The v4 payload lists up to 200 bots with display name, exact share or upper bound, period, last activity and routine count. It lists up to 200 connectors with display name and status. `counts.tasks.closed7d` records seven-day closures. `counts.routines` gives active, paused and failing totals, plus `runs7d` and `failedRuns7d`. Each routine’s failed runs must fit within its total runs. A run count that conflicts with the last run makes that seven-day total null and routine visibility partial. Task and page counts, including zero, establish at least partial visibility. Coverage explanations name the observed and missing measures and include any reported access restriction. Full coverage requires the collector to confirm its scope. Two distinct bot IDs or a combined `usageOther` row establish at least partial visibility of other bots. A routine owned by an unlisted bot makes both inventories partial. A positive aggregate share implies at least one other bot when the count is omitted. A positive share with an explicit count of zero leaves the aggregate bots unaccounted for. Listed bots with unknown usage and known routine counts must account for a positive or inferred count. An unaccounted bot makes both inventories partial and all five routine totals null. A per-bot count that disagrees with the routine list also makes all five totals null and routine coverage partial. An observed empty routine list consistent with all known counts yields zero. An unseen inventory yields null totals. A partially observed inventory yields null totals unless every bot’s known routine count reconciles with its listed routines and the bot list is complete. Each run total also requires that measure on every listed routine.

When the serialized report exceeds its byte budget, `truncated: true` marks shortened bot or connector lists. Counts still cover the full snapshot. See the [report size budget](schemas/README.md#serialized-report-size).

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
| `bot-unused` | A bot's last activity is `"never"` or more than 14 days before the snapshot, or its last activity was not observed and an exact zero share for `last_30_days` covers more than 14 days through the snapshot. Usage within the last 14 days suppresses this rule. A positive seven-day run count or a last run within those 14 days on any routine owned by the bot also counts as activity. | yes |
| `bots-barely-used` | At least three bots each accounted for under 1% of usage over `last_7_days`, by exact share, upper bound or seven-day percentage. Explicit boundaries must span 6–8 days. The period must cover at least six of the seven days ending at the snapshot. The recommendation requires bot-kind evidence for the exact ID of a qualifying bot. Priority is low and effort is small. | yes |
| `stale-tasks` | The count of tasks with no change in 7 days is greater than the threshold in the rule file. | no |
| `duplicate-routines` | Two routines on the same bot share a schedule. | yes |

A rule never fires on a value that is `null` or left out. A bot whose last activity and usage were not observed, and task counts that were not observed, produce no rule finding.

How long a routine has been paused is known only from `pausedAt`, the time the account shows for the pause. The last run does not show it: a routine that last ran a month ago, or never, may have been paused today. So a paused routine with no `pausedAt` is never reported as paused for a number of days. It gets the low finding `paused-routine-since-unknown`, which says only that it is paused and that the account did not show since when. It gets no finding at all when `createdAt` or `lastRunAt` falls in the 7 days before the snapshot, because it cannot have been idle for longer than that.

A bot is reported as unused from its usage only when the usage report lists it with a share of 0 for `last_30_days`, with an interval that starts more than 14 days before collection and reaches collection time. A share of 0 for a week does not prove 14 unused days, and a missing usage proves nothing. Usage above 0 in a period that lies within the last 14 days (`amount7d`, `this_week` or `last_7_days`) means the bot was used, whatever `lastActiveAt` says. Connector statuses `ok`, `initializing` and `error` produce no finding. `dependsOnRole` in a rule file says whether its recommendation is withheld when the role is unknown. A rule that fires on a connector status cites only evidence whose `source` is the name of one of this bot's connectors, so it must have `dependsOnRole: false`. Those rules are listed by id in `OWN_CONNECTOR_RULE_IDS` in `src/domain/rule-pack.ts`, and the module refuses to start when that list, the rule files and the `dependsOnRole` values disagree.

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

`data.fields` lists every failing pointer with its rule, up to 50. Rules named after JSON Schema keywords (`type`, `required`, `enum`, `pattern`, `additionalProperties` and so on) come from the schema. `false schema` means a field that does not go with the form the value takes, such as `amount7d` beside `"unit": "share"`. The module adds `unique` (a repeated id), `null-needs-visibility-gap`, `role-needs-a-source`, `percent-range` (a percentage above 100), `usage-one-period` (shares from different periods in one document), `period-order` (a period that starts after it ends), `failed-runs-range` (a routine’s failures exceed its total runs) and `usage-other-needs-a-share` (`usageOther` with no listed share to give it a period).

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

## Moving from 0.3.0 to 0.4.0

Deploy the receiving service’s `send_report` v4 support before any kit pins ambitious-audit 0.4.0. In the service PR, run the receiver’s acceptance check against the producer’s weekly v4 payload. The producer build exports it to `dist/weekly-report.v4.json`, and `npm run verify` compares it with the output of `report build`. Service CI can also read the fixture from its pinned producer revision. [Weekly v4 payload](schemas/examples/send_report.v4/valid/weekly-activity.json)

Use collector v2 for new readings. Existing collector v1 inputs keep their canonical snapshot bytes and their snapshot IDs with the same seed and time. V1 evidence text, sources and visibility notes stay local when building a new v4 report. New reports use v4. Rebuilding a stored v1, v2 or v3 report id returns its original payload. The database schema and delivery states are unchanged.

## Earlier changes: 0.2.2 to 0.3.0

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
