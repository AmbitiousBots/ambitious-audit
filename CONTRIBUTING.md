# Contributing

Thanks for helping with ambitious-audit. The module is a command-line tool: it stores a snapshot of what a bot can see, compares that with a baseline, and returns a short list of things worth doing, each tied to evidence. It is not tied to one industry. A report leaves the computer only when the person who runs the bot has approved the tool that sends it.

This repository is open source under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). By contributing, you agree that your contribution is licensed under those terms.

## Set up

Install [mise](https://mise.jdx.dev), then from a checkout of this repository:

```sh
mise trust
mise install
npm ci
```

mise installs the Java and Node versions named in `.mise.toml`. Do not commit a dependency that needs a different Node version.

The kit libraries live in `vendor/`. A build does not download them. To move to a newer kit release, download that release's tarballs, check them against the release `SHA256SUMS`, replace the files in `vendor/`, and regenerate the lockfile with `npm install` so `npm ci` matches the new archives.

## Checks

Run these before you open a pull request:

```sh
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

`npm test` builds `dist/ambitious-audit.mjs` and runs the tests. `npm run tlc` checks the report-delivery model in `spec/`. `npm run verify` runs the features in `verify/features.json`. `npm run lint` also checks that the repository does not contain an internal plan id or a path from one person's machine.

## Pull requests

Open an issue or a pull request. Describe the change in plain language: why it is needed, what is different for someone using the tool, and the check output that shows it works. If you chose something without asking, say what you chose and why.

Keep reports, fixtures, and examples free of secrets, tokens, and private account data. Use the examples under `schemas/examples/` and `test/fixtures/` as the pattern.

## Code of conduct

Be decent to the people you work with. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). To report a vulnerability, follow [SECURITY.md](SECURITY.md) and do not open a public issue for it.
