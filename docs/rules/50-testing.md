---
description: Testing strategy for Klawly Claude features (unit, fake-runtime E2E, live contract, fault injection, performance)
globs: test/claude/**,src/vs/**/test/**/*claude*,src/vs/**/test/**/*Claude*
alwaysApply: false
---

# Testing rules (§52, §64–67, §87)

## Deterministic by default
- UI, integration, and E2E tests **never call live Claude**. They use `FakeClaudeRuntimeService`, which replays recorded **normalized** event fixtures from `test/claude/fixtures/*.jsonl`.
- Fixtures must cover:
  - plain answers
  - read/search cards
  - permission request (approve and deny)
  - multi-file edits
  - command failure
  - long output
  - crash mid-turn
  - unknown event types
- Use the existing Code - OSS test runners: mocha unit tests in `src/vs/**/test/`, plus the smoke/integration infrastructure that launches the real Electron app. Follow the upstream test file layout and naming.

## Unit targets (must have tests)
- Claude message normalizer
- context prompt compiler
- path permission guard
- command risk classifier
- diff/hunk mapper
- checkpoint object store
- session JSONL recovery (truncated tail)
- schema migration
- context picker ranking
- autocomplete stale-result rejection
- update manifest verification
- version comparison

## E2E cases (§64)
Cover all 21 cases, from clean first launch to update notification. Each feature adds the E2E cases it depends on.

## Live contract tests (§65)
- These form a separate, opt-in suite, run only in authorized environments. Test **contracts, not wording**:
  - init metadata
  - streaming
  - read/edit events recognized
  - permission callback fires
  - cancel
  - resume
  - `/compact`
  - skills parsed
  - normalizer survives schema changes
- Save sanitized recordings as new fixtures.

## Fault injection (§67)
Simulate each of these:
- process exits mid-write
- network drop
- concurrent user edit
- late permission rejection
- worktree creation failure
- read-only or full disk
- truncated JSONL
- crash between snapshot and write
- corrupt update or invalid signature
- old schema
- unknown SDK event

The expected result is graceful degradation.

## Performance budgets (§52)
- No more than about 50 ms of added synchronous startup work.
- No project-wide index at startup.
- Picker first results in under 100 ms.
- Streaming repaint no faster than requestAnimationFrame.
- Large output is virtualized.
- Autocomplete cancels immediately.
- Measure IDE overhead separately from model latency.

## CI
- The required suite runs on Windows, macOS, and Linux.
- A platform is not "supported" until its actual binary has run in CI or on hardware (§63).
