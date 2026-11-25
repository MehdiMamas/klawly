# Contributing to Klawly

Thanks for helping. Klawly is a fork of Code - OSS with Claude Code built in; the spec is [KLAWLY_MASTER_PLAN.md](KLAWLY_MASTER_PLAN.md) and the working rules are in [AGENTS.md](AGENTS.md) and `docs/rules/`.

## Before you start

- Search [issues](https://github.com/MehdiMamas/klawly-ide/issues) first. For anything bigger than a small fix, open an issue and agree on the approach before writing code.
- Klawly's own code lives in `src/vs/platform/claude/**`, `src/vs/workbench/services/claude/**` and the `claude` workbench contributions. Edits to other (upstream) files stay small and are listed in [UPSTREAM.md](UPSTREAM.md).

## Build and test

Node `24.18.0`, then:

```bash
npm install
npm run watch                         # then ./scripts/code.sh
npm run test-node -- --run <file>     # node unit tests
./scripts/test.sh --run <file>        # browser/electron unit tests
npm run eslint -- <changed files>
npm run precommit
```

## Pull requests

- Branch from `main`, keep the change focused, and add or update tests for behavior you change.
- Run `npm run precommit` before pushing; CI runs the same checks.
- User-visible strings say "Klawly" and are localized with `vs/nls`. `npm run check-names` enforces this.
- Describe what changed and why. Link the issue (`Fixes #123`).

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE.txt).
