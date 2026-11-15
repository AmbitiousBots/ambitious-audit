# ambitious-audit

The audit module turns what an Ambitious Bot can see in a Grok Bot account into a snapshot, diffs it against a stored baseline, applies rule-based findings and returns at most three recommendations, each citing its evidence, plus a map of what it could not see. It is a command-line tool with JSON in and JSON out, one SQLite file and no UI; the bot shows results in Grok Bot Pages and sends report summaries only through the Ambitious MCP endpoint with the customer's tool approval.

The module follows the shared module contract, [MODULE_CONTRACT.md](https://github.com/AmbitiousBots/ambitious-kit/blob/main/MODULE_CONTRACT.md) in ambitious-kit: one command-line binary, JSON in and a JSON envelope out, one SQLite file, deterministic with `--now` and `--seed`, no network except keyed AI calls.

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
