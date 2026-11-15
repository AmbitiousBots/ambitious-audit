---
name: verify-formal-audit
description: "Check the audit module's report delivery rules (stored at most once, no send before a required review, sent only if stored, bounded retries that always finish) against the TLA+ model, and the three payload schemas against their examples. Use when a change touches report ids, report build, report mark, the report states, retries, the routine that sends reports, or any file in spec/, schemas/ or src/domain/."
---

# Formal verification for the audit module

## What is verified

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `StoredAtMostOnce` | However often a report is sent, the service ends up with at most one stored copy. | The same report shows up twice. |
| `NoSendWithoutReview` | A report that needs a review is never sent before the review. | Data leaves the customer's computer unseen by the customer. |
| `SentOnlyIfStored` | A report is recorded as `sent` or `acked` only if the service stored it. | A lost report is reported as delivered. |
| `BoundedAttempts` | A report is sent at most `MaxAttempts` times. | A bot retries forever. |
| `RetriesConverge` | Once a send has started, the report ends up `acked`, or `failed` with no attempts left. | A report hangs unfinished. |

Tool: TLA+ with the TLC model checker, because the question is whether any order of sends, failures, retries, late arrivals and lost answers can reach a bad state. Tests only try the orders someone thought of.

Bounds: three reports and at most three calls per report, with no limit on the number of steps. `RetriesConverge` assumes the bot keeps going (it does not wait for ever on one call, retries while attempts are left, and confirms an answer it has seen); nothing is assumed about the network. `spec/README.md` lists what is left out.

The same command also checks the payload schemas in `schemas/`: every string and list is bounded, unknown fields are rejected, no schema has a field for the organisation, every valid example is accepted and every invalid example is rejected for the reason written next to it.

## The one command

From the repo root:

```sh
bash spec/check.sh && npm ci && npx tsc --noEmit && npm run check:schemas
```

`spec/check.sh` needs [mise](https://mise.jdx.dev), `curl` and Node. It installs the Java pinned in `.mise.toml`, downloads `tla2tools.jar` from the address pinned there into `~/.cache/ambitious/` and refuses it unless its SHA-256 matches the pin. It runs the model (must pass) and every variant in `spec/broken/` (each must break the rule named in `spec/broken/EXPECTED.json`). It takes under a minute and ends with a line that starts `OK:`. `npm run check:schemas` ends with `check:schemas: ok`.

## Covered code

Last confirmed in step with the code at the commit that added `deriveReportId`, `applyMark` and `nextDeliveryStep`. The model describes the design in `spec/README.md` and the types in `src/domain/types.ts`.

| Model part | Code it describes |
|---|---|
| `ReportIdFor` | `deriveReportId` in `src/domain/report.ts`: the report id comes from the snapshot, the seed and `--now`, never from the attempt |
| `Build` | `buildStoredReport` in `src/db/store.ts`; `Report` |
| `Review`, `SeeAnswer`, `Fail`, `Ack` | `markStoredReport`; `applyMark` in `src/domain/delivery.ts` |
| `ReadyToSend`, `StartSend`, `Retry` | `nextDeliveryStep`, and the routine in `skills/snapshot-routine` |
| `failures`, `MaxAttempts` | `Report.failures`, counted when a mark is `failed`; `DELIVERY_POLICY.maxAttempts` |
| `ServiceStores`, `stored` | the service's handling of `send_report`: one stored copy per report id |
| `schemas/*.json` | `src/domain/wire.generated.ts` (generated), `SendReportPayload`, `SendFeedbackPayload`, `WIRE_PATTERNS`, `WIRE_LIMITS` |

Run `git log 20bc340963802e6ff8157fe98959d96176e26083..HEAD -- src/domain src/db spec schemas scripts`. If it lists commits, read them against the table before you trust a pass. Move the commit above forward only after you have confirmed that every row still describes the code at the new commit.

One step in the model is one transaction in the code. If a mark is ever split across transactions, the model no longer describes it; model the split before relying on a pass.

## Reading a result

If your agent setup has a `/statechart` skill for TLA+ models (one that runs the checker and reports each broken rule as its shortest path in plain words, and draws the states as a chart when the model passes), read every result with it. Refer to it by name; do not copy its commands here. Without it, read TLC's output directly as follows.

When a check fails, `spec/check.sh` prints TLC's full output. Find the line `Error: Invariant <Rule> is violated.`; the rule it names is the one that broke. Below it TLC prints the shortest path to the bad state as numbered states (shortened here to one report):

```text
Error: Invariant NoSendWithoutReview is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ state = (r1 :> "absent" ...)
/\ reviewed = (r1 :> FALSE ...)
/\ reviewRequired = (r1 :> FALSE ...)
/\ requests = {}
...

State 2: <Build(r1) line 37, col 3 to line 40, col 71 of module SendSkipsReview>
/\ state = (r1 :> "built" ...)
/\ reviewed = (r1 :> FALSE ...)
/\ reviewRequired = (r1 :> TRUE ...)
/\ requests = {}
...

State 3: <StartSend(r1) line 59, col 3 to line 60, col 12 of module SendSkipsReview>
/\ state = (r1 :> "sending" ...)
/\ reviewed = (r1 :> FALSE ...)
/\ reviewRequired = (r1 :> TRUE ...)
/\ requests = {<<r1, 0>>}
...
```

Each `State N` header names the step that led to that state, and the lines under it give every variable after the step. Read down the list and compare each state with the one before: the variables that changed are what the step did. The last state breaks the rule. Write the path as one line per step before deciding anything. Here: a report is built with a review required; it is sent; no review happened.

For `RetriesConverge` the line is `Error: Temporal property RetriesConverge was violated.` (or `Temporal properties were violated.`), and the path ends with `Back to state N`: the steps from state N onward can repeat for ever without the report finishing.

To tell a path in the module's words:

- `state` is the report's state; `absent` means not built yet. `sending` means a call to the service is under way.
- `reviewRequired` and `reviewed` say whether a review is needed and whether it happened.
- `failures` counts failed calls; `calls` counts calls made.
- `requests` holds the report ids that were sent; `<<r1, 0>>` is report r1's id. A second number other than 0 means a retry used a different id.
- `stored` holds the ids the service has stored, and `answers` the ids it has answered for.

To run one model by hand and keep the output, from the repo root:

```sh
(cd spec/broken && mise exec -- java -cp ~/.cache/ambitious/tla2tools-*.jar tlc2.TLC -workers 1 -metadir "$(mktemp -d)" -noGenerateSpecTE -config SendSkipsReview.cfg SendSkipsReview.tla)
```

When the model passes, the `PASS` line gives the number of distinct states TLC checked. `spec/check.sh` fails if that number is too small for the model to be exploring anything.

A `FAIL:` line from `npm run check:schemas` names the schema, the place in it and what to fix.

## Real bug or modeling error

1. Replay the path against the real code, one command or call per step, as a test. If the code does the same, it is a real bug: report it with the path. Do not weaken the rule, and do not change product code unless asked.
2. If the code cannot take one of the steps, the model allows something the code forbids. Find the guard in the code, add it to the model, and say so in the pull request.
3. If a broken variant stops failing, or breaks a different rule, the model changed so that the rule can no longer catch that mistake. Treat that as a failure of the model.

## Changing things on purpose

- Change `spec/ReportDelivery.tla` first, then make the same change in each file in `spec/broken/`, keeping only its one changed line. `check.sh` fails if a variant drifts further from the model, or uses other constants.
- A new rule needs a new broken variant that breaks it, an entry in `spec/broken/EXPECTED.json` and a row in `spec/README.md`. `check.sh` fails if a rule has no variant.
- After changing a schema, run `npm run generate:wire-types`, add or adjust examples in `schemas/examples/` and their entries in `schemas/examples/EXPECTED.json`. A change that makes a valid payload invalid, or the reverse, belongs in a new schema file with a new version number, because the service reads these files from a tagged release.
- To move to another TLC build, change `TLA2TOOLS_URL` and `TLA2TOOLS_SHA256` in `.mise.toml` together.
- Run the one command, then update the commit in "Covered code".
