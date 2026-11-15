# ambitious-audit

The audit module turns what a bot can see in an account into a snapshot, diffs it against a stored baseline, applies rule-based findings and returns at most three recommendations, each citing its evidence, plus a map of what the bot could not see. It is a command-line tool with JSON in and JSON out, one SQLite file and no user interface. The bot shows results in its own pages. A report leaves the computer only when the customer has approved the tool that sends it.

The module follows the shared module contract in [ambitious-kit](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.1.0/MODULE_CONTRACT.md): one binary, a JSON envelope on stdout, one SQLite file, deterministic with `--now` and `--seed`, and no network. Version 0.1.0 uses kit 0.1.0, kept under `vendor/` so a build does not download it.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

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
| `findings` | read | `{ snapshotId }` | `{ findings: [{ ruleId, severity, evidenceIds, summary }] }` |
| `recommend` | read | `{ snapshotId }` | `{ recommendations }` with at most 3 items |
| `report build` | write | `{ snapshotId, reviewRequired }` | `{ reportId, payload, next }` |
| `report mark` | write | `{ reportId, state, at }` | `{ report, next }` |
| `feedback build` | none | `{ reportId?, text, from }` | `{ payload }` |

`read` commands open the database with `mode=ro` and never create or change it. `payload` is the `send_report` document in [schemas/send_report.v1.json](schemas/send_report.v1.json). `next` tells the bot what to do with the report: wait for review, send, confirm, or stop.

A report id comes from the snapshot, `--seed` and `--now`. Building the same snapshot again with the same seed and time returns the same id and the stored payload. A report is marked `sent` at most once. When a review is required, `sent` and `failed` are refused until the report is marked `reviewed`. After 3 failed attempts the report stays failed.

`diff` with no `from` uses the latest baseline. `diff` of a snapshot with itself is an empty list. `before` or `after` is JSON `null` when that side has no value.

## Rules

Rules live in `rules/*.json`. Each one has a positive fixture and a negative fixture.

| Rule | Fires when |
|---|---|
| `failing-routine` | A routine's state is `failing`. |
| `connector-needs-auth` | A connector's status is `needsAuth`. |
| `paused-routine` | A routine has been paused, and its last run is missing or more than 7 days before the snapshot. |
| `bot-unused` | A bot's last activity is missing or more than 14 days before the snapshot. |
| `stale-tasks` | The count of tasks with no change in 7 days is greater than the threshold in the rule file. |
| `duplicate-routines` | Two routines on the same bot share a schedule. |

Ages are measured from the snapshot's `collectedAt`, not from the clock. A recommendation is kept only when it cites at least one evidence id present in the snapshot. A recommendation whose fingerprint was marked `sent` is dropped for the number of days in `rules/settings.json` (21 by default).

## Data

The database is `$AMBITIOUS_HOME/audit/audit.sqlite`, or the file given by `--db`. `AMBITIOUS_HOME` defaults to the directory the contract names. `PRAGMA user_version` is the number of migrations in `migrations/`.

## Errors

Shared codes (`E_USAGE`, `E_INPUT_SCHEMA`, `E_FORBIDDEN_PATH`, `E_NO_KEY`, `E_DB`, `E_MIGRATION`, `E_INTERNAL`) are defined by the module contract. This module adds:

| Code | Exit | Meaning | Typical hint |
|---|---|---|---|
| `E_NOT_FOUND` | 1 | No snapshot or baseline has the given id. | Run `snapshot` or `baseline set` and use the id it returns. |
| `E_NO_BASELINE` | 1 | `diff` was given no `from` and no baseline is stored. | Run `baseline set`, or pass `from`. |
| `E_REPORT_NOT_FOUND` | 1 | No report has the given id. | Run `report build` and use the `reportId` it returns. |
| `E_TRANSITION` | 1 | The report cannot move from its current state to the requested one. | Mark it with a state this report can move to. |
| `E_REVIEW_REQUIRED` | 1 | A report that must be reviewed was marked `sent` or `failed` first. | Mark it `reviewed`, then mark the outcome. |
| `E_ATTEMPTS_EXHAUSTED` | 1 | The report has already failed the maximum number of times. | Leave it failed. Build a new report when there is something new to send. |

Detail such as the states in a refused transition is in `data`, not in the error object.

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
