---
description: Tiered testing - what runs locally, what runs on the self-hosted runners and when, picked from the changed paths
globs: .github/workflows/**,build/klawly/test-tier.ts,build/klawly/batch-check.ts,.batch-gate.json
alwaysApply: true
---

# Tiered testing

The self-hosted `heavy` runners (two Windows PCs and the Macs) take one job at a time. A run per commit queued a dozen runs at once and kept every other job waiting, so tests are tiered by the size and risk of the change, and the tier comes from a script, never from feel.

## Pick the tier

```
node build/klawly/test-tier.ts              # the branch against origin/main
node build/klawly/test-tier.ts --working    # also uncommitted files, while you work
node build/klawly/test-tier.ts --dispatch   # start the one runner pass for this tier
```

It prints the tier, why, and the node and Electron test files that cover the change: each test that imports a changed file (directly or through a test helper), else the test of the same name, else the tests in the nearest test folder. Files no test covers are listed too; add a test or say so in the PR. The script's unit tests: `node --test build/klawly/test/test-tier.test.ts`.

| Tier | When | What runs | Where |
|---|---|---|---|
| 0 | Every edit, and docs-only changes | Lint of the changed files (`npx eslint <files>`), the watch task's or editor's type errors for them, and the listed tests (`npm run test-node -- --run <file>`, `scripts/test.sh --run <file>`) | Locally, no runner |
| 1 | A small fix: at most 5 source files (tests don't count) in one area, no risky path | The listed tests, plus `npm run typecheck-client` | One heavy-tests job, one OS (`--os any` takes the first free runner) |
| 2 | A normal PR, or any risky path however small | The listed tests on each OS, plus `npm run typecheck-client` once | heavy-tests on each OS in `HEAVY_TEST_OSES`, once when the PR is ready |
| 3 | Before a release or at the end of a sprint (`--release`) | Typecheck and the full node and Electron suites; packaging, e2e and visual checks come from `package.yml` and the redesign shots | heavy-tests on each OS in `HEAVY_TEST_OSES`, plus the release workflows |

Tiers 2 and 3 run on the OSes in the repo variable `HEAVY_TEST_OSES` (default `["Windows", "macOS"]`). While the Mac runners are off it is `["Windows"]`; deleting the variable (`gh variable delete HEAVY_TEST_OSES -R MehdiMamas/klawly-ide`) restores the default, both Windows and macOS.

Risky paths are the one list `RISKY_PATHS` in the script: lock files, package manifests, `.npmrc` and `.nvmrc`; `build/`, `scripts/`, `test/` and configs; `.github/`; shared core (`src/vs/base`, the workbench and platform services every part loads, the normalized Claude protocol); public API (`vscode-dts`, `workbench/api`); security (secrets, sandbox, permissions, the Claude host process). Add a path there when a change to it can break more than the tests next to it.

## Every merge goes through the train
- A PR reaches `main` only through the merge train: label it `ready-batch` and let `batch_gate` test it in a batch, then merge it. Never merge directly after only the light PR check (#1541): `main` went red twice on 2026-10-19 that way.
- The PR check (`workflow-check.yml`) has a second job, "Unit tests beside the changed files": it runs the tests `test-tier.ts` lists for the PR's merge result on one OS (Windows), nothing else. It catches a test broken beside its own files (a pane test missing the stub of a newly injected service) before the batch.
- `.batch-gate.json` sets `parallel` to 4: two batches per OS pair, matching the two Windows and two Mac heavy runners. heavy-tests is keyed per ref (`heavy-tests-<ref>`), so parallel batches do not cancel each other.

## Runner use
- Lanes run Tier 0 only, label the PR `ready-batch` and move on. The heavy work is one batch run: session-manager's `batch_gate` merges the labeled PRs (at most `maxBatch`, after the `debounceMinutes` quiet time, see `.batch-gate.json`) onto a staging branch and runs `BATCH_PRS=<n,...> node build/klawly/batch-check.ts` there. It compiles once, typechecks fully, runs the affected tests (picked by `test-tier.ts`), `npm run design-sync` and `check-names`, and takes screenshots once when a PR touches UI. It writes `batch-result.json` (per-PR notes and screenshots, per-step log tails) and exits 0 only when all passed; a failure is tied to the PRs whose files it names, otherwise to every PR in the batch. `--dispatch` starts at most one heavy-tests run after a green batch.
- Run Tier 0 locally before every commit. Nothing goes to a runner per commit.
- Dispatch at most one heavy-tests run per PR, when it is ready, with `--dispatch` (it refuses Tier 0 and an unpushed branch). Tiers 2 and 3 run each OS from that one dispatch.
- One run per branch at a time: a new heavy-tests run for the same ref cancels the queued or running one.
- A failure is fixed locally, then only the failing files are rerun: `gh workflow run heavy-tests.yml -f ref=<branch> -f tier=1 -f electron-tests="<file>"` (the run names the failing files in its error).
- The runner reinstalls node_modules only when a lock file, package manifest, `.npmrc`, `.nvmrc` or the Node version changed (`build/npm/installStateHash.ts`); `-f reinstall=true` forces it.
- Background and short jobs never use the test runners: feedback triage, the upstream-watch fallback and the dependency scan run on runners labeled `light`. Each machine has one `light` runner beside its `heavy` one, added in the gh-runners dashboard (Add runner, tick `light`). A new background job goes on `light` too, or gets a label of its own if it is long.

## Working ahead of the queue (issue 1530)

- `node build/klawly/integration-queue.ts` builds `integration/queue` = origin/main plus every open `ready-batch` PR (number order; conflicting PRs are skipped and listed with their files) and force-pushes only that branch. Rerun it whenever the queue changes.
- Start follow-on work (design-sync sweep, upstream merge, release notes) with `git worktree add .worktrees/<name> -b <name> origin/integration/queue`. Never open a PR against `integration/queue`; target main.
- When queued PRs merge, rebase your branch: `git rebase --onto origin/main <old integration/queue sha you branched from> <name>`. Squash merges rewrite commits, so `--onto` with the old base drops the already-merged ones.
