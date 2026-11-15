# ambitious-audit

The audit module turns what a bot can see in an account into a snapshot, diffs it against a stored baseline, applies rule-based findings and returns at most three recommendations, each citing its evidence, plus a map of what the bot could not see. A value the bot could not observe is recorded as unknown, never as zero, and no finding is made from it. It is a command-line tool with JSON in and JSON out, one SQLite file and no user interface. The bot shows results in its own pages. A report leaves the computer only when the customer has approved the tool that sends it.

The module follows the shared module contract in [ambitious-kit](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.2.1/MODULE_CONTRACT.md): one binary, a JSON envelope on stdout, one SQLite file, deterministic with `--now` and `--seed`, and no network. Version 0.2.1 uses kit 0.2.1, kept under `vendor/` so a build does not download it.

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
| `findings` | read | `{ snapshotId }` | `{ mode, findings: [{ kind, ruleId, severity, evidenceIds, summary, withheld? }] }` |
| `recommend` | read | `{ snapshotId }` | `{ mode, recommendations, withheld }` with at most 3 recommendations |
| `report build` | write | `{ snapshotId, reviewRequired }` | `{ reportId, payload, next }` |
| `report mark` | write | `{ reportId, state, at }` | `{ report, next }` |
| `feedback build` | none | `{ reportId?, text, from }` | `{ payload }` |
| `schema` | none | no | `{ input, commands, schema }`: the JSON Schema of the collector document, which is the input of `snapshot`. |
| `schema <command>` | none | no | The same for another command's input, for example `schema report mark`. `commands` lists every name that works here. |

`read` commands open the database with `mode=ro` and never create or change it. `payload` is the `send_report` document in [schemas/send_report.v2.json](schemas/send_report.v2.json). `next` tells the bot what to do with the report: wait for review, send, confirm, or stop.

A report id comes from the snapshot, `--seed` and `--now`. Building the same snapshot again with the same seed and time returns the same id and the stored payload. A report is marked `sent` at most once. When a review is required, `sent` and `failed` are refused until the report is marked `reviewed`. After 3 failed attempts the report stays failed.

`diff` with no `from` uses the latest baseline. `diff` of a snapshot with itself is an empty list. `before` or `after` is JSON `null` when that side has no value.

## What the bot could not observe

The collector document is described by [schemas/collector.v1.json](schemas/collector.v1.json); `ambitious-audit schema` prints it. A bot often cannot see everything, and the document has a way to say so for each value:

| Value | When it was not observed | Visibility signal that must then say `seen: false` |
|---|---|---|
| `account.kind` | `"unknown"` | `accountRole` |
| `tasks.open`, `tasks.stale7d`, `tasks.blocked` | `null` | `tasks` |
| `pages.count`, `pages.updated7d` | `null` | `pages` |
| `bots[].lastActiveAt` | `null` | `botActivity` |
| `bots[].routineCount`, `routines[].lastRunAt` | `null` | `routines` |
| `bots[].usage`, `routines[].usage` | `null` | `usage` |

`null` means not observed. It never means zero, and the module never turns it into zero. `snapshot` refuses a document in which a value is `null` while its signal says `seen: true`, so every gap shows up in the visibility map, in the findings and in the report. `lastActiveAt` and `lastRunAt` take the word `"never"` when the account shows that the thing has not happened yet, which is different from not knowing.

Task counts come from the output of the ambitious-tasks module, which keeps the bot's task list. When that module is not installed, or its output was not read, all three counts are `null`.

Usage is `{ "unit": "credits" | "percent", "amount7d": number }` for the 7 days before `collectedAt`, or `null`. Use `percent` when the account reports each bot's share of the total rather than credits. The `usage` signal counts as seen only when usage was observed for every listed bot and every listed routine, in either unit.

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
| `paused-routine` | A routine is paused, and its last run is `"never"` or more than 7 days before the snapshot. | yes |
| `bot-unused` | A bot's last activity is `"never"` or more than 14 days before the snapshot. | yes |
| `stale-tasks` | The count of tasks with no change in 7 days is greater than the threshold in the rule file. | no |
| `duplicate-routines` | Two routines on the same bot share a schedule. | yes |

A rule never fires on a value that is `null`. A paused routine whose last run was not observed, a bot whose last activity was not observed, and task counts that were not observed produce no rule finding. Connector statuses `ok`, `initializing` and `error` produce no finding. `dependsOnRole` in a rule file says whether its recommendation is withheld when the role is unknown. A rule that fires on a connector status cites only evidence whose `source` is the name of one of this bot's connectors, so it must have `dependsOnRole: false`. Those rules are listed by id in `OWN_CONNECTOR_RULE_IDS` in `src/domain/rule-pack.ts`, and the module refuses to start when that list, the rule files and the `dependsOnRole` values disagree.

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

`data.fields` lists every failing pointer with its rule, up to 50. Rules named after JSON Schema keywords (`type`, `required`, `enum`, `pattern`, `additionalProperties` and so on) come from the schema. The module adds `unique` (a repeated id), `null-needs-visibility-gap`, `role-needs-a-source` and `percent-range` (a percentage above 100).

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

## Moving from 0.2.0

- When the role is unknown, `connector-needs-auth` and `connector-needs-grant` are no longer withheld: `recommend` and `report build` return their recommendations, their findings carry no `withheld` mark, and `recommend` no longer lists them in `withheld`. Before, a bot that did not know its role found connectors that needed a sign-in and gave no advice about them. Nothing changes when the role is known.
- A connector recommendation needs an evidence line whose `source` is the connector's name, as every recommendation does. A collector that wrote no such line still gets the finding and no recommendation.
- No schema changes shape. A collector document accepted by 0.2.0 is accepted by 0.2.1, stored snapshots and reports are read as they are, and the report payload is still version 2. One description in the collector schema now mentions the connector advice.

## Moving from 0.1.0

- Collector documents change shape: `usage` is `{ unit, amount7d }` or `null` instead of `{ credits7d }`, routines carry `usage`, and `visibility` has nine entries. `null` in `lastActiveAt` or `lastRunAt` now means not observed; write `"never"` for something that has not happened. A snapshot stored by 0.1.0 is refused with `E_SNAPSHOT_FORMAT`; collect again.
- `report build` returns a version 2 payload ([schemas/send_report.v2.json](schemas/send_report.v2.json)). It adds `accountKind`, a `kind` on each finding, an optional `withheld` mark, an optional evidence `source`, nullable task and page counts, `needsGrant` and `initializing` connector counts, and the nine-signal visibility map. [schemas/send_report.v1.json](schemas/send_report.v1.json) is kept unchanged for receivers that still hold version 1 reports, and a report built by 0.1.0 is returned as it was stored.
- `findings` now also returns one finding of kind `visibility` for each signal that was not seen.

## Checks

```text
npm ci
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
