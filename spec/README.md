# Formal model of report delivery

The audit module builds a report, and the bot that runs the module sends it to the monitoring service. Networks fail, so the bot retries. This folder holds a small model of that exchange and checks, for every order in which the steps can happen, that the rules below are never broken. It was written before the delivery code, so the code is written against rules that are already checked.

Run it from the repo root:

```sh
bash spec/check.sh
```

The script needs [mise](https://mise.jdx.dev) (it installs the pinned Java), `curl` and Node. It downloads TLC, the model checker for the TLA+ language, as `tla2tools.jar` from the address pinned in `.mise.toml`, keeps it in `~/.cache/ambitious/` and refuses a file whose SHA-256 differs from the pin. A run takes under a minute.

## `ReportDelivery.tla`: the model

Three reports, each allowed at most three calls to the service. For each report the model follows the module's record of it and what the service has stored.

A report moves through these states:

```text
built -> (reviewed, when a review is required) -> sending -> sent -> acked
                                                    |
                                                  failed -> retry -> sending
```

| Step in the model | What it stands for |
|---|---|
| `Build` | `report build`: the report is stored as `built`, with or without a required review. |
| `Review` | `report mark` with state `reviewed`: the customer has looked at the report. |
| `StartSend`, `Retry` | The bot calls the service's `send_report` tool with the payload. `Retry` is the same call after a failure. |
| `ServiceStores` | The service receives a call and stores the report under its report id. A call can arrive late, more than once, or never. |
| `SeeAnswer` | The service's answer reaches the bot; `report mark` with state `sent`. |
| `Fail` | The call fails or times out; `report mark` with state `failed`. An answer can be lost, so this can happen even when the service stored the report. |
| `Ack` | The bot confirms the answer names this report; `report mark` with state `acked`. |

`sending` is the time between the call and its outcome. The module does not store it: its record stays `built`, `reviewed` or `failed` until the bot marks the outcome.

The rules, checked in every reachable state (about 205,000 distinct states):

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `StoredAtMostOnce` | However often a report is sent, the service ends up with at most one stored copy of it. | The customer and the reviewer see the same report twice, and counts are wrong. |
| `NoSendWithoutReview` | A report that needs a review is never sent to the service before the review happened. | Data leaves the customer's computer that the customer has not seen. |
| `SentOnlyIfStored` | A report is recorded as `sent` or `acked` only if the service really stored it. | The customer is told a report was delivered when it was lost. |
| `BoundedAttempts` | A report is sent at most `MaxAttempts` times. | A bot retries forever. |
| `RetriesConverge` | Once a send has started, the report always ends up `acked`, or `failed` with no attempts left. It never stays in between for ever. | A report hangs in an unfinished state and nobody is told. |

`TypeOK` is also checked: every value stays in its allowed set.

`RetriesConverge` is a rule about what must eventually happen, so it needs assumptions about what keeps moving ("fairness"): the bot does not wait for ever on a call (it sees the answer or gives up on that call), it retries a failed report while attempts are left, and it confirms an answer it has seen. Nothing is assumed about the network or the service: every call may be lost.

How the model keeps `StoredAtMostOnce`: the report id is a function of the report alone (`ReportIdFor`), never of the attempt, and the service keeps one copy per id. In the code the id is derived from the snapshot and the seed, so building the same report again gives the same id.

## `broken/`: showing that each rule can fail

Each file in `spec/broken/` is the model with one line changed to a plausible mistake. `check.sh` requires each to break the rule listed for it in `broken/EXPECTED.json`, to use the same constants as the model, and to differ from the model in that one place only. It also requires every rule in `ReportDelivery.cfg` to have a variant that breaks it.

| Variant | The mistake | Rule it must break |
|---|---|---|
| `RetryWithNewReportId` | A retry makes a new report id instead of reusing the first one. | `StoredAtMostOnce` |
| `SendSkipsReview` | A built report is sent without checking whether a review is required. | `NoSendWithoutReview` |
| `TimeoutCountsAsSent` | A report is marked `sent` without an answer from the service. | `SentOnlyIfStored` |
| `FailureNotCounted` | A failed call is not counted, so the limit is never reached. | `BoundedAttempts`, and `RetriesConverge` |

`EXPECTED.json` has one entry per variant: `{ "<variant>": { "invariant": "<rule>", "because": "<plain sentence>" } }`. This is the shape the shared runner in [ambitious-kit](https://github.com/AmbitiousBots/ambitious-kit) reads, so that runner can replace `check.sh` without changes here. An entry may also name a `property`: `check.sh` then runs the variant a second time against that one eventual rule and requires it to break too. That is how `RetriesConverge` is shown able to fail.

## Which code this constrains

| Code | Constrained by |
|---|---|
| `deriveReportId` in `src/domain/report.ts`: the report id from the snapshot, the seed and `--now`, never from the attempt | `StoredAtMostOnce` |
| `applyMark` in `src/domain/delivery.ts`: which `report mark` changes are accepted | `NoSendWithoutReview`, `SentOnlyIfStored`, `BoundedAttempts` |
| `nextDeliveryStep` in `src/domain/delivery.ts`: what the bot is told to do next | `NoSendWithoutReview`, `BoundedAttempts`, `RetriesConverge` |
| `buildStoredReport` and `markStoredReport` in `src/db/store.ts`: one transaction per build or mark | all five, for the module's own record |
| the routine in `skills/snapshot-routine` that calls the service and marks the outcome | all five |
| the service's handling of `send_report` (in the service's own repository) | `StoredAtMostOnce`: one stored copy per report id |

The module has no network access, so it cannot stop a bot from calling the service. It enforces the rules through what it accepts and what it answers: `NextDeliveryStep` says `waitForReview` until a required review is marked, and `ApplyMark` refuses `sent` or `failed` for a report whose required review is missing, and refuses another attempt after `maxAttempts` failures.

## What is not covered

- The model checks the design, not the TypeScript. Tests must tie the code to it: a property test that drives `ApplyMark` and `NextDeliveryStep` with random step orders and checks the same five rules.
- A report that is `failed` with no attempts left can still have been stored by the service, because the answer was lost. The rules allow this: the stored copy is the same report under the same id. A later manual resend is safe for the same reason.
- A required review that never happens leaves the report `built`. `RetriesConverge` starts from the first send, not from the build, because nothing can make a person review.
- The content of the payload is not modeled. The schemas in `schemas/` bound it. That a retry sends the same payload is for the code to keep, using the stored `payload_sha256`.
- Subscription, credentials and the approval the customer gives before a tool call are not modeled; a refused call is a `Fail`.
- Crashes in the middle of a write are not modeled; each step is one transaction.
