# Decision records

One file per architecture decision: the question, what was measured, the decision and its reasons. A record is not edited after it is accepted; a later decision that replaces it gets a new number and links back.

| Record | Decision | Status |
|---|---|---|
| [0001 Agent Host harness](0001-agent-host-harness.md) | Adopt upstream's Agent Host Claude harness for the Agents window only, on native transport; the main window's Agent pane stays on Klawly's runtime | Proposed (issue 423) |
| [0002 Instant Grep](0002-instant-grep.md) | No local search index for now: Claude Code's ripgrep answers Claude's real searches in 0.03 s at the median and under 1.6 s on a whole 31,000-file repository; re-open if replayed searches take over 2 s at p90 | Accepted (issue 498) |
