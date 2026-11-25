---
description: Feature parity rule — after every upstream merge, list the new and changed Copilot, Agents-window and editor-AI features and record a decision for each in FEATURES.md section 6
globs: src/vs/workbench/contrib/chat/**,src/vs/sessions/**,src/vs/platform/agentHost/**,FEATURES.md,UPSTREAM.md,.github/upstream-watch.mjs
alwaysApply: false
---

# Feature parity (`FEATURES.md` section 6)

Each Code - OSS release brings new Copilot, Agents-window and editor-AI features. Klawly hides upstream chat (`chat.disableAIFeatures`), so nothing shows them to us unless we look. Section 6 of `FEATURES.md`, "VS Code Copilot vs Klawly", records every upstream feature we looked at and what we decided. Rule 37 does the same for design.

## After every upstream merge
1. **List what is new.** Diff the old and the new upstream snapshot (the commits in `UPSTREAM.md`) under `src/vs/workbench/contrib/chat/**`, `src/vs/sessions/**` and `src/vs/platform/agentHost/**`: new contributions and services (`git diff --name-only --diff-filter=A <old> <new> -- <paths>`), new and changed settings (`registerConfiguration` blocks), new component fixtures, and changed user-visible strings. Skim names and localized strings; don't read everything. Group files that make one feature into one row.
2. **Decide each feature.** One of:
   - **Port**: Klawly should have it for Claude. Open an issue with a design (goal, design, acceptance), like the Sprint 8 issues, and put its number in the row.
   - **Covered**: Klawly already does it. Name the Klawly feature (its row in section 2).
   - **Wait**: worth having, but not now (experimental upstream, behind a setting, or small). Say what would make it a Port.
   - **Skip**: Klawly will not have it. Give the reason, for example "Copilot-only service", "Codex-only", "telemetry", "upstream branding".
3. **Record it.** Add the rows to section 6 under a heading for the release (`### 1.142`), and update rows from earlier releases whose decision changed (a Wait that became a Port, a Port whose issue shipped).
4. **Say it in the merge pull request.** Its description has a "Feature parity" section next to "Design practices" (rule 37): how many features were listed, the Port issues opened, and anything left undecided.

## Also at each merge
- Run the merge guard: `npm run test-node -- --run src/vs/platform/claude/test/node/claudeAgentHostGuard.test.ts`. It fails if the merge brought back the Copilot or Codex agent registration in `agentHostMain.ts`/`agentHostServerMain.ts` or `ClaudeProxyService` in `agentHostServices.ts`; take upstream's other changes and re-apply Klawly's lines (issue 619).
- Re-check the Claude Code column (section 3) against the installed `claude --version` and `claude --help`, and keep section 4 to Klawly's own choices. Write down the version and date you checked, and say which columns you did not re-check.

## Never
- Never port by routing Claude through Copilot services (CAPI, Copilot sign-in, the agent host's Claude-to-CAPI proxy). Claude runs on the user's own account through Claude Code; upstream code is a reference for behavior only.
- Never leave a listed feature without a decision, or a Skip without its reason.
- Never mark a feature Covered without naming the Klawly feature that covers it.
