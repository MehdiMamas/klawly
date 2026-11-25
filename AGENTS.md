# Klawly

A desktop IDE: a fork of Code - OSS (upstream 1.141.0) with Claude built into the product. The agent is native to the workbench, not an extension, webview or terminal.

Upstream VS Code agent guidance (architecture, coding guidelines, validation): `.github/copilot-instructions.md`.

## Read in this order
1. This file.
2. `graphify-out/GRAPH_REPORT.md`, if it exists. Find code with `graphify query "<question>"`.
3. Targeted reads of the files you will change. Do not read the whole repo first.

## Map
- Spec: `KLAWLY_MASTER_PLAN.md` (rules cite it as §N). Features: `FEATURES.md`; after an upstream merge, decide each new Copilot feature in its section 6 (rule 38).
- Code: Klawly code is in `src/vs/platform/claude/**` and `src/vs/workbench/services/claude/**` plus the workbench contributions; everything else is upstream Code - OSS. Edits to upstream files stay small and are listed in `UPSTREAM.md`.
- Rules: `docs/rules/*.md` (binding).
- UI: never copy another product's markup, CSS, icons or wording. Claude Code models, efforts and concepts only.
- Design: `design/` is a static HTML/CSS prototype of every screen, labeled by owner (Klawly or VS Code) and by what the app really does. Start with `design/README.md`, `design/PRACTICES.md` and `design/DECISIONS.md`; rule 36 binds.
- Design language: `design/LANGUAGE.md` lists every design practice (`DL-NN`) with its reason, and how to carry them to VS Code surfaces after an upstream merge. Cite the ID in code; add a practice when none covers your decision. Rule 37 binds.
- Services outside this repo: the relay (Send Feedback and the alpha update feed) is a separate service.
- History: the old phase plans, progress log, gates and handoffs are archived in `docs/archive/phasing/`. Read them only for background; they no longer drive the work.

## Commands
- Build: `npm install`, then `npm run compile` (or `npm run watch`); run with `./scripts/code.sh`.
- Test: `npm run test-node -- --run <file>` (node unit tests), `./scripts/test.sh --run <file>`.
- Lint: `npm run eslint` and `npm run precommit`.

## Must hold
- Parallel work goes in `.worktrees/<branch>`; the main checkout stays on `main`. Never `git stash`.
- Proof that something works is a command and its result, with the OS that ran it. The graph is for orientation, never proof.
- UI never imports the Agent SDK or `child_process` and never reads credential files; keep the Claude protocol normalized.
- Testing is tiered (rule 55): run Tier 0 locally on every edit; `node build/klawly/test-tier.ts` picks the tier, and `--dispatch` starts at most one heavy-tests run per PR when it is ready, never per commit. Lanes stop at Tier 0, label the PR `ready-batch` and move on; `build/klawly/batch-check.ts` does the heavy work once per batch. To build on queued PRs before they merge, run `node build/klawly/integration-queue.ts` and branch from `origin/integration/queue` (rule 55).
- A UI change keeps `design/` true: run `npm run design-sync` and clear what `design/STALE.md` lists (rule 36).
- Talk about Klawly. Klawly's files never name another AI editor; `npm run check-names` (part of `npm run precommit`) enforces it. "cursor" meaning the text cursor is fine.
